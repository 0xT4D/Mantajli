//! Mantagli desktop shell.
//!
//! Responsibilities: own the window, start and supervise the engine host
//! (a Node process), hand its connection to the UI, keep the Anthropic API key
//! in the OS keychain, and provide native helpers (reveal in folder).
//! All editing, media and rendering logic lives in the engine.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent};

const KEYRING_SERVICE: &str = "studio.mantagli.app";
const KEYRING_USER: &str = "anthropic_api_key";

#[derive(Serialize, Clone, Debug)]
struct EngineConnection {
    port: u16,
    token: String,
}

#[derive(Default)]
struct EngineState {
    conn: Mutex<Option<Result<EngineConnection, String>>>,
    ready: Condvar,
    child: Mutex<Option<Child>>,
}

fn repo_root() -> PathBuf {
    // apps/desktop/src-tauri -> repository root (development builds only)
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

fn stored_api_key() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.is_empty())
}

fn engine_command(app: &tauri::AppHandle) -> Result<Command, String> {
    let mut cmd;
    if cfg!(debug_assertions) {
        let root = repo_root();
        cmd = Command::new("node");
        cmd.arg(root.join("node_modules/tsx/dist/cli.mjs"))
            .arg(root.join("packages/engine/src/main.ts"))
            .current_dir(&root);
    } else {
        let res = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource dir: {e}"))?
            .join("engine");
        let node = if cfg!(windows) { res.join("node.exe") } else { res.join("node") };
        cmd = Command::new(node);
        cmd.arg(res.join("engine.mjs"))
            .env("MANTAGLI_BLENDER_SCRIPT", res.join("blender").join("mantagli_scene.py"))
            .current_dir(&res);
    }
    cmd.arg("--watch-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(key) = stored_api_key() {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

fn start_engine(app: &tauri::AppHandle) {
    let state = app.state::<EngineState>();
    let fail = |msg: String| {
        *state.conn.lock().unwrap() = Some(Err(msg));
        state.ready.notify_all();
    };
    let mut cmd = match engine_command(app) {
        Ok(c) => c,
        Err(e) => return fail(e),
    };
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("Could not start the engine (is Node.js 22+ installed?): {e}")),
    };
    let stdout = child.stdout.take().expect("piped stdout");
    *state.child.lock().unwrap() = Some(child);

    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<EngineState>();
        let reader = BufReader::new(stdout);
        let mut announced = false;
        for line in reader.lines().map_while(Result::ok) {
            if let Some(json) = line.strip_prefix("MANTAGLI_ENGINE_READY ") {
                let parsed: Result<serde_json::Value, _> = serde_json::from_str(json);
                let conn = parsed
                    .map_err(|e| e.to_string())
                    .and_then(|v| {
                        Ok(EngineConnection {
                            port: v["port"].as_u64().ok_or("missing port")? as u16,
                            token: v["token"].as_str().ok_or("missing token")?.to_string(),
                        })
                    });
                *state.conn.lock().unwrap() = Some(conn);
                state.ready.notify_all();
                announced = true;
            } else {
                println!("[engine] {line}");
            }
        }
        if !announced {
            *state.conn.lock().unwrap() = Some(Err("The engine exited during startup; see the console log.".into()));
            state.ready.notify_all();
        }
    });
}

#[tauri::command]
fn engine_connection(state: tauri::State<EngineState>) -> Result<EngineConnection, String> {
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut guard = state.conn.lock().unwrap();
    while guard.is_none() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("Timed out waiting for the engine to start".into());
        }
        guard = state.ready.wait_timeout(guard, left).unwrap().0;
    }
    guard.clone().unwrap()
}

#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    if key.trim().is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry.set_password(key.trim()).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("{path} does not exist"));
    }
    #[cfg(windows)]
    let r = Command::new("explorer").arg(format!("/select,{}", p.display())).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(p.parent().unwrap_or(&p)).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

/// Close the engine's stdin so it saves and exits; kill it if it does not.
fn stop_engine(app: &tauri::AppHandle) {
    let state = app.state::<EngineState>();
    let taken = state.child.lock().unwrap().take();
    if let Some(mut child) = taken {
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState::default())
        .setup(|app| {
            start_engine(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![engine_connection, set_api_key, reveal_path])
        .build(tauri::generate_context!())
        .expect("error while building Mantagli");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_engine(handle);
        }
    });
}
