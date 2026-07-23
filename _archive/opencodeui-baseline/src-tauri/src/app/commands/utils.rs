use crate::app::dir_state::OpenDirectoryState;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
pub struct DroppedPathInfo {
    #[serde(rename = "type")]
    kind: &'static str,
    path: String,
    name: String,
}

/// 获取启动时传入的目录路径（一次性读取后清空）
#[tauri::command]
pub fn get_cli_directory(
    window: tauri::Window,
    state: State<'_, OpenDirectoryState>,
) -> Option<Arc<str>> {
    state.pending().pin().remove(window.label()).cloned()
}

/// 新建桌面窗口
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn open_new_window(app: tauri::AppHandle, directory: Option<String>) {
    crate::app::create_new_window(&app, directory);
}

/// 桌面窗口前端首帧完成后，通知 Rust 显示真实窗口并关闭 loading 窗口
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn desktop_window_ready(window: tauri::Window) -> Result<(), String> {
    crate::app::mark_window_ready(&window).map_err(|err| err.to_string())
}

/// 获取拖入路径的基础信息，用于前端区分文件/目录并生成 @ 引用。
#[tauri::command]
pub fn get_dropped_paths_info(paths: Vec<String>) -> Vec<DroppedPathInfo> {
    paths
        .into_iter()
        .filter_map(|path| {
            let metadata = std::fs::metadata(&path).ok()?;
            let kind = if metadata.is_dir() {
                "folder"
            } else if metadata.is_file() {
                "file"
            } else {
                return None;
            };

            let name = std::path::Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| path.clone());

            Some(DroppedPathInfo { kind, path, name })
        })
        .collect()
}
