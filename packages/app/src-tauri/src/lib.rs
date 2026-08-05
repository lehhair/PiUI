#[cfg(not(target_os = "android"))]
mod service;

use tauri::{Emitter, Manager, WebviewWindowBuilder};

#[cfg(not(target_os = "android"))]
use tauri::{WebviewUrl, Window};

#[cfg(not(target_os = "android"))]
use service::{
    check_piui_service, confirm_close_app, get_piui_service_started_by_us, get_piui_service_status,
    restart_piui_service, start_piui_service, stop_piui_service, ServiceState,
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(target_os = "android"))]
    let builder = builder
        .manage(ServiceState::default())
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
                if is_last
                    && state
                        .started_by_us
                        .load(std::sync::atomic::Ordering::SeqCst)
                    && !state
                        .allow_close
                        .swap(false, std::sync::atomic::Ordering::SeqCst)
                {
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
            check_piui_service,
            start_piui_service,
            stop_piui_service,
            restart_piui_service,
            get_piui_service_status,
            get_piui_service_started_by_us,
            confirm_close_app,
            desktop_window_ready,
            open_new_window,
        ]);

    #[cfg(target_os = "android")]
    let builder = builder.setup(|app| {
        let _ = create_main_window(app.handle())?;
        Ok(())
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building PiUI desktop client");

    #[cfg(not(target_os = "android"))]
    app.run(|_, _| {});

    #[cfg(target_os = "android")]
    app.run(|_, _| {});
}
