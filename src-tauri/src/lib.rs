pub mod libraries;
mod menu;
pub mod tasks_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Where maps are kept, for the settings UI.
#[tauri::command]
fn map_libraries() -> serde_json::Value {
    let current = libraries::read();
    serde_json::json!({
        "home": current.home,
        "extra": current.extra,
        "suggestedHome": libraries::suggested_home().map(|p| p.to_string_lossy().to_string()),
    })
}

/// Set the folder new maps are saved into, and which an agent means by default.
#[tauri::command]
fn set_map_home(path: String) -> Result<(), String> {
    let folder = std::path::Path::new(&path);
    if !folder.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let mut current = libraries::read();
    // Promoting a folder that was already an extra should not leave it listed
    // twice; the MCP server would then refuse to start on a name collision.
    current.extra.retain(|existing| existing != &path);
    current.home = Some(path);
    current.updated_at = now_millis();
    libraries::write(&current).map_err(|err| err.to_string())
}

/// Add another folder worth reading maps from.
#[tauri::command]
fn add_map_library(path: String) -> Result<(), String> {
    let folder = std::path::Path::new(&path);
    if !folder.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let mut current = libraries::read();
    if current.home.as_deref() == Some(path.as_str()) || current.extra.contains(&path) {
        return Ok(());
    }
    current.extra.push(path);
    current.updated_at = now_millis();
    libraries::write(&current).map_err(|err| err.to_string())
}

/// Stop reading a folder. The maps in it are untouched.
#[tauri::command]
fn remove_map_library(path: String) -> Result<(), String> {
    let mut current = libraries::read();
    if current.home.as_deref() == Some(path.as_str()) {
        current.home = None;
    }
    current.extra.retain(|existing| existing != &path);
    current.updated_at = now_millis();
    libraries::write(&current).map_err(|err| err.to_string())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Emitted with a file path when the OS asks the app to open a map.
const OPEN_FILE_EVENT: &str = "open-map-file";

/// Paths handed to the process on launch, ignoring flags.
///
/// macOS delivers a double-clicked file through RunEvent::Opened, but Windows
/// and Linux pass it as an argument, so both routes end at the same event.
fn paths_from_args() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| std::path::Path::new(arg).is_file())
        .collect()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Installed here rather than via `Builder::menu` so the menu can be
            // rebuilt later, when the Open Recent list changes.
            menu::install(app.handle())?;

            // A file given on the command line reaches the webview once it is
            // listening; emitting immediately would land before anything is
            // there to hear it.
            let launch_paths = paths_from_args();
            if !launch_paths.is_empty() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    for path in launch_paths {
                        let _ = tauri::Emitter::emit(&handle, OPEN_FILE_EVENT, path);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            menu::set_recent_maps,
            map_libraries,
            set_map_home,
            add_map_library,
            remove_map_library,
            tasks_bridge::tasks_available,
            tasks_bridge::create_task_from_node,
            tasks_bridge::linked_task
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| {
            // macOS sends a double-clicked or dropped file here, including
            // while the app is already running.
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        let _ = tauri::Emitter::emit(handle, OPEN_FILE_EVENT, path.to_string_lossy().to_string());
                    }
                }
            }
        });
}
