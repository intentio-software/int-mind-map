//! The native application menu.
//!
//! Menu items do not act on their own: each one emits a `menu-action` event
//! carrying its id, and the Angular side runs the same handler the in-app
//! controls use. That keeps one implementation of "save" or "export as SVG"
//! rather than a native copy and a web copy that drift apart.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// Event the frontend listens on. The payload is the menu item id.
pub const MENU_EVENT: &str = "menu-action";

/// A recently opened map, as shown under File → Open Recent.
///
/// Only the label is needed here; the frontend matches the click back to a map
/// by the index encoded in the item id.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct RecentEntry {
    pub name: String,
}

/// Build the whole menu bar.
///
/// `recents` is passed in rather than read here because the list lives in the
/// frontend's local storage; the app calls `set_recent_maps` whenever it changes.
pub fn build<R: Runtime>(app: &AppHandle<R>, recents: &[RecentEntry]) -> tauri::Result<Menu<R>> {
    // The About item opens the app's own dialog rather than the system panel,
    // so no `AboutMetadata` is needed here.

    // --- application menu (macOS only; ignored elsewhere) -------------------
    let app_menu = Submenu::with_items(
        app,
        "Intentio Mind Map",
        true,
        &[
            &MenuItem::with_id(app, "about", "About Intentio Mind Map", true, None::<&str>)?,
            &MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // --- File ---------------------------------------------------------------
    let recent_items: Vec<MenuItem<R>> = recents
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            MenuItem::with_id(app, format!("recent:{index}"), &entry.name, true, None::<&str>)
        })
        .collect::<tauri::Result<_>>()?;

    let recent_menu = if recent_items.is_empty() {
        Submenu::with_items(
            app,
            "Open Recent",
            true,
            &[&MenuItem::with_id(app, "recent-empty", "No recent maps", false, None::<&str>)?],
        )?
    } else {
        let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            recent_items.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<R>).collect();
        Submenu::with_items(app, "Open Recent", true, &refs)?
    };

    let export_menu = Submenu::with_items(
        app,
        "Export",
        true,
        &[
            &MenuItem::with_id(app, "export-json", "Export as JSON", true, None::<&str>)?,
            &MenuItem::with_id(app, "export-svg", "Export as SVG", true, None::<&str>)?,
            &MenuItem::with_id(app, "export-mm", "Export as Freeplane (.mm)", true, None::<&str>)?,
            &MenuItem::with_id(app, "export-png", "Export as PNG (transparent)", true, None::<&str>)?,
            &MenuItem::with_id(app, "export-md", "Export as Markdown (.md)", true, None::<&str>)?,
        ],
    )?;

    // Sending to Knowledge is a different act from exporting a file: it writes
    // into a vault the user nominated once and opens the other app.
    let knowledge_menu = Submenu::with_items(
        app,
        "Knowledge",
        true,
        &[
            &MenuItem::with_id(
                app,
                "send-knowledge",
                "Send to Intentio Knowledge",
                true,
                Some("CmdOrCtrl+Shift+K"),
            )?,
            &MenuItem::with_id(app, "set-knowledge-vault", "Set Knowledge Vault…", true, None::<&str>)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new", "New Map", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?,
            &recent_menu,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?,
            &MenuItem::with_id(app, "save-as", "Save As…", true, Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &export_menu,
            &knowledge_menu,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // --- Edit ---------------------------------------------------------------
    //
    // Deliberately no accelerators on these four. Undo, copy and paste all mean
    // different things depending on focus: inside a node's text box the webview
    // must handle them, on the canvas they act on nodes. A menu accelerator is
    // claimed by the OS before the webview sees the key, which would break text
    // editing. The keyboard shortcuts still work — the web layer owns them, and
    // it already knows whether a text box has focus.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, "undo", "Undo", true, None::<&str>)?,
            &MenuItem::with_id(app, "redo", "Redo", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "copy-node", "Copy Node", true, None::<&str>)?,
            &MenuItem::with_id(app, "paste-node", "Paste Node", true, None::<&str>)?,
        ],
    )?;

    // --- View ---------------------------------------------------------------
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "fit", "Fit to Screen", true, Some("CmdOrCtrl+0"))?,
            &MenuItem::with_id(app, "center", "Center Selection", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+Plus"))?,
            &MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "toggle-theme", "Switch Theme", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "about", "About Intentio Mind Map", true, None::<&str>)?,
            &MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "website", "Intentio Software", true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
}

/// Install the menu and forward every click to the frontend.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build(app, &[])?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().as_ref().to_string();
        // The window may already be closing; a failed emit is not worth logging.
        let _ = app.emit(MENU_EVENT, id);
    });

    Ok(())
}

/// Rebuild the menu with a new Open Recent list.
#[tauri::command]
pub fn set_recent_maps<R: Runtime>(app: AppHandle<R>, recents: Vec<RecentEntry>) -> Result<(), String> {
    let menu = build(&app, &recents).map_err(|err| err.to_string())?;
    app.set_menu(menu).map_err(|err| err.to_string())?;
    Ok(())
}
