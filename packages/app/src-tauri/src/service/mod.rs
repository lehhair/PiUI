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
    is_process_alive, kill_process_tree, prepare_server, request_graceful_shutdown, resource_root,
    service_environment, spawn_server,
};

const DEFAULT_PORT: &str = "8787";

pub struct ServiceState {
    child: Mutex<Option<Child>>,
    child_pid: AtomicU32,
    started_by_us: AtomicBool,
    allow_close: AtomicBool,
    /// 用户在关闭确认里选择「保留后台服务」：退出兜底不再强杀子进程。
    keep_on_exit: AtomicBool,
    lifecycle: tokio::sync::Mutex<()>,
    service_url: Mutex<Option<String>>,
    /// 当前托管服务的鉴权 token（优雅关闭请求需要带鉴权头）。
    service_token: Mutex<Option<String>>,
    output: Arc<Mutex<VecDeque<String>>>,
}

impl ServiceState {
    pub fn should_confirm_close(&self) -> bool {
        self.started_by_us.load(Ordering::SeqCst) && !self.allow_close.swap(false, Ordering::SeqCst)
    }

    /// 应用退出前的最后兜底（RunEvent::Exit）：无论前端确认弹窗是否走到，
    /// 只要服务是我们启动的、且用户没选择「保留后台服务」，就杀掉子进程，
    /// 防止孤儿进程长期占用端口。强杀（taskkill /F、断电）不会经过这里，
    /// 那类场景由下次启动时的收养逻辑清场。
    pub fn stop_service_on_exit(&self) {
        if self.keep_on_exit.load(Ordering::SeqCst) {
            return;
        }
        if !self.started_by_us.swap(false, Ordering::SeqCst) {
            return;
        }
        let pid = self.child_pid.swap(0, Ordering::SeqCst);
        let url = self.service_url.lock().ok().and_then(|mut guard| guard.take());
        let token = self.service_token.lock().ok().and_then(|mut guard| guard.take());
        if pid > 0 {
            if let Some(url) = url {
                // 同步的 RunEvent::Exit 上下文：block_on 跑一次带短超时的优雅关闭
                // （请求 3s + 等待退出 ~3s），失败/超时则强杀兜底，不留孤儿端口。
                // 注意：server 优雅关闭要等 worker 清理所有 runtime（dispose 预算
                // 15s），这里等待必须覆盖它，否则每次都强杀 → 会话锁残留 →
                // 重启后 SESSION_BUSY 要等 60s stale 过期。
                let graceful = tauri::async_runtime::block_on(request_graceful_shutdown(&url, token.as_deref()));
                if graceful {
                    // 用持有的 Child 句柄 try_wait 判断退出（零子进程开销），
                    // 不用 tasklist 轮询（每次 ~130ms 的进程创建）。
                    let deadline = std::time::Instant::now() + Duration::from_secs(20);
                    while std::time::Instant::now() < deadline {
                        let exited = self
                            .child
                            .lock()
                            .ok()
                            .and_then(|mut child| child.as_mut().and_then(|process| process.try_wait().ok()).flatten())
                            .is_some();
                        if exited {
                            break
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
            if is_process_alive(pid) {
                kill_process_tree(pid);
            }
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(process) = child.as_mut() {
                let _ = process.kill();
                let _ = process.wait();
            }
            *child = None;
        }
    }
}

impl Default for ServiceState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            child_pid: AtomicU32::new(0),
            started_by_us: AtomicBool::new(false),
            allow_close: AtomicBool::new(false),
            keep_on_exit: AtomicBool::new(false),
            lifecycle: tokio::sync::Mutex::new(()),
            service_url: Mutex::new(None),
            service_token: Mutex::new(None),
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
    // 超时别太紧：服务端 health 已改为只读快照（不在请求路径上孵化
    // worker），正常响应在毫秒级；但系统繁忙/杀软扫描时仍可能抖动，
    // 过紧的超时会把「活着」的服务误判为不可达，进而触发不必要的清场。
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(2))
        .build()
        .map_err(|_| HealthFailure::Unreachable)?;
    let mut request = client
        .get(format!("{}/api/v1/host/health", url.trim_end_matches('/')))
        .timeout(Duration::from_secs(5));
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

/// 残留服务收养的宽限探测：进程可能刚从上次启动冷启动（SDK worker 孵化
/// 要数秒），首轮探测不可达不等于僵死，重试几轮再判死。
const ADOPT_HEALTH_ATTEMPTS: u32 = 4;
const ADOPT_HEALTH_RETRY_DELAY: Duration = Duration::from_millis(1_000);

async fn adopt_persisted_service(
    app: &AppHandle,
    state: &ServiceState,
    config: &ServiceConfig,
) -> Result<bool, String> {
    let Some(marker) = marker::read(app)? else {
        return Ok(false);
    };
    let mut last_failure = HealthFailure::Unreachable;
    for attempt in 0..ADOPT_HEALTH_ATTEMPTS {
        if attempt > 0 {
            tokio::time::sleep(ADOPT_HEALTH_RETRY_DELAY).await;
        }
        match service_health(&marker.url, config.initial_token.as_deref()).await {
            Ok(health) if health.process_id == Some(marker.pid) => {
                state.child_pid.store(marker.pid, Ordering::SeqCst);
                state.started_by_us.store(true, Ordering::SeqCst);
                if let Ok(mut url) = state.service_url.lock() {
                    *url = Some(marker.url.clone());
                }
                if let Ok(mut token) = state.service_token.lock() {
                    *token = config.initial_token.clone();
                }
                return Ok(true);
            }
            // URL 已被别的服务接管：放弃收养，按外部服务处理。
            Ok(_) => {
                marker::clear(app);
                clear_service_ownership(state);
                return Ok(false);
            }
            Err(failure) => last_failure = failure,
        }
        if !is_process_alive(marker.pid) {
            // 进程已退出：清掉陈旧标记，走全新启动。
            marker::clear(app);
            clear_service_ownership(state);
            return Ok(false);
        }
    }
    match last_failure {
        // 宽限后仍不可达 = 僵死进程（事件循环卡死/半初始化）。旧逻辑在这里
        // 直接报错并拒绝启动，导致端口被孤儿进程永久占用、新服务起不来；
        // 现在强杀残留进程，让启动流程照常孵化新服务。
        HealthFailure::Unreachable => {
            log::warn!(
                "killing retained PiUI service process {} at {}: health stayed unreachable",
                marker.pid, marker.url
            );
            // 优雅优先：先请求 HTTP 关闭，等进程退出，超时才强杀。
            // （保留进程的 token 应与当前配置一致 —— 都是同一个 auth-token 文件）
            let _ = request_graceful_shutdown(&marker.url, config.initial_token.as_deref()).await;
            for _ in 0..20 {
                if !is_process_alive(marker.pid) {
                    break
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            if is_process_alive(marker.pid) {
                kill_process_tree(marker.pid);
            }
            marker::clear(app);
            clear_service_ownership(state);
            Ok(false)
        }
        HealthFailure::Rejected(reason) => Err(format!(
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
        let pid = state.child_pid.load(Ordering::SeqCst);
        if pid > 0 && is_process_alive(pid) {
            // 本次会话内启动的服务僵死（进程在、health 不可达）：旧逻辑直接
            // 报错并保留僵尸进程占用端口；现在强杀后走下方全新启动。
            log::warn!("killing hung PiUI service process {pid} at {url}: health unreachable");
            stop_piui_service_process(app, state).await;
        } else {
            marker::clear(app);
            clear_service_ownership(state);
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
    *state
        .service_token
        .lock()
        .map_err(|error| error.to_string())? = config.initial_token.clone();
    if let Err(error) = marker::persist(app, pid, &config.url) {
        stop_piui_service_process(app, state).await;
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

    stop_piui_service_process(app, state).await;
    Err(format!(
        "PiUI server started but health check did not pass.{}",
        recent_output(state)
    ))
}

/// 优雅停止托管的服务进程：先请求 HTTP 优雅关闭并等进程退出，
/// 超时（进程仍活着）才退回 taskkill /F 强杀兜底。
async fn stop_piui_service_process(app: &AppHandle, state: &ServiceState) {
    let pid = state.child_pid.swap(0, Ordering::SeqCst);
    state.started_by_us.store(false, Ordering::SeqCst);
    marker::clear(app);
    let url = state
        .service_url
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    let token = state
        .service_token
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    if pid > 0 {
        if let Some(url) = url {
            // 1. 先触发服务端优雅关闭（关监听、排空连接、dispose worker）
            let _ = request_graceful_shutdown(&url, token.as_deref()).await;
            // 2. 用持有的 Child 句柄 try_wait 判断退出（零子进程开销，不用
            //    tasklist 轮询——每次 ~130ms 的进程创建），最多等 ~4s
            for _ in 0..20 {
                let exited = state
                    .child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.as_mut().and_then(|process| process.try_wait().ok()).flatten())
                    .is_some();
                if exited {
                    break
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        // 3. 兜底：优雅关闭失败/超时才强杀进程树
        if is_process_alive(pid) {
            log::warn!("graceful shutdown of PiUI service {pid} did not complete; force killing");
            kill_process_tree(pid);
        }
    }
    if let Ok(mut child) = state.child.lock() {
        if let Some(process) = child.as_mut() {
            let _ = process.kill();
            let _ = process.wait();
        }
        *child = None;
    }
}

fn clear_service_ownership(state: &ServiceState) {
    state.child_pid.store(0, Ordering::SeqCst);
    state.started_by_us.store(false, Ordering::SeqCst);
    if let Ok(mut url) = state.service_url.lock() {
        *url = None;
    }
    if let Ok(mut token) = state.service_token.lock() {
        *token = None;
    }
    if let Ok(mut child) = state.child.lock() {
        let exited = child
            .as_mut()
            .and_then(|process| process.try_wait().ok())
            .flatten()
            .is_some();
        if exited {
            *child = None;
        }
    }
}

#[tauri::command]
pub async fn stop_piui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<(), String> {
    let _lifecycle = state.lifecycle.lock().await;
    stop_piui_service_process(&app, &state).await;
    Ok(())
}

#[tauri::command]
pub async fn restart_piui_service(
    app: AppHandle,
    state: State<'_, ServiceState>,
    env_vars: BTreeMap<String, String>,
) -> Result<StartServiceResult, String> {
    let _lifecycle = state.lifecycle.lock().await;
    stop_piui_service_process(&app, &state).await;
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
    // 记录用户对后台服务的处置意愿：退出兜底（stop_service_on_exit）据此
    // 决定是否强杀子进程——选了「保留」就不能杀。
    state.keep_on_exit.store(!stop_service, Ordering::SeqCst);
    if stop_service {
        let _lifecycle = state.lifecycle.lock().await;
        stop_piui_service_process(window.app_handle(), &state).await;
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

    #[test]
    fn process_liveness_distinguishes_current_and_missing_processes() {
        assert!(is_process_alive(std::process::id()));
        // u32::MAX 在某些 Linux 内核上 kill -0 会误判为存活，不可靠。
        // 用"已退出子进程的 PID"——任何平台都能确定它已死。
        let exited = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .status()
            .expect("spawn helper should succeed");
        // 直接拿子进程 PID 不可行（status 不暴露），改用它退出后由系统回收
        // 的常见空 PID：spawn 一个会立刻自杀的子进程。
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .spawn()
            .expect("spawn helper should succeed");
        let dead_pid = child.id();
        let _ = child.wait();
        assert!(!is_process_alive(dead_pid));
    }
}
