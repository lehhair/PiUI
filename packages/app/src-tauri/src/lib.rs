use serde::Serialize;
use std::{
    env,
    fs::{self, File},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(not(target_os = "android"))]
use std::{
    fs::{create_dir_all, remove_dir_all, rename},
    io::Read,
};
use tauri::Manager;
#[cfg(not(target_os = "android"))]
use tauri::{WebviewUrl, WebviewWindowBuilder, Window};
#[cfg(not(target_os = "android"))]
use zip::ZipArchive;

struct ServerProcess(Mutex<Option<Child>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalServerConfig {
    url: String,
    token: String,
}

fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

fn resource_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let base = resource_dir(app)?;
    if base.join("piui-runtime.zip").is_file() || base.join("piui-server.exe").is_file() {
        return Some(base);
    }
    let nested = base.join("resources");
    if nested.join("piui-runtime.zip").is_file() || nested.join("piui-server.exe").is_file() {
        return Some(nested);
    }
    Some(base)
}

fn server_binary(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(path) = env::var("PIUI_SERVER_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    let names = if cfg!(target_os = "windows") {
        ["piui-server.exe", "piui-server"]
    } else {
        ["piui-server", "piui-server.exe"]
    };
    let resource = resource_root(app)?;
    names
        .iter()
        .map(|name| resource.join(name))
        .find(|path| path.is_file())
}

#[cfg(not(target_os = "android"))]
fn unpack_runtime(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resource =
        resource_root(app).ok_or_else(|| "resource directory is unavailable".to_string())?;
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

fn start_server(app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        if env::var("PIUI_DESKTOP_EXTERNAL_SERVER").as_deref() == Ok("1") {
            return Ok(());
        }
        let Some(binary) = server_binary(app) else {
            if cfg!(debug_assertions) {
                return Ok(());
            }
            return Err("PiUI server binary was not bundled".to_string());
        };

        let (runtime_dir, native_modules) = unpack_runtime(app)?;
        let resource = resource_root(app).unwrap_or_else(|| {
            binary
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
        });
        let mut command = Command::new(&binary);
        command
            .current_dir(&resource)
            .env("PIUI_HOST", "127.0.0.1")
            .env("PIUI_PORT", "8787")
            .env("PIUI_RUNTIME_DIR", runtime_dir)
            .env("PIUI_NATIVE_MODULES", native_modules)
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        let child = command
            .spawn()
            .map_err(|error| format!("failed to start PiUI server: {error}"))?;
        if let Ok(mut process) = app.state::<ServerProcess>().0.lock() {
            *process = Some(child);
        }
        Ok(())
    }
}

fn auth_token_path() -> Option<PathBuf> {
    let home = if cfg!(target_os = "windows") {
        env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        env::var_os("HOME").map(PathBuf::from)
    }?;
    Some(home.join(".piui").join("auth-token"))
}

#[tauri::command]
fn local_server_config() -> Result<LocalServerConfig, String> {
    let path = auth_token_path().ok_or_else(|| "home directory is unavailable".to_string())?;
    for _ in 0..50 {
        if let Ok(token) = fs::read_to_string(&path) {
            let token = token.trim().to_string();
            if !token.is_empty() {
                return Ok(LocalServerConfig {
                    url: "http://127.0.0.1:8787".to_string(),
                    token,
                });
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "PiUI server token was not ready at {}",
        path.display()
    ))
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn desktop_window_ready(window: Window) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn open_new_window(app: tauri::AppHandle, directory: Option<String>) -> Result<(), String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let label = format!("window-{millis}");
    let title = directory.as_deref().unwrap_or("PiUI");
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1200.0, 800.0)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn stop_server(app: &tauri::AppHandle) {
    if let Ok(mut process) = app.state::<ServerProcess>().0.lock() {
        if let Some(child) = process.as_mut() {
            let _ = child.kill();
        }
        *process = None;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Err(error) = start_server(app.handle()) {
                eprintln!("[piui] failed to start bundled server: {error}");
                return Err(error.into());
            }
            Ok(())
        });

    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        local_server_config,
        desktop_window_ready,
        open_new_window,
    ]);

    #[cfg(target_os = "android")]
    let builder = builder.invoke_handler(tauri::generate_handler![local_server_config]);

    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_decorum::init());

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building PiUI desktop client");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            stop_server(app_handle);
        }
    });
}
