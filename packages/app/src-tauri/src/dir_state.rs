//! 跨窗口传递「打开目录」请求：single-instance / CLI 参数 / macOS Opened
//! 在窗口创建前到达时先存入 pending，窗口首帧后由前端 get_cli_directory
//! 一次性消费（同一套契约见 OpenCodeUI 的 dir_state.rs）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct OpenDirectoryState {
    pending: Mutex<HashMap<String, Arc<str>>>,
}

impl OpenDirectoryState {
    /// 为指定窗口登记待消费的目录。
    pub fn pin(&self, window_label: &str, directory: impl Into<Arc<str>>) {
        self.pending
            .lock()
            .expect("open directory state poisoned")
            .insert(window_label.to_string(), directory.into());
    }

    /// 一次性读取并移除指定窗口的目录。
    pub fn take(&self, window_label: &str) -> Option<Arc<str>> {
        self.pending
            .lock()
            .expect("open directory state poisoned")
            .remove(window_label)
    }
}

/// 获取启动时传入的目录路径（一次性读取后清空）。
#[tauri::command]
pub fn get_cli_directory(
    window: tauri::Window,
    state: tauri::State<'_, OpenDirectoryState>,
) -> Option<Arc<str>> {
    state.take(window.label())
}
