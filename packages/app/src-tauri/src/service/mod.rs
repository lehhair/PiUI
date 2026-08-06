use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    env, fs,
    path::PathBuf,
    process::Child,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use reqwest::Client;
use tauri::{AppHandle, Manager, State};

mod marker;
mod process;

use process::{
    kill_process_tree, prepare_server, resource_root, service_environment, spawn_server,
};

const DEFAULT_PORT: &str = "8787";

pub struct ServiceState {
    child: Mutex<Option<Child>>,
    child_pid: AtomicU32,
    started_by_us: AtomicBool,
    allow_close: AtomicBool,
    lifecycle: tokio::sync::Mutex<()>,
    pub service_url: Mutex<Option<String>>,
    pub env_vars: Mutex<BTreeMap<String, String>>,
    output: Arc<Mutex<VecDeque<String>>>,
}

impl ServiceState {
    pub fn should_confirm_close(&self) -> bool {
        self.started_by_us.load(Ordering::SeqCst) && !self.allow_close.swap(false, Ordering::SeqCst)
    }
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

struct ServiceConfig {
    environment: BTreeMap<String, String>,
    url: String,
    initial_token: Option<String>,
}

impl ServiceConfig {
    fn new(environment: BTreeMap<String, String>) -> Self {
        let url = configured_service_url(&environment);
        let initial_token = read_token(&environment).ok();
        Self {
            environment,
            url,
            initial_token,
        }
    }

    fn token(&self) -> Option<String> {
        read_token(&self.environment)
            .ok()
            .or_else(|| self.initial_token.clone())
    }
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

async fn is_service_running(url: &str, token: Option<&str>) -> bool {
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
    config: &ServiceConfig,
) -> Result<bool, String> {
    let Some(marker) = marker::read(app)? else {
        return Ok(false);
    };
    match service_health(&marker.url, config.initial_token.as_deref()).await {
        Ok(health) if health.process_id == Some(marker.pid) => {
            state.child_pid.store(marker.pid, Ordering::SeqCst);
            state.started_by_us.store(true, Ordering::SeqCst);
            if let Ok(mut url) = state.service_url.lock() {
                *url = Some(marker.url);
            }
            if let Ok(mut env_vars) = state.env_vars.lock() {
                *env_vars = config.environment.clone();
            }
            return Ok(true);
        }
        Ok(_) | Err(HealthFailure::Unreachable) => {
            marker::clear(app);
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
    state: &ServiceState,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    let config = ServiceConfig::new(env_vars);

    if adopt_persisted_service(app, state, &config).await? {
        let url = state
            .service_url
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_else(|| config.url.clone());
        return Ok(StartServiceResult {
            started: false,
            started_by_us: true,
            url: Some(url),
            token: config.initial_token,
        });
    }

    if state.started_by_us.load(Ordering::SeqCst) {
        let url = state
            .service_url
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .unwrap_or_else(|| config.url.clone());
        if is_service_running(&url, config.initial_token.as_deref()).await {
            return Ok(StartServiceResult {
                started: false,
                started_by_us: true,
                url: Some(url),
                token: config.initial_token,
            });
        }
    }

    if is_service_running(&config.url, config.initial_token.as_deref()).await {
        state.started_by_us.store(false, Ordering::SeqCst);
        *state
            .service_url
            .lock()
            .map_err(|error| error.to_string())? = Some(config.url.clone());
        return Ok(StartServiceResult {
            started: false,
            started_by_us: false,
            url: Some(config.url),
            token: config.initial_token,
        });
    }

    let app_for_prepare = app.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare_server(&app_for_prepare))
        .await
        .map_err(|error| format!("failed to prepare PiUI runtime: {error}"))??;

    if let Ok(mut output) = state.output.lock() {
        output.clear();
    }
    let spawned = spawn_server(prepared, state.output.clone(), &config.environment)?;
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
        .map_err(|error| error.to_string())? = Some(config.url.clone());
    *state.env_vars.lock().map_err(|error| error.to_string())? = config.environment.clone();
    if let Err(error) = marker::persist(app, pid, &config.url) {
        stop_piui_service_process(app, state);
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
            marker::clear(app);
            if let Ok(mut child) = state.child.lock() {
                *child = None;
            }
            return Err(format!(
                "PiUI server exited during startup with status {status}.{}",
                recent_output(state)
            ));
        }

        let current_token = config.token();
        if is_service_running(&config.url, current_token.as_deref()).await {
            return Ok(StartServiceResult {
                started: true,
                started_by_us: true,
                url: Some(config.url.clone()),
                token: current_token,
            });
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    stop_piui_service_process(app, state);
    Err(format!(
        "PiUI server started but health check did not pass.{}",
        recent_output(state)
    ))
}

fn stop_piui_service_process(app: &AppHandle, state: &ServiceState) {
    let pid = state.child_pid.swap(0, Ordering::SeqCst);
    state.started_by_us.store(false, Ordering::SeqCst);
    marker::clear(app);
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
pub async fn stop_piui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().await;
    stop_piui_service_process(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn restart_piui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    let _lifecycle = state.lifecycle.lock().await;
    stop_piui_service_process(&app, &state);
    start_piui_service_inner(&app, &state, env_vars).await
}

#[tauri::command]
pub async fn get_piui_service_status(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<ServiceStatusResult, String> {
    let _lifecycle = state.lifecycle.lock().await;
    let config = ServiceConfig::new(env_vars);
    let _ = adopt_persisted_service(&app, &state, &config).await;
    let url = state
        .service_url
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .unwrap_or_else(|| config.url.clone());
    let health = service_health(&url, config.initial_token.as_deref())
        .await
        .ok();
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
        environment: service_environment(Some(&native_modules), &config.environment),
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
        stop_piui_service_process(window.app_handle(), &state);
    }
    state.allow_close.store(true, Ordering::SeqCst);
    window.destroy().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_config_uses_connectable_url_and_explicit_token() {
        let config = ServiceConfig::new(BTreeMap::from([
            ("PIUI_HOST".to_string(), "0.0.0.0".to_string()),
            ("PIUI_PORT".to_string(), "9123".to_string()),
            ("PIUI_AUTH_TOKEN".to_string(), "test-token".to_string()),
        ]));

        assert_eq!(config.url, "http://127.0.0.1:9123");
        assert_eq!(config.initial_token.as_deref(), Some("test-token"));
    }

    #[test]
    fn custom_environment_overrides_built_in_service_values() {
        let environment = service_environment(
            None,
            &BTreeMap::from([
                ("PIUI_PORT".to_string(), "9000".to_string()),
                ("PIUI_USE_SYSTEM_PI".to_string(), "1".to_string()),
            ]),
        );

        assert_eq!(
            environment.get("PIUI_HOST").map(String::as_str),
            Some("127.0.0.1")
        );
        assert_eq!(
            environment.get("PIUI_PORT").map(String::as_str),
            Some("9000")
        );
        assert_eq!(
            environment.get("PIUI_DRIVER").map(String::as_str),
            Some("pi")
        );
        assert_eq!(
            environment.get("PIUI_USE_SYSTEM_PI").map(String::as_str),
            Some("1")
        );
    }
}
