//! File dialogs without a parent window handle.
//!
//! The dialog plugin's JS command calls `set_parent(&window)` before opening
//! the native picker. Our main window is borderless and recreated at startup,
//! so that parent HWND is not always valid on Windows: the picker silently
//! fails, the app looks frozen and Windows plays an error chime.
//!
//! These commands run the same blocking pickers on a Tokio worker (the
//! documented context for `blocking_*`) but never set a parent window.

use tauri::{AppHandle, command};
use tauri_plugin_dialog::{DialogExt, FilePath};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickResult {
    pub paths: Vec<String>,
}

fn strings(paths: Vec<FilePath>) -> Vec<String> {
    paths.into_iter().map(|p| p.to_string()).collect()
}

#[command]
pub async fn pick_folder(app: AppHandle, title: Option<String>) -> PickResult {
    let mut builder = app.dialog().file();
    if let Some(title) = title {
        builder = builder.set_title(title);
    }
    // Android/iOS have no folder picker (per Tauri docs). Fall back to the
    // document picker so the call still returns something usable.
    #[cfg(mobile)]
    let paths = builder.blocking_pick_file().into_iter().collect::<Vec<_>>();
    #[cfg(not(mobile))]
    let paths = builder
        .blocking_pick_folder()
        .into_iter()
        .collect::<Vec<_>>();
    PickResult {
        paths: strings(paths),
    }
}

#[command]
pub async fn pick_files(
    app: AppHandle,
    title: Option<String>,
    multiple: Option<bool>,
    extensions: Option<Vec<String>>,
) -> PickResult {
    let mut builder = app.dialog().file();
    if let Some(title) = title {
        builder = builder.set_title(title);
    }
    if let Some(exts) = extensions {
        if !exts.is_empty() {
            let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter("Files", &refs);
        }
    }
    let paths = if multiple.unwrap_or(false) {
        builder.blocking_pick_files().unwrap_or_default()
    } else {
        builder.blocking_pick_file().into_iter().collect::<Vec<_>>()
    };
    PickResult {
        paths: strings(paths),
    }
}

#[command]
pub async fn save_file(
    app: AppHandle,
    title: Option<String>,
    file_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> PickResult {
    let mut builder = app.dialog().file();
    if let Some(title) = title {
        builder = builder.set_title(title);
    }
    if let Some(name) = file_name {
        builder = builder.set_file_name(name);
    }
    if let Some(exts) = extensions {
        if !exts.is_empty() {
            let refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
            builder = builder.add_filter("Files", &refs);
        }
    }
    let paths = builder.blocking_save_file().into_iter().collect::<Vec<_>>();
    PickResult {
        paths: strings(paths),
    }
}
