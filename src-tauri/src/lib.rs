mod menu;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![menu::set_recent_maps])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
