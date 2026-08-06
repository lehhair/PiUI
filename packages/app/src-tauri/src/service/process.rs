use std::{
    collections::{BTreeMap, VecDeque},
    env,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use tauri::{AppHandle, Manager};

use super::DEFAULT_PORT;

pub(super) struct PreparedServer {
    binary: PathBuf,
    resource: PathBuf,
    native_modules: PathBuf,
}

pub(super) fn service_environment(
    native_modules: Option<&Path>,
    custom: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::from([
        ("PIUI_HOST".to_string(), "127.0.0.1".to_string()),
        ("PIUI_PORT".to_string(), DEFAULT_PORT.to_string()),
        ("PIUI_DRIVER".to_string(), "pi".to_string()),
    ]);
    if let Some(path) = native_modules {
        environment.insert(
            "PIUI_NATIVE_MODULES".to_string(),
            path.display().to_string(),
        );
    }
    environment.extend(
        custom
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    environment
}

pub(super) fn resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    {
        let text = path.to_string_lossy();
        if let Some(stripped) = text.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(stripped));
        }
    }
    Ok(path)
}

fn server_binary(resource: &Path) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("PIUI_SERVER_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let binary = resource.join(if cfg!(target_os = "windows") {
        "pi-worker.exe"
    } else {
        "pi-worker"
    });
    binary.is_file().then_some(binary).ok_or_else(|| {
        format!(
            "PiUI server binary was not bundled in {}",
            resource.display()
        )
    })
}

pub(super) fn prepare_server(app: &AppHandle) -> Result<PreparedServer, String> {
    let resource = resource_root(app)?;
    let binary = server_binary(&resource)?;
    let native_modules = resource.join("node_modules");
    if !native_modules.join("bun-pty").is_dir() {
        return Err(format!(
            "bun-pty was not bundled in {}",
            native_modules.display()
        ));
    }
    Ok(PreparedServer {
        binary,
        resource,
        native_modules,
    })
}

fn spawn_output_reader<R>(reader: R, output: Arc<Mutex<VecDeque<String>>>)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if let Ok(mut recent) = output.lock() {
                if recent.len() >= 24 {
                    recent.pop_front();
                }
                recent.push_back(line);
            }
        }
    });
}

pub(super) fn spawn_server(
    prepared: PreparedServer,
    output: Arc<Mutex<VecDeque<String>>>,
    custom_environment: &BTreeMap<String, String>,
) -> Result<Child, String> {
    let environment = service_environment(Some(&prepared.native_modules), custom_environment);
    let mut command = Command::new(&prepared.binary);
    command
        .arg("web")
        .current_dir(&prepared.resource)
        .envs(environment)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start PiUI server: {error}"))?;
    if let Some(stdout) = child.stdout.take() {
        spawn_output_reader(stdout, output.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_output_reader(stderr, output);
    }
    Ok(child)
}

#[cfg(target_os = "windows")]
pub(super) fn kill_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000);
    let _ = command.status();
}

#[cfg(target_os = "windows")]
pub(super) fn is_process_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("tasklist");
    command
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(0x08000000);
    command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&format!("\",\"{pid}\",")))
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
pub(super) fn kill_process_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(target_os = "windows"))]
pub(super) fn is_process_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}
