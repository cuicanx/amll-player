//! Storage usage reporting and safe cleanup for the "storage manager" page.
//!
//! All paths live under AppData. Only disposable data is removed:
//!   - `covers/`      -> orphaned covers only (never files referenced by the DB)
//!   - `logs/`        -> all log files except today's active one
//!   - `music_cache/` -> cached audio copies (Android content:// imports)
//! The database, lyric index, extensions and user settings are never touched.

use serde::Serialize;
use tauri::{AppHandle, Manager, path::BaseDirectory};
use tracing::{info, warn};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    /// Everything the app owns under AppData (files, recursively).
    pub total_bytes: u64,
    /// Covers directory (all files, referenced or not).
    pub cache_bytes: u64,
    /// Log files.
    pub log_bytes: u64,
    /// Cached audio copies.
    pub music_cache_bytes: u64,
    /// Number of files counted.
    pub file_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanResult {
    pub deleted_files: u32,
    pub freed_bytes: u64,
    pub errors: Vec<String>,
}

fn resolve(app: &AppHandle, name: &str) -> std::path::PathBuf {
    app.path()
        .resolve(name, BaseDirectory::AppData)
        .unwrap_or_else(|_| app.path().app_data_dir().unwrap_or_default().join(name))
}

fn dir_size(path: &std::path::Path, count: &mut u64) -> u64 {
    let mut total = 0u64;
    if !path.exists() {
        return 0;
    }
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                total += dir_size(&entry.path(), count);
            } else if meta.is_file() {
                total += meta.len();
                *count += 1;
            }
        }
    }
    total
}

#[tauri::command]
pub fn storage_usage(app: AppHandle) -> StorageUsage {
    let app_data = app.path().app_data_dir().unwrap_or_default();
    let mut count = 0u64;
    let total = dir_size(&app_data, &mut count);
    let cache = dir_size(&resolve(&app, "covers"), &mut 0);
    let logs = dir_size(&resolve(&app, "logs"), &mut 0);
    let music = dir_size(&resolve(&app, "music_cache"), &mut 0);
    StorageUsage {
        total_bytes: total,
        cache_bytes: cache,
        log_bytes: logs,
        music_cache_bytes: music,
        file_count: count,
    }
}

/// Delete files inside a directory, optionally skipping those with a given
/// file-name stem prefix (used to keep today's active log).
fn clear_dir(path: &std::path::Path, keep_prefix: Option<&str>) -> (u32, u64, Vec<String>) {
    let mut deleted = 0;
    let mut freed = 0;
    let mut errors = Vec::new();
    if !path.exists() {
        return (deleted, freed, errors);
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return (deleted, freed, vec![format!("无法读取目录 {}", path.display())]);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(prefix) = keep_prefix
            && name.contains(prefix)
        {
            continue;
        }
        let size = meta.len();
        match std::fs::remove_file(entry.path()) {
            Ok(()) => {
                deleted += 1;
                freed += size;
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }
    (deleted, freed, errors)
}

/// Clean disposable data. Cover files are removed through the existing GC so
/// files still referenced by the database are preserved.
#[tauri::command]
pub async fn storage_clean(
    app: AppHandle,
    clean_covers: bool,
    clean_logs: bool,
    clean_music_cache: bool,
) -> Result<StorageCleanResult, String> {
    let mut result = StorageCleanResult {
        deleted_files: 0,
        freed_bytes: 0,
        errors: Vec::new(),
    };

    if clean_covers {
        // Reuse the reference-aware GC: it never deletes a cover still used by
        // a song or playlist.
        let db_state = app.state::<crate::db::DbConnection>();
        match crate::db::cleanup::run_cover_gc(&*db_state, &app).await {
            Ok(gc) => {
                result.deleted_files += gc.deleted;
                result.errors.extend(gc.errors);
                info!("storage_clean: removed {} orphaned covers", gc.deleted);
            }
            Err(e) => {
                warn!("storage_clean: cover GC failed: {e}");
                result.errors.push(format!("封面清理失败: {e}"));
            }
        }
    }

    if clean_logs {
        // Keep today's active log: the rolling appender still holds its handle.
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let (n, b, errs) = clear_dir(&resolve(&app, "logs"), Some(&today));
        result.deleted_files += n;
        result.freed_bytes += b;
        result.errors.extend(errs);
    }

    if clean_music_cache {
        let (n, b, errs) = clear_dir(&resolve(&app, "music_cache"), None);
        result.deleted_files += n;
        result.freed_bytes += b;
        result.errors.extend(errs);
    }

    Ok(result)
}
