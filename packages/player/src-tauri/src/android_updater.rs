/// Result of checking GitHub Releases for a newer Android APK.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidUpdateResult {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub apk_url: String,
    pub release_url: String,
}

/// Android has no tauri-plugin-updater support (the plugin and its commands
/// are compiled out on mobile), so the desktop updater always errors there.
/// Check the stable GitHub Release directly instead and hand the APK URL to
/// the UI, which opens it in the browser for the user to install.
#[tauri::command]
pub async fn updater_check_android(
    channel: String,
) -> Result<Option<AndroidUpdateResult>, String> {
    let tag = if channel == "dev" {
        "main-player-dev".to_string()
    } else {
        // GitHub's `latest` resolves to the newest non-prerelease, which is
        // exactly the stable channel.
        "latest".to_string()
    };
    let api = format!(
        "https://api.github.com/repos/cuicanx/amll-player/releases/{tag}"
    );
    let client = crate::tls_client::finish(
        reqwest::Client::builder()
            .user_agent("AMLL-Player-Updater")
            .timeout(std::time::Duration::from_secs(20)),
    )
    .map_err(|e| e.to_string())?;

    let release: serde_json::Value = client
        .get(&api)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let tag_name = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version = tag_name.trim_start_matches('v').to_string();
    let current = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();

    // Compare numerically (1.0.10 > 1.0.9) rather than lexicographically.
    let parse = |s: &str| -> Vec<u64> {
        s.split('.')
            .filter_map(|p| p.parse::<u64>().ok())
            .collect::<Vec<_>>()
    };
    let newer = parse(&version) > parse(&current);

    let apk = release
        .get("assets")
        .and_then(|v| v.as_array())
        .and_then(|assets| {
            assets
                .iter()
                .find(|a| {
                    a.get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| n.ends_with(".apk") && n.contains("arm64"))
                        .unwrap_or(false)
                })
                .or_else(|| {
                    assets.iter().find(|a| {
                        a.get("name")
                            .and_then(|n| n.as_str())
                            .map(|n| n.ends_with(".apk"))
                            .unwrap_or(false)
                    })
                })
        });

    let apk_url = apk
        .and_then(|a| a.get("browser_download_url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if newer && apk_url.is_empty() {
        return Err("新版本没有可用的 Android 安装包".to_string());
    }

    Ok(if newer {
        Some(AndroidUpdateResult {
            version,
            current_version: current,
            body: release
                .get("body")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            apk_url,
            release_url: release
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("https://github.com/cuicanx/amll-player/releases")
                .to_string(),
        })
    } else {
        None
    })
}
