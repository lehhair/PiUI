//! 桌面端工具命令：拖放路径信息、窗口管理辅助。
//! 与 OpenCodeUI 的 commands/utils.rs 对齐（同一套前端契约）。

use serde::Serialize;

#[derive(Serialize)]
pub struct DroppedPathInfo {
    #[serde(rename = "type")]
    kind: &'static str,
    path: String,
    name: String,
}

/// 获取拖入路径的基础信息，用于前端区分文件/目录并生成 @ 引用 / 附件。
/// 前端 tauriDragDrop.ts 在文件拖放后调用；目录返回 folder，文件返回 file。
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
