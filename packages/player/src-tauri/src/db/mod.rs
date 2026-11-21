pub mod cleanup;
pub mod commands;
pub mod entity;
pub mod migrate;
pub mod migration;
pub mod refresh;
pub mod scanner;
pub mod utils;

use sea_orm::{ConnectionTrait, Database, DatabaseConnection};
use sea_orm_migration::prelude::*;
use tauri::AppHandle;
use tauri::Manager;
use tauri::path::BaseDirectory;

pub type DbConnection = DatabaseConnection;

pub async fn init_database(app: &AppHandle) -> Result<DatabaseConnection, String> {
    let db_path = app
        .path()
        .resolve("amll-player.db", BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve database path: {e}"))?;

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create database directory: {e}"))?;
    }

    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let db = Database::connect(&db_url)
        .await
        .map_err(|e| format!("Failed to connect to database: {e}"))?;

    // SeaORM refuses to start when the DB records a migration that the running
    // binary no longer ships ("...has been applied but its file is missing").
    // This happens when a user applies a migration in one build, then updates
    // to a build whose source tree did not include that migration file - the
    // startup then panics at lib.rs and the app never opens. The column/table
    // already exists in the DB, so it is safe to drop only the stale *record*
    // and retry. Keeps every existing database bootable regardless of which
    // build wrote it.
    apply_migrations_with_orphan_recovery(&db).await?;

    Ok(db)
}

async fn apply_migrations_with_orphan_recovery(db: &DatabaseConnection) -> Result<(), String> {
    for _ in 0..8 {
        match migration::Migrator::up(db, None).await {
            Ok(()) => return Ok(()),
            Err(err) => {
                let text = err.to_string();
                if !text.contains("is missing") || !text.contains("has been applied") {
                    return Err(format!("Failed to run migrations: {text}"));
                }
                // Extract the orphan version between single quotes.
                let orphan = extract_orphan_migration(&text).ok_or_else(|| {
                    format!("Failed to run migrations (orphan version unknown): {text}")
                })?;
                tracing::warn!(
                    target: "amll_player_lib::db",
                    "Dropping stale migration record '{}' not shipped by this build: {}",
                    orphan,
                    text
                );
                let sql = format!("DELETE FROM seaql_migrations WHERE version = '{orphan}'");
                db.execute_unprepared(&sql)
                    .await
                    .map_err(|e| format!("Failed to drop stale migration record: {e}"))?;
                // Loop again: there may be more than one orphan.
            }
        }
    }
    Err("Failed to run migrations: too many stale migration records".into())
}

fn extract_orphan_migration(text: &str) -> Option<String> {
    // Message shape: "Migration file of version 'm20261121_000003_xxx' is missing, ..."
    let start = text.find("version '")? + "version '".len();
    let rest = &text[start..];
    let end = rest.find('\'')?;
    if end == 0 {
        return None;
    }
    Some(rest[..end].to_string())
}
