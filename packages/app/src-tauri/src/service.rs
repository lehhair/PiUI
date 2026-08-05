use serde::Serialize;
use std::{
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
    pub starting: AtomicBool,
    pub service_url: Mutex<Option<String>>,
    output: Arc<Mutex<VecDeque<String>>>,
}

impl Default for ServiceState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            child_pid: AtomicU32::new(0),
            started_by_us: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            service_url: Mutex::new(None),
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

struct PreparedServer {
    binary: PathBuf,
    resource: PathBuf,
    runtime_dir: PathBuf,
    native_modules: PathBuf,
}

struct SpawnedServer {
    child: Child,
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

    if marker.exists()
        && fs::read_to_string(&marker).ok().as_deref() == Some(version.trim())
        && runtime_dir.join("current.json").is_file()
        && native_dir.is_dir()
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

pub async fn is_service_running(url: &str, token: Option<&str>) -> bool {
    let client = match Client::builder()
        .connect_timeout(Duration::from_secs(1))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let mut request = client
        .get(format!("{}/api/v1/host/health", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(2));
    if let Some(token) = token.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(token);
    }
    request
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
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
pub async fn get_piui_service_started_by_us(
    state: State<'_, ServiceState>,
) -> Result<bool, String> {
    Ok(state.started_by_us.load(Ordering::SeqCst))
}
