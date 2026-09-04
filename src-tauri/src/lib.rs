mod menu;
pub mod tasks_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
