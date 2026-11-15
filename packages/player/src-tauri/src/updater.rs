use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Official updater manifest published by the build workflow.
const OFFICIAL_MANIFEST: &str =
    "https://github.com/cuicanx/amll-player/releases/download/main-player-dev/latest.json";

/// Mirrored manifest: identical content, but every download URL inside it is
/// already rewritten to a `gh-proxy.com` direct link. This matters because the
/// official manifest points at `api.github.com/.../releases/assets/<id>`, which
/// answers with a 302 to `release-assets.githubusercontent.com` - a host that
/// is unreachable on plenty of mainland networks passed through a VPN split
/// tunnel. That mismatch is what produced "the update is found but the download
/// always fails".
const MIRROR_MANIFEST: &str = "https://gh-proxy.com/https://github.com/cuicanx/amll-player/releases/download/main-player-dev/latest-mirror.json";

/// Official manifest fetched through the proxy (used when the mirrored
/// manifest has not been published yet for the current build).
const OFFICIAL_MANIFEST_VIA_MIRROR: &str = "https://gh-proxy.com/https://github.com/cuicanx/amll-player/releases/download/main-player-dev/latest.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    version: String,
    current_version: String,
    body: Option<String>,
    date: Option<String>,
    /// Host actually used for the download, so the UI can show where it came
    /// from when someone reports a slow or failed update.
    download_host: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgressPayload {
    downloaded: u64,
    total: Option<u64>,
}

fn endpoint_order(region: &str) -> Vec<&'static str> {
    // `region` is decided in the frontend from the *egress* IP, so it stays
    // correct behind a VPN: a tunnel whose exit node is outside mainland China
    // gets the official download first (fast there, and it never depends on a
    // third-party proxy), everything else prefers the mirror.
    if region == "global" {
        vec![
            OFFICIAL_MANIFEST,
            MIRROR_MANIFEST,
            OFFICIAL_MANIFEST_VIA_MIRROR,
        ]
    } else {
        vec![
            MIRROR_MANIFEST,
            OFFICIAL_MANIFEST_VIA_MIRROR,
            OFFICIAL_MANIFEST,
        ]
    }
}

fn build_updater(
    app: &tauri::AppHandle,
    region: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoints = endpoint_order(region)
        .into_iter()
        .map(|url| tauri::Url::parse(url).map_err(|e| format!("invalid updater endpoint: {e}")))
        .collect::<Result<Vec<_>, String>>()?;

    app.updater_builder()
        .endpoints(endpoints)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

/// Checks for an update against the region-appropriate endpoint list.
#[tauri::command]
pub async fn updater_check(
    app: tauri::AppHandle,
    region: String,
) -> Result<Option<UpdateCheckResult>, String> {
    let updater = build_updater(&app, &region)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    Ok(update.map(|update| UpdateCheckResult {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        body: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
        download_host: update.download_url.host_str().unwrap_or("").to_string(),
    }))
}

/// One download-and-install attempt using a specific endpoint order.
async fn attempt_install(app: &tauri::AppHandle, region: &str) -> Result<(), String> {
    let updater = build_updater(app, region)?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    let app_for_progress = app.clone();
    let mut downloaded: u64 = 0;
    let _ = app.emit("updater://started", ());

    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = app_for_progress.emit(
                    "updater://progress",
                    UpdateProgressPayload { downloaded, total },
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

/// Failures that are worth retrying over the other transport.
///
/// The installer bytes and the manifest are published separately, so a mirror
/// can hand back a body that does not match the signature the manifest
/// announces: a transparent proxy that kept an older copy of the same file
/// name (re-runs of one commit produce the same `0.0.<commitCount>` name), a
/// truncated stream, or an HTML error page served with status 200. All of them
/// surface as "signature verification failed" and are not deterministic - the
/// same retry a second later usually succeeds, especially through the other
/// source. Network-ish errors are retried for the same reason.
fn is_retryable_install_error(message: &str) -> bool {
    let text = message.to_lowercase();
    [
        "signature",
        "verify",
        "verification",
        "decode",
        "corrupt",
        "incomplete",
        "unexpected eof",
        "length",
        "timed out",
        "timeout",
        "connection",
        "reset by peer",
        "broken pipe",
        "failed to download",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// Downloads and installs the pending update, emitting `updater://progress`.
///
/// Doing this in Rust (instead of the JS plugin) is what makes the endpoint
/// choice above apply to the download as well as to the check: the plugin's JS
/// `downloadAndInstall` always uses the manifest configured at build time,
/// while here the manifest - and therefore the download host - is the one we
/// picked for this machine's region.
///
/// A failed attempt is retried once through the *other* transport. Verification
/// happens inside `download_and_install` (it downloads, verifies, then runs the
/// installer), so a bad copy never reaches the system; retrying elsewhere is
/// therefore safe and fixes the most common "sometimes signature fails" case.
#[tauri::command]
pub async fn updater_install(app: tauri::AppHandle, region: String) -> Result<(), String> {
    let primary = if region == "global" { "global" } else { "cn" };
    let secondary = if primary == "global" { "cn" } else { "global" };

    match attempt_install(&app, primary).await {
        Ok(()) => Ok(()),
        Err(first) => {
            if !is_retryable_install_error(&first) {
                return Err(first);
            }
            tracing::warn!(
                "update install failed via {primary}, retrying via {secondary}: {first}"
            );
            let _ = app.emit("updater://retrying", ());
            match attempt_install(&app, secondary).await {
                Ok(()) => Ok(()),
                Err(second) => Err(format!(
                    "{first}（已自动换源重试，仍失败：{second}）"
                )),
            }
        }
    }
}
