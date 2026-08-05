use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    collections::VecDeque,
    env,
    fs::{self, create_dir_all, remove_dir_all, rename, File},
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use reqwest::Client;
use tauri::{AppHandle, Manager, State};
use zip::ZipArchive;

const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:8787";
const DEFAULT_PORT: &str = "8787";

pub struct ServiceState {
    pub child: Mutex<Option<Child>>,
    pub child_pid: AtomicU32,
    pub started_by_us: AtomicBool,
    pub allow_close: AtomicBool,
    pub starting: AtomicBool,
    pub service_url: Mutex<Option<String>>,
    marker_path: Mutex<Option<PathBuf>>,
    output: Arc<Mutex<VecDeque<String>>>,
}

impl Default for ServiceState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            child_pid: AtomicU32::new(0),
            started_by_us: AtomicBool::new(false),
            allow_close: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            service_url: Mutex::new(None),
            marker_path: Mutex::new(None),
            output: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartServiceResult {
    pub started: bool,
    pub started_by_us: bool,
    pub url: Option<String>,
    pub token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatusResult {
    pub running: bool,
    pub started_by_us: bool,
    pub pid: Option<u32>,
    pub url: Option<String>,
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    process_id: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceMarker {
    pid: u32,
    url: String,
}

struct PreparedServer {
    binary: PathBuf,
    resource: PathBuf,
    runtime_dir: PathBuf,
    native_modules: PathBuf,
}

struct SpawnedServer {
    child: Child,
}

fn marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("piui-service.json"))
}

fn remember_marker_path(app: &AppHandle, state: &ServiceState) -> Result<PathBuf, String> {
    let path = marker_path(app)?;
    *state
        .marker_path
        .lock()
        .map_err(|error| error.to_string())? = Some(path.clone());
    Ok(path)
}

fn persist_service_marker(
    app: &AppHandle,
    state: &ServiceState,
    pid: u32,
    url: &str,
) -> Result<(), String> {
    let path = remember_marker_path(app, state)?;
    if let Some(parent) = path.parent() {
        create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let marker = ServiceMarker {
        pid,
        url: url.to_string(),
    };
    let bytes = serde_json::to_vec_pretty(&marker).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn clear_service_marker(state: &ServiceState) {
    let path = state.marker_path.lock().ok().and_then(|path| path.clone());
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

fn read_service_marker(app: &AppHandle, state: &ServiceState) -> Option<ServiceMarker> {
    let path = remember_marker_path(app, state).ok()?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn service_environment(
    runtime_dir: Option<&PathBuf>,
    native_modules: Option<&PathBuf>,
) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::from([
        ("PIUI_HOST".to_string(), "127.0.0.1".to_string()),
        ("PIUI_PORT".to_string(), DEFAULT_PORT.to_string()),
        ("PIUI_DRIVER".to_string(), "pi".to_string()),
    ]);
    if let Some(path) = runtime_dir {
        environment.insert("PIUI_RUNTIME_DIR".to_string(), path.display().to_string());
    }
    if let Some(path) = native_modules {
        environment.insert(
            "PIUI_NATIVE_MODULES".to_string(),
            path.display().to_string(),
        );
    }
    environment
}

fn resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    if base.join("piui-runtime.zip").is_file() || base.join("piui-server.exe").is_file() {
        return Ok(base);
    }
    let nested = base.join("resources");
    if nested.join("piui-runtime.zip").is_file() || nested.join("piui-server.exe").is_file() {
        return Ok(nested);
    }
    Ok(base)
}

fn server_binary(app: &AppHandle, resource: &PathBuf) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("PIUI_SERVER_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let names = if cfg!(target_os = "windows") {
        ["piui-server.exe", "piui-server"]
    } else {
        ["piui-server", "piui-server.exe"]
    };
    names
        .iter()
        .map(|name| resource.join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "PiUI server binary was not bundled in {}",
                app.path()
                    .resource_dir()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|_| "the resource directory".to_string())
            )
        })
}

fn unpack_runtime(app: &AppHandle, resource: &PathBuf) -> Result<(PathBuf, PathBuf), String> {
    let archive_path = resource.join("piui-runtime.zip");
    let version_path = resource.join("piui-runtime.version");
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let version = fs::read_to_string(&version_path).unwrap_or_else(|_| "unknown".to_string());
    let marker = data_dir.join("piui-runtime.version");
    let runtime_dir = data_dir.join("runtime");
    let native_dir = data_dir.join("node_modules");
    let partial_json = runtime_dir
        .join("pi")
        .join("node_modules")
        .join("@earendil-works")
        .join("pi-coding-agent")
        .join("node_modules")
        .join("partial-json")
        .join("package.json");

    if marker.exists()
        && fs::read_to_string(&marker).ok().as_deref() == Some(version.trim())
        && runtime_dir.join("current.json").is_file()
        && native_dir.is_dir()
        && partial_json.is_file()
    {
        return Ok((runtime_dir, native_dir));
    }

    create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let staging = data_dir.join(".piui-runtime-staging");
    if staging.exists() {
        remove_dir_all(&staging).map_err(|error| error.to_string())?;
    }
    create_dir_all(&staging).map_err(|error| error.to_string())?;

    let archive = File::open(&archive_path)
        .map_err(|error| format!("failed to open bundled Pi runtime: {error}"))?;
    let mut archive = ZipArchive::new(archive).map_err(|error| error.to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(relative) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            return Err("Pi runtime archive contains an unsafe path".to_string());
        };
        let destination = staging.join(relative);
        if entry.is_dir() {
            create_dir_all(&destination).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = File::create(&destination).map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        std::io::Write::write_all(&mut output, &bytes).map_err(|error| error.to_string())?;
    }

    if runtime_dir.exists() {
        remove_dir_all(&runtime_dir).map_err(|error| error.to_string())?;
    }
    if native_dir.exists() {
        remove_dir_all(&native_dir).map_err(|error| error.to_string())?;
    }
    rename(staging.join("runtime"), &runtime_dir).map_err(|error| error.to_string())?;
    rename(staging.join("node_modules"), &native_dir).map_err(|error| error.to_string())?;
    fs::write(&marker, version.trim()).map_err(|error| error.to_string())?;
    Ok((runtime_dir, native_dir))
}

fn prepare_server(app: &AppHandle) -> Result<PreparedServer, String> {
    let resource = resource_root(app)?;
    let binary = server_binary(app, &resource)?;
    let (runtime_dir, native_modules) = unpack_runtime(app, &resource)?;
    Ok(PreparedServer {
        binary,
        resource,
        runtime_dir,
        native_modules,
    })
}

fn spawn_output_reader<R>(reader: R, output: Arc<Mutex<VecDeque<String>>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if let Ok(mut recent) = output.lock() {
                if recent.len() >= 24 {
                    recent.pop_front();
                }
                recent.push_back(line);
            }
        }
    });
}

fn spawn_server(
    prepared: PreparedServer,
    output: Arc<Mutex<VecDeque<String>>>,
) -> Result<SpawnedServer, String> {
    let mut command = Command::new(&prepared.binary);
    command
        .current_dir(&prepared.resource)
        .env("PIUI_HOST", "127.0.0.1")
        .env("PIUI_PORT", DEFAULT_PORT)
        .env("PIUI_DRIVER", "pi")
        .env("PIUI_RUNTIME_DIR", prepared.runtime_dir)
        .env("PIUI_NATIVE_MODULES", prepared.native_modules)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start PiUI server: {error}"))?;
    if let Some(stdout) = child.stdout.take() {
        spawn_output_reader(stdout, output.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_output_reader(stderr, output.clone());
    }
    Ok(SpawnedServer { child })
}

fn read_token() -> Result<String, String> {
    let home = if cfg!(target_os = "windows") {
        env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        env::var_os("HOME").map(PathBuf::from)
    }
    .ok_or_else(|| "home directory is unavailable".to_string())?;
    let path = home.join(".piui").join("auth-token");
    fs::read_to_string(&path)
        .map(|token| token.trim().to_string())
        .map_err(|error| {
            format!(
                "failed to read PiUI auth token at {}: {error}",
                path.display()
            )
        })
        .and_then(|token| {
            if token.is_empty() {
                Err(format!("PiUI auth token at {} is empty", path.display()))
            } else {
                Ok(token)
            }
        })
}

fn recent_output(state: &ServiceState) -> String {
    state
        .output
        .lock()
        .ok()
        .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join(" | "))
        .filter(|output| !output.is_empty())
        .map(|output| format!(" Recent output: {output}"))
        .unwrap_or_default()
}

async fn service_health(url: &str, token: Option<&str>) -> Option<HealthResponse> {
    let client = match Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .build()
    {
        Ok(client) => client,
        Err(_) => return None,
    };
    let mut request = client
        .get(format!("{}/api/v1/host/health", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(2));
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<HealthResponse>().await.ok()
}

pub async fn is_service_running(url: &str, token: Option<&str>) -> bool {
    service_health(url, token).await.is_some()
}

async fn service_process_id(url: &str, token: Option<&str>) -> Option<u32> {
    service_health(url, token).await?.process_id
}

async fn adopt_persisted_service(
    app: &AppHandle,
    state: &ServiceState,
    token: Option<&str>,
) -> bool {
    let Some(marker) = read_service_marker(app, state) else {
        return false;
    };
    if service_process_id(&marker.url, token).await == Some(marker.pid) {
        state.child_pid.store(marker.pid, Ordering::SeqCst);
        state.started_by_us.store(true, Ordering::SeqCst);
        if let Ok(mut url) = state.service_url.lock() {
            *url = Some(marker.url);
        }
        return true;
    }
    clear_service_marker(state);
    false
}

#[tauri::command]
pub async fn check_piui_service(url: String, token: Option<String>) -> Result<bool, String> {
    Ok(is_service_running(&url, token.as_deref()).await)
}

#[tauri::command]
pub async fn start_piui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<StartServiceResult, String> {
    if state.starting.swap(true, Ordering::SeqCst) {
        return Err("PiUI server is already starting".to_string());
    }

    let result = start_piui_service_inner(&app, &state).await;
    state.starting.store(false, Ordering::SeqCst);
    result
}

async fn start_piui_service_inner(
    app: &AppHandle,
    state: &State<'_, ServiceState>,
) -> Result<StartServiceResult, String> {
    let token = read_token().ok();

    if adopt_persisted_service(app, state, token.as_deref()).await {
        let url = state
            .service_url
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());
        return Ok(StartServiceResult {
            started: false,
            started_by_us: true,
            url: Some(url),
            token,
        });
    }

    if state.started_by_us.load(Ordering::SeqCst) {
        let url = state
            .service_url
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());
        if is_service_running(&url, token.as_deref()).await {
            return Ok(StartServiceResult {
                started: false,
                started_by_us: true,
                url: Some(url),
                token,
            });
        }
    }

    if is_service_running(DEFAULT_SERVER_URL, token.as_deref()).await {
        state.started_by_us.store(false, Ordering::SeqCst);
        *state
            .service_url
            .lock()
            .map_err(|error| error.to_string())? = Some(DEFAULT_SERVER_URL.to_string());
        return Ok(StartServiceResult {
            started: false,
            started_by_us: false,
            url: Some(DEFAULT_SERVER_URL.to_string()),
            token,
        });
    }

    let app_for_prepare = app.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare_server(&app_for_prepare))
        .await
        .map_err(|error| format!("failed to prepare PiUI runtime: {error}"))??;

    if let Ok(mut output) = state.output.lock() {
        output.clear();
    }
    let spawned = spawn_server(prepared, state.output.clone())?;
    let pid = spawned.child.id();
    {
        let mut child = state.child.lock().map_err(|error| error.to_string())?;
        *child = Some(spawned.child);
    }
    state.child_pid.store(pid, Ordering::SeqCst);
    state.started_by_us.store(true, Ordering::SeqCst);
    *state
        .service_url
        .lock()
        .map_err(|error| error.to_string())? = Some(DEFAULT_SERVER_URL.to_string());
    if let Err(error) = persist_service_marker(app, state, pid, DEFAULT_SERVER_URL) {
        stop_piui_service_process(state);
        return Err(format!("failed to persist PiUI service ownership: {error}"));
    }

    for _ in 0..120 {
        let exited = {
            let mut child = state.child.lock().map_err(|error| error.to_string())?;
            child
                .as_mut()
                .map(|process| process.try_wait())
                .transpose()
                .map_err(|error| error.to_string())?
                .flatten()
        };
        if let Some(status) = exited {
            state.started_by_us.store(false, Ordering::SeqCst);
            state.child_pid.store(0, Ordering::SeqCst);
            clear_service_marker(state);
            if let Ok(mut child) = state.child.lock() {
                *child = None;
            }
            return Err(format!(
                "PiUI server exited during startup with status {status}.{}",
                recent_output(state)
            ));
        }

        let current_token = read_token().ok().or_else(|| token.clone());
        if is_service_running(DEFAULT_SERVER_URL, current_token.as_deref()).await {
            return Ok(StartServiceResult {
                started: true,
                started_by_us: true,
                url: Some(DEFAULT_SERVER_URL.to_string()),
                token: current_token,
            });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    stop_piui_service_process(state);
    Err(format!(
        "PiUI server started but health check did not pass.{}",
        recent_output(state)
    ))
}

#[cfg(target_os = "windows")]
fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let _ = command.status();
}

#[cfg(not(target_os = "windows"))]
fn kill_process_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn stop_piui_service_process(state: &ServiceState) {
    let pid = state.child_pid.swap(0, Ordering::SeqCst);
    state.started_by_us.store(false, Ordering::SeqCst);
    clear_service_marker(state);
    if let Ok(mut url) = state.service_url.lock() {
        *url = None;
    }
    if pid > 0 {
        kill_process_tree(pid);
    }
    if let Ok(mut child) = state.child.lock() {
        if let Some(process) = child.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        *child = None;
    }
}

#[tauri::command]
pub async fn stop_piui_service(state: State<'_, ServiceState>) -> Result<(), String> {
    stop_piui_service_process(&state);
    Ok(())
}

#[tauri::command]
pub async fn restart_piui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<StartServiceResult, String> {
    stop_piui_service_process(&state);
    start_piui_service_inner(&app, &state).await
}

#[tauri::command]
pub async fn get_piui_service_status(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<ServiceStatusResult, String> {
    let token = read_token().ok();
    let _ = adopt_persisted_service(&app, &state, token.as_deref()).await;
    let url = state
        .service_url
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());
    let health = service_health(&url, token.as_deref()).await;
    let running = health.is_some();
    if !running && state.started_by_us.load(Ordering::SeqCst) {
        stop_piui_service_process(&state);
    }
    let pid = health
        .as_ref()
        .and_then(|health| health.process_id)
        .or_else(|| {
            let pid = state.child_pid.load(Ordering::SeqCst);
            (pid > 0).then_some(pid)
        });
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let runtime_dir = data_dir.join("runtime");
    let native_modules = data_dir.join("node_modules");
    Ok(ServiceStatusResult {
        running,
        started_by_us: running && state.started_by_us.load(Ordering::SeqCst),
        pid,
        url: running.then_some(url),
        environment: service_environment(Some(&runtime_dir), Some(&native_modules)),
    })
}

#[tauri::command]
pub async fn confirm_close_app(
    window: tauri::Window,
    state: State<'_, ServiceState>,
    stop_service: bool,
) -> Result<(), String> {
    if stop_service {
        stop_piui_service_process(&state);
    }
    state.allow_close.store(true, Ordering::SeqCst);
    window.destroy().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_piui_service_started_by_us(
    state: State<'_, ServiceState>,
) -> Result<bool, String> {
    Ok(state.started_by_us.load(Ordering::SeqCst))
}
