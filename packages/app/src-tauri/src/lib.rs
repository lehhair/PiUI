mod bridge;
mod commands;
#[cfg(desktop)]
mod dir_state;
#[cfg(desktop)]
mod service;

use tauri::{Emitter, Manager, WebviewWindowBuilder};

#[cfg(desktop)]
use tauri::{WebviewUrl, Window};

#[cfg(desktop)]
use dir_state::OpenDirectoryState;

#[cfg(desktop)]
use service::{
    confirm_close_app, get_piui_service_status, restart_piui_service, start_piui_service,
    stop_piui_service, ServiceState,
};

// ============================================
// 桌面窗口：状态保存/恢复 + 目录参数 + 事件转发
// ============================================

#[cfg(desktop)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct SavedWindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    maximized: bool,
    #[serde(default)]
    fullscreen: bool,
}

#[cfg(desktop)]
fn window_state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("window-state.json"))
}

#[cfg(desktop)]
fn load_window_state(app: &tauri::AppHandle) -> Option<SavedWindowState> {
    let path = window_state_path(app)?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

#[cfg(desktop)]
fn save_window_state(window: &tauri::Window) {
    if window.label() != "main" {
        return;
    }

    let is_fullscreen = window.is_fullscreen().unwrap_or(false);

    // 全屏时 outer_size / outer_position 返回整个屏幕的尺寸和 (0,0)，
    // 保存这些值会导致下次恢复时窗口大小/位置不正确。
    // 全屏状态下只更新 fullscreen 标记，保留之前保存的正常 size/position。
    if is_fullscreen {
        let app = window.app_handle();
        if let Some(path) = window_state_path(app) {
            if let Ok(existing) = std::fs::read_to_string(&path) {
                if let Ok(mut state) = serde_json::from_str::<SavedWindowState>(&existing) {
                    state.fullscreen = true;
                    if let Ok(data) = serde_json::to_string(&state) {
                        let _ = std::fs::write(path, data);
                    }
                    return;
                }
            }
            // 没有已保存的状态，只写 fullscreen 标记，size/position 用默认值
            let state = SavedWindowState {
                width: 800,
                height: 600,
                x: 100,
                y: 100,
                maximized: false,
                fullscreen: true,
            };
            if let Ok(data) = serde_json::to_string(&state) {
                let _ = std::fs::write(path, data);
            }
        }
        return;
    }

    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);

    // 防御：窗口正在关闭时 outer_size 可能返回 0，不要用 0 覆盖已有的合法值
    if size.width == 0 || size.height == 0 {
        return;
    }

    let state = SavedWindowState {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized,
        fullscreen: false,
    };

    let app = window.app_handle();
    let Some(path) = window_state_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string(&state) {
        let _ = std::fs::write(path, data);
    }
}

#[cfg(desktop)]
fn restore_window_state(window: &tauri::WebviewWindow) {
    let app = window.app_handle();
    let Some(state) = load_window_state(app) else {
        return;
    };

    // 只在尺寸合理时恢复 size/position，防止保存了异常值导致窗口不可见
    if state.width >= 400 && state.height >= 300 {
        let _ = window.set_size(tauri::PhysicalSize::new(state.width, state.height));
    }
    // position 可能为负（多显示器场景），只在合理范围内恢复
    if state.x > -10000 && state.y > -10000 {
        let _ = window.set_position(tauri::PhysicalPosition::new(state.x, state.y));
    }

    if state.maximized {
        let _ = window.maximize();
    }

    if state.fullscreen {
        let _ = window.set_fullscreen(true);
    }
}

/// 从命令行参数中提取目录路径（右键菜单 "Open with PiUI" 传 %V）
#[cfg(desktop)]
fn extract_directory_from_args(args: &[String]) -> Option<String> {
    for arg in args.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        if std::path::Path::new(arg).is_dir() {
            return Some(arg.clone());
        }
    }
    None
}

#[cfg(desktop)]
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

#[cfg(desktop)]
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

#[cfg(desktop)]
fn create_main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, tauri::Error> {
    if let Some(window) = app.get_webview_window("main") {
        return Ok(window);
    }
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

#[cfg(mobile)]
fn create_main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, tauri::Error> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .expect("main window config missing");
    tauri::WebviewWindowBuilder::from_config(app, &config)?.build()
}

#[cfg(desktop)]
#[tauri::command]
fn desktop_window_ready(window: Window) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn open_new_window(app: tauri::AppHandle, directory: Option<String>) -> Result<(), String> {
    open_new_window_inner(&app, directory)
}

#[cfg(desktop)]
fn open_new_window_inner(app: &tauri::AppHandle, directory: Option<String>) -> Result<(), String> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let label = format!(
        "win-{}",
        COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );

    // 目录先存入 pending，窗口首帧后由前端 get_cli_directory 一次性消费
    if let Some(dir) = &directory {
        if let Some(state) = app.try_state::<OpenDirectoryState>() {
            state.pin(&label, dir.clone());
        }
    }

    let window = configure_desktop_window_builder(WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App("index.html".into()),
    ))
    .title(directory.as_deref().unwrap_or("PiUI"))
    .inner_size(1200.0, 800.0)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;
    finish_desktop_window_setup(&window);
    Ok(())
}

/// 记录每个窗口上一次的全屏状态（按 label），用于检测「退出全屏」这一跳变。
#[cfg(target_os = "macos")]
fn fullscreen_state() -> &'static std::sync::Mutex<std::collections::HashMap<String, bool>> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, bool>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(bridge::BridgeState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 始终新建窗口（类似 VSCode：双击图标 / 右键目录 = 新窗口）
            let dir = extract_directory_from_args(&args);
            let _ = open_new_window_inner(app, dir);
        }))
        .manage(OpenDirectoryState::default())
        .manage(ServiceState::default())
        .plugin(tauri_plugin_decorum::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    save_window_state(window);

                    let is_last = window.app_handle().webview_windows().len() <= 1;
                    let state = window.state::<ServiceState>();
                    if is_last && state.should_confirm_close() {
                        api.prevent_close();
                        let _ = window.emit("close-requested", ());
                    }
                }
                tauri::WindowEvent::Resized(_) => {
                    // macOS：仅在「退出全屏」时重新对齐红绿灯。
                    // 普通缩放时 overlay 模式会自动把红绿灯锚定在左上角，无需干预；
                    // 每帧重算反而会与 AppKit 的 resize 周期错相，导致拖拽卡顿。
                    #[cfg(target_os = "macos")]
                    if let Some(webview) = window.get_webview_window(window.label()) {
                        let is_fs = webview.is_fullscreen().unwrap_or(false);
                        let was_fs = fullscreen_state()
                            .lock()
                            .ok()
                            .map(|mut m| {
                                m.insert(window.label().to_string(), is_fs).unwrap_or(false)
                            })
                            .unwrap_or(false);
                        if was_fs && !is_fs {
                            use tauri_plugin_decorum::WebviewWindowExt;
                            let _ = webview.set_traffic_lights_inset(12.0, 14.0);
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    save_window_state(window);

                    #[cfg(target_os = "macos")]
                    if let Ok(mut states) = fullscreen_state().lock() {
                        states.remove(window.label());
                    }

                    // 窗口销毁时清理该窗口的所有桥接连接
                    window
                        .state::<bridge::BridgeState>()
                        .disconnect_window(window.label());
                }
                tauri::WindowEvent::DragDrop(event) => {
                    match event {
                        tauri::DragDropEvent::Enter { paths, position } => {
                            let paths: Vec<String> = paths
                                .into_iter()
                                .map(|p| p.to_string_lossy().to_string())
                                .collect();
                            let _ = window.emit("file-drop-enter", (paths, position.x, position.y));
                        }
                        tauri::DragDropEvent::Over { position } => {
                            let _ = window.emit("file-drop-over", (position.x, position.y));
                        }
                        tauri::DragDropEvent::Drop { paths, position } => {
                            let paths: Vec<String> = paths
                                .into_iter()
                                .map(|p| p.to_string_lossy().to_string())
                                .collect();
                            let _ = window.emit("file-drop-drop", (paths, position.x, position.y));
                        }
                        tauri::DragDropEvent::Leave => {
                            let _ = window.emit("file-drop-leave", ());
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let main_window = create_main_window(app.handle())?;
            finish_desktop_window_setup(&main_window);
            restore_window_state(&main_window);

            // 冷启动时从 CLI 参数提取目录（右键 "Open with PiUI" / 拖到图标），
            // 存入 pending，前端首帧后 get_cli_directory 一次性消费。
            let args: Vec<String> = std::env::args().collect();
            if let Some(dir) = extract_directory_from_args(&args) {
                if let Some(state) = app.try_state::<OpenDirectoryState>() {
                    state.pin("main", dir);
                }
            }

            #[cfg(debug_assertions)]
            main_window.open_devtools();

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
            dir_state::get_cli_directory,
            commands::utils::get_dropped_paths_info,
            bridge::ws_bridge_connect,
            bridge::ws_bridge_send,
            bridge::ws_bridge_close,
        ]);

    #[cfg(mobile)]
    let builder = builder
        .setup(|app| {
            let _ = create_main_window(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::ws_bridge_connect,
            bridge::ws_bridge_send,
            bridge::ws_bridge_close,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building PiUI desktop client");

    app.run(|app_handle, event| {
        // macOS: 处理 Finder "Open with" / 拖文件夹到 Dock 图标
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if path.is_dir() {
                        let dir = path.to_string_lossy().to_string();
                        // 只有 main 窗口且尚未消费目录时视为冷启动，否则新建窗口
                        let win_count = app_handle.webview_windows().len();
                        if win_count <= 1 {
                            let _ = app_handle.emit("open-directory", dir);
                        } else {
                            let _ = open_new_window_inner(app_handle, Some(dir));
                        }
                    }
                }
            }
        }
        let _ = (app_handle, event);
    });
}
