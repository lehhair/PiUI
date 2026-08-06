#[cfg(not(target_os = "android"))]
mod bridge;
#[cfg(not(target_os = "android"))]
mod service;

use tauri::{Emitter, Manager, WebviewWindowBuilder};

#[cfg(not(target_os = "android"))]
use tauri::{WebviewUrl, Window};

#[cfg(not(target_os = "android"))]
use service::{
    confirm_close_app, get_piui_service_status, restart_piui_service, start_piui_service,
    stop_piui_service, ServiceState,
};

#[cfg(not(target_os = "android"))]
fn configure_desktop_window_builder<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 14.0));

    builder
}

#[cfg(not(target_os = "android"))]
fn finish_desktop_window_setup(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_decorum::WebviewWindowExt;
        let _ = window.create_overlay_titlebar();
    }

    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_decorum::WebviewWindowExt;
        let _ = window.set_traffic_lights_inset(12.0, 14.0);
    }
}

#[cfg(not(target_os = "android"))]
fn create_main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, tauri::Error> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .expect("main window config missing");

    configure_desktop_window_builder(tauri::WebviewWindowBuilder::from_config(app, &config)?)
        .visible(false)
        .build()
}

#[cfg(target_os = "android")]
fn create_main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, tauri::Error> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .expect("main window config missing");
    WebviewWindowBuilder::from_config(app, &config)?.build()
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn desktop_window_ready(window: Window) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn open_new_window(app: tauri::AppHandle, directory: Option<String>) -> Result<(), String> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let label = format!(
        "win-{}",
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let title = directory.as_deref().unwrap_or("PiUI");
    let window = configure_desktop_window_builder(WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App("index.html".into()),
    ))
    .title(title)
    .inner_size(1200.0, 800.0)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;
    finish_desktop_window_setup(&window);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebView2 的 fetch/WebSocket 默认走系统代理。代理软件（Clash 等）不转发
    // 本地回环连接时，ws://127.0.0.1 的事件流会被直接拒绝（net::ERR_CONNECTION_REFUSED）。
    // 应用自身是自包含的，唯一的外部请求（GitHub 更新检查）走 Rust reqwest，
    // 所以让 webview 整体绕过代理是安全的。必须在创建任何 webview 之前设置。
    #[cfg(target_os = "windows")]
    {
        const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
        let existing = std::env::var(KEY).unwrap_or_default();
        if !existing.contains("--no-proxy-server") {
            std::env::set_var(KEY, format!("{existing} --no-proxy-server").trim());
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(target_os = "android"))]
    let builder = builder
        .manage(ServiceState::default())
        .manage(bridge::BridgeState::default())
        .plugin(tauri_plugin_decorum::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let is_last = window.app_handle().webview_windows().len() <= 1;
                let state = window.state::<ServiceState>();
                if is_last && state.should_confirm_close() {
                    api.prevent_close();
                    let _ = window.emit("close-requested", ());
                }
            }
        })
        .setup(|app| {
            let main_window = create_main_window(app.handle())?;
            finish_desktop_window_setup(&main_window);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_piui_service,
            stop_piui_service,
            restart_piui_service,
            get_piui_service_status,
            confirm_close_app,
            desktop_window_ready,
            open_new_window,
            bridge::ws_bridge_connect,
            bridge::ws_bridge_send,
            bridge::ws_bridge_close,
        ]);

    #[cfg(target_os = "android")]
    let builder = builder.setup(|app| {
        let _ = create_main_window(app.handle())?;
        Ok(())
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building PiUI desktop client");

    app.run(|_, _| {});
}
