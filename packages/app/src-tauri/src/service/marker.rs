use serde::{Deserialize, Serialize};
use std::{fs, io::ErrorKind, path::PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ServiceMarker {
    pub pid: u32,
    pub url: String,
}

fn marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("piui-service.json"))
}

pub(super) fn read(app: &AppHandle) -> Result<Option<ServiceMarker>, String> {
    let path = marker_path(app)?;
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read {}: {error}", path.display())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("invalid service marker at {}: {error}", path.display()))
}

pub(super) fn persist(app: &AppHandle, pid: u32, url: &str) -> Result<(), String> {
    let path = marker_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(&ServiceMarker {
        pid,
        url: url.to_string(),
    })
    .map_err(|error| error.to_string())?;
    fs::write(&path, bytes).map_err(|error| format!("failed to write {}: {error}", path.display()))
}

pub(super) fn clear(app: &AppHandle) {
    if let Ok(path) = marker_path(app) {
        let _ = fs::remove_file(path);
    }
}
