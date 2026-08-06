use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    collections::VecDeque,
    env,
    fs::{self, create_dir_all},
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

const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:8787";
const DEFAULT_PORT: &str = "8787";

pub struct ServiceState {
    pub child: Mutex<Option<Child>>,
    pub child_pid: AtomicU32,
    pub started_by_us: AtomicBool,
    pub allow_close: AtomicBool,
    lifecycle: tokio::sync::Mutex<()>,
    pub service_url: Mutex<Option<String>>,
    pub env_vars: Mutex<BTreeMap<String, String>>,
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
            lifecycle: tokio::sync::Mutex::new(()),
            service_url: Mutex::new(None),
            env_vars: Mutex::new(BTreeMap::new()),
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

#[derive(Debug, Serialize)]
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

enum HealthFailure {
    Unreachable,
    Rejected(String),
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
    native_modules: PathBuf,
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
    native_modules: Option<&PathBuf>,
    custom: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::from([
        ("PIUI_HOST".to_string(), "127.0.0.1".to_string()),
        ("PIUI_PORT".to_string(), DEFAULT_PORT.to_string()),
        ("PIUI_DRIVER".to_string(), "pi".to_string()),
    ]);
    if let Some(path) = native_modules {
        environment.insert(
            "PIUI_NATIVE_MODULES".to_string(),
            path.display().to_string(),
        );
    }
    environment.extend(
        custom
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    environment
}

fn resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    {
        // Tauri's path API may return the \\?\ extended-length prefix, which
        // the Bun runtime cannot resolve inside import() when the server loads
        // bun-pty from the resource directory. Strip it so every derived path
        // (binary, runtime, native modules, cwd) is plain.
        let text = path.to_string_lossy();
        if let Some(stripped) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(stripped));
        }
    }
    Ok(path)
}

fn server_binary(app: &AppHandle, resource: &PathBuf) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("PIUI_SERVER_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let binary = resource.join(if cfg!(target_os = "windows") {
        "pi-worker.exe"
    } else {
        "pi-worker"
    });
    binary.is_file().then_some(binary).ok_or_else(|| {
        format!(
            "PiUI server binary was not bundled in {}",
            app.path()
                .resource_dir()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|_| "the resource directory".to_string())
        )
    })
}

fn prepare_server(app: &AppHandle) -> Result<PreparedServer, String> {
    let resource = resource_root(app)?;
    let binary = server_binary(app, &resource)?;
    let native_modules = resource.join("node_modules");
    if !native_modules.join("bun-pty").is_dir() {
        return Err(format!(
            "bun-pty was not bundled in {}",
            native_modules.display()
        ));
    }
    Ok(PreparedServer {
        binary,
        resource,
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
    env_vars: &BTreeMap<String, String>,
) -> Result<Child, String> {
    let mut command = Command::new(&prepared.binary);
    command
        .arg("web")
        .current_dir(&prepared.resource)
        .env("PIUI_HOST", "127.0.0.1")
        .env("PIUI_PORT", DEFAULT_PORT)
        .env("PIUI_DRIVER", "pi")
        .env("PIUI_NATIVE_MODULES", prepared.native_modules)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in env_vars {
        command.env(key, value);
    }

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
    Ok(child)
}

fn read_token(env_vars: &BTreeMap<String, String>) -> Result<String, String> {
    if let Some(token) = env_vars.get("PIUI_AUTH_TOKEN") {
        let token = token.trim();
        return if token.is_empty() {
            Err("PIUI_AUTH_TOKEN is empty".to_string())
        } else {
            Ok(token.to_string())
        };
    }
    if let Ok(token) = env::var("PIUI_AUTH_TOKEN") {
        let token = token.trim();
        if !token.is_empty() {
            return Ok(token.to_string());
        }
    }
    let home = if cfg!(target_os = "windows") {
        env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        env::var_os("HOME").map(PathBuf::from)
    }
    .ok_or_else(|| "home directory is unavailable".to_string())?;
    let data_dir = env_vars
        .get("PIUI_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("PIUI_DATA_DIR").map(PathBuf::from))
        .unwrap_or_else(|| home.join(".piui"));
    let path = data_dir.join("auth-token");
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

async fn service_health(url: &str, token: Option<&str>) -> Result<HealthResponse, HealthFailure> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .build()
        .map_err(|_| HealthFailure::Unreachable)?;
    let mut request = client
        .get(format!("{}/api/v1/host/health", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(2));
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|_| HealthFailure::Unreachable)?;
    if !response.status().is_success() {
        return Err(HealthFailure::Rejected(response.status().to_string()));
    }
    response
        .json::<HealthResponse>()
        .await
        .map_err(|error| HealthFailure::Rejected(error.to_string()))
}

pub async fn is_service_running(url: &str, token: Option<&str>) -> bool {
    service_health(url, token).await.is_ok()
}

fn configured_service_url(env_vars: &BTreeMap<String, String>) -> String {
    let port = env_vars
        .get("PIUI_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8787);
    let host = env_vars
        .get("PIUI_HOST")
        .map(String::as_str)
        .filter(|value| !value.is_empty() && *value != "0.0.0.0" && *value != "::")
        .unwrap_or("127.0.0.1");
    format!("http://{host}:{port}")
}

async fn adopt_persisted_service(
    app: &AppHandle,
    state: &ServiceState,
    token: Option<&str>,
    environment: &BTreeMap<String, String>,
) -> Result<bool, String> {
    let Some(marker) = read_service_marker(app, state) else {
        return Ok(false);
    };
    match service_health(&marker.url, token).await {
        Ok(health) if health.process_id == Some(marker.pid) => {
            state.child_pid.store(marker.pid, Ordering::SeqCst);
            state.started_by_us.store(true, Ordering::SeqCst);
            if let Ok(mut url) = state.service_url.lock() {
                *url = Some(marker.url);
            }
            if let Ok(mut env_vars) = state.env_vars.lock() {
                *env_vars = environment.clone();
            }
            return Ok(true);
        }
        Ok(_) | Err(HealthFailure::Unreachable) => {
            clear_service_marker(state);
            Ok(false)
        }
        Err(HealthFailure::Rejected(reason)) => Err(format!(
            "A retained PiUI service at {} rejected its health check ({reason}); check its token and environment before starting another service",
            marker.url
        )),
    }
}

#[tauri::command]
pub async fn start_piui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    let _lifecycle = state.lifecycle.lock().await;
    start_piui_service_inner(&app, &state, env_vars).await
}

async fn start_piui_service_inner(
    app: &AppHandle,
    state: &State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    let token = read_token(&env_vars).ok();
    let service_url = configured_service_url(&env_vars);

    if adopt_persisted_service(app, state, token.as_deref(), &env_vars).await? {
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

    if is_service_running(&service_url, token.as_deref()).await {
        state.started_by_us.store(false, Ordering::SeqCst);
        *state
            .service_url
            .lock()
            .map_err(|error| error.to_string())? = Some(service_url.clone());
        return Ok(StartServiceResult {
            started: false,
            started_by_us: false,
            url: Some(service_url),
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
    let spawned = spawn_server(prepared, state.output.clone(), &env_vars)?;
    let pid = spawned.id();
    {
        let mut child = state.child.lock().map_err(|error| error.to_string())?;
        *child = Some(spawned);
    }
    state.child_pid.store(pid, Ordering::SeqCst);
    state.started_by_us.store(true, Ordering::SeqCst);
    *state
        .service_url
        .lock()
        .map_err(|error| error.to_string())? = Some(service_url.clone());
    *state.env_vars.lock().map_err(|error| error.to_string())? = env_vars.clone();
    if let Err(error) = persist_service_marker(app, state, pid, &service_url) {
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

        let current_token = read_token(&env_vars).ok().or_else(|| token.clone());
        if is_service_running(&service_url, current_token.as_deref()).await {
            return Ok(StartServiceResult {
                started: true,
                started_by_us: true,
                url: Some(service_url.clone()),
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
    if let Ok(mut env_vars) = state.env_vars.lock() {
        env_vars.clear();
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
    let _lifecycle = state.lifecycle.lock().await;
    stop_piui_service_process(&state);
    Ok(())
}

#[tauri::command]
pub async fn restart_piui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    let _lifecycle = state.lifecycle.lock().await;
    stop_piui_service_process(&state);
    start_piui_service_inner(&app, &state, env_vars).await
}

#[tauri::command]
pub async fn get_piui_service_status(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<ServiceStatusResult, String> {
    let _lifecycle = state.lifecycle.lock().await;
    let token = read_token(&env_vars).ok();
    let _ = adopt_persisted_service(&app, &state, token.as_deref(), &env_vars).await;
    let url = state
        .service_url
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .unwrap_or_else(|| configured_service_url(&env_vars));
    let health = service_health(&url, token.as_deref()).await.ok();
    let running = health.is_some();
    let pid = health
        .as_ref()
        .and_then(|health| health.process_id)
        .or_else(|| {
            let pid = state.child_pid.load(Ordering::SeqCst);
            (pid > 0).then_some(pid)
        });
    let resource = resource_root(&app)?;
    let native_modules = resource.join("node_modules");
    Ok(ServiceStatusResult {
        running,
        started_by_us: running && state.started_by_us.load(Ordering::SeqCst),
        pid,
        url: running.then_some(url),
        environment: service_environment(Some(&native_modules), &env_vars),
    })
}

#[tauri::command]
pub async fn confirm_close_app(
    window: tauri::Window,
    state: State<'_, ServiceState>,
    stop_service: bool,
) -> Result<(), String> {
    if stop_service {
        let _lifecycle = state.lifecycle.lock().await;
        stop_piui_service_process(&state);
    }
    state.allow_close.store(true, Ordering::SeqCst);
    window.destroy().map_err(|error| error.to_string())
}
