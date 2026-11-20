//! Logging level selection, persisted across restarts.
//!
//! The level is read once at startup (before the subscriber is installed), so
//! changing it takes effect on the next launch. Three levels:
//!   - debug: verbose (amll_player=trace + dependency info) - for diagnosing
//!   - normal: the shipped default, quiet but useful
//!   - off: no log file/stdout output at all (errors still go nowhere)
//!
//! Kept as a plain text file under AppData so it can be read before any Tauri
//! state exists. No new crate features are required.

use std::path::Path;
use tracing::*;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LogLevel {
    Debug,
    Normal,
    Off,
}

impl LogLevel {
    fn as_str(self) -> &'static str {
        match self {
            LogLevel::Debug => "debug",
            LogLevel::Normal => "normal",
            LogLevel::Off => "off",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "debug" | "trace" | "verbose" => LogLevel::Debug,
            "off" | "none" | "disabled" => LogLevel::Off,
            _ => LogLevel::Normal,
        }
    }

    /// The EnvFilter directive installed at startup for this level.
    fn filter_directive(self) -> &'static str {
        match self {
            LogLevel::Debug => {
                "amll_player=trace,amll_player_lib=trace,amll_player_core=trace,wry=info,taskbar_lyric=info,now_playing_controls=info,ffmpeg=info"
            }
            LogLevel::Normal => {
                "amll_player=info,wry=warn,taskbar_lyric=warn,now_playing_controls=warn,ffmpeg=warn"
            }
            LogLevel::Off => "off",
        }
    }
}

pub fn config_path(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join("log-level.conf")
}

pub fn read_level(app_data_dir: &Path) -> LogLevel {
    match std::fs::read_to_string(config_path(app_data_dir)) {
        Ok(text) => LogLevel::from_str(&text),
        Err(_) => LogLevel::Normal,
    }
}

#[tauri::command]
pub fn set_log_level(app: tauri::AppHandle, level: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
    let parsed = LogLevel::from_str(&level);
    std::fs::write(config_path(&dir), parsed.as_str())
        .map_err(|e| format!("无法保存日志等级: {e}"))?;
    info!("日志等级已设置为 {}，下次启动生效", parsed.as_str());
    Ok(parsed.as_str().to_string())
}

/// Called from init_logging: returns the EnvFilter directive for the stored level.
pub fn startup_filter(app_data_dir: &Path) -> &'static str {
    read_level(app_data_dir).filter_directive()
}
