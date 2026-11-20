use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Official updater manifest published by the build workflow.
const OFFICIAL_MANIFEST: &str =
    "https://github.com/cuicanx/amll-player/releases/download/main-player-dev/latest.json";

/// Mirrored manifest: identical signature, but download URLs rewritten to
/// `gh-proxy.com` direct links.
const MIRROR_MANIFEST: &str = "https://gh-proxy.com/https://github.com/cuicanx/amll-player/releases/download/main-player-dev/latest-mirror.json";

const OFFICIAL_MANIFEST_VIA_MIRROR: &str =
    "https://gh-proxy.com/https://github.com/cuicanx/amll-player/releases/download/main-player-dev/latest.json";

/// Must stay byte-for-byte identical to `plugins.updater.pubkey` in
/// tauri.conf.json. Kept here as a constant so verification does not depend on
/// plugin state - and asserted equal by tests/v2-audit.cjs.
const UPDATER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERDMUY4OTlDMUQ1N0JFNDgKUldSSXZsY2RuSWtmM0Vab0pzZGZPeVZhMXJISlJvZlp5T1BhejFSTHNaQzdKbFQ0SzN5OU5Ka3IK";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    version: String,
    current_version: String,
    body: Option<String>,
    date: Option<String>,
    download_host: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgressPayload {
    downloaded: u64,
    total: Option<u64>,
    /// Bytes per second, computed while streaming. The UI formats it as MB/s.
    speed: Option<u64>,
}

fn endpoint_order(region: &str) -> Vec<&'static str> {
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

    let mut builder = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|e| e.to_string())?;

    // The check uses the plugin's own HTTP client, which reads the SYSTEM proxy.
    // On a machine with a VPN client installed but not connected (or with a
    // split-tunnel rule that leaves github.com behind a dead local proxy), every
    // check fails even though the mirror is directly reachable - this is the
    // "no update shows up without VPN" case. For mainland users the first
    // endpoint is a mirror meant for direct access, so ignore the system proxy
    // exactly as we already do for the download. Overseas/VPN users keep the
    // system proxy so the official source remains reachable.
    if region != "global" {
        builder = builder.no_proxy();
    }

    builder.build().map_err(|e| e.to_string())
}

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

/// Decode a minisign base64 wrapper ("untrusted comment\n<sig>\n...") into the
/// raw key/signature bytes, using the same two-step base64 decoding the
/// updater plugin applies.
fn decode_minisign(encoded: &str) -> Result<String, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("minisign base64 解码失败: {e}"))?;
    let text = String::from_utf8(decoded)
        .map_err(|e| format!("minisign 内容不是 UTF-8: {e}"))?;
    Ok(text)
}

/// Verify downloaded bytes against the manifest signature with OUR public key.
///
/// This is deliberately independent of the updater plugin's internal check: a
/// proxy/CDN can hand back a stale or truncated body with HTTP 200, and the
/// plugin then reports only "signature verification failed". Doing it here lets
/// us reject a bad source and try the next one instead of failing the whole
/// update. A bad copy is NEVER passed to `install()`.
fn verify_download(data: &[u8], release_signature: &str) -> Result<(), String> {
    let pubkey_text = decode_minisign(UPDATER_PUBKEY)?;
    let public_key = PublicKey::decode(&pubkey_text)
        .map_err(|e| format!("更新公钥解析失败: {e}"))?;

    let signature_text = decode_minisign(release_signature)?;
    let signature = Signature::decode(&signature_text)
        .map_err(|e| format!("更新签名解析失败: {e}"))?;

    public_key
        .verify(data, &signature, true)
        .map_err(|e| format!("签名校验失败: {e}"))?;
    Ok(())
}

/// Stream a download into memory, emitting progress with a live speed figure.
/// `no_proxy` matters: the mirror is meant to be reached directly, and routing
/// it through a system VPN proxy is what produced stale/corrupted bodies.
async fn download_bytes(
    app: &tauri::AppHandle,
    url: &str,
    no_proxy: bool,
) -> Result<(Vec<u8>, String), String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("amll-player-updater")
        .timeout(std::time::Duration::from_secs(180));
    if no_proxy {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|e| format!("创建下载客户端失败: {e}"))?;

    let response = client
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("下载失败，HTTP {}", response.status()));
    }

    let total: Option<u64> = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());

    let app_progress = app.clone();
    let mut buffer = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut stream = response.bytes_stream();
    let mut last_report = std::time::Instant::now();
    let mut bytes_since_report: u64 = 0;

    use futures::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        buffer.extend_from_slice(&chunk);
        bytes_since_report += chunk.len() as u64;

        let now = std::time::Instant::now();
        let elapsed = now.duration_since(last_report).as_secs_f64();
        if elapsed >= 0.5 {
            let speed = (bytes_since_report as f64 / elapsed) as u64;
            let _ = app_progress.emit(
                "updater://progress",
                UpdateProgressPayload {
                    downloaded: buffer.len() as u64,
                    total,
                    speed: Some(speed),
                },
            );
            last_report = now;
            bytes_since_report = 0;
        }
    }

    let digest = format!("{:x}", Sha256::digest(&buffer));
    Ok((buffer, digest))
}

/// A failed attempt is worth retrying over a different source when it looks
/// like a bad body rather than a rejected signature from our own key.
fn is_retryable_install_error(message: &str) -> bool {
    let text = message.to_lowercase();
    [
        "signature",
        "verify",
        "verification",
        "decode",
        "non-utf-8",
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
        "下载请求失败",
        "下载中断",
        "下载失败",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// Install the pending update.
///
/// The transfer is performed here, in Rust, for two reasons:
///   1. endpoint selection (region-aware) applies to the download as well as
///      to the check - the JS plugin always uses the build-time manifest;
///   2. every source is verified with our public key before a single byte is
///      handed to the OS installer, so a stale proxy response can never turn
///      into "the update downloaded but verification failed".
///
/// Progress/speed arrive as `updater://progress`; `updater://started` resets
/// the UI and `updater://retrying` marks a source switch.
#[tauri::command]
pub async fn updater_install(app: tauri::AppHandle, region: String) -> Result<(), String> {
    let updater = build_updater(&app, &region)?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    let signature = update.signature.clone();
    let official_url = update.download_url.to_string();

    // Build the source list. The mirror is a gh-proxy wrapper of the same
    // release asset; deriving it from the official URL keeps it in lockstep
    // with whatever version the manifest announces.
    let mirror_url = official_url
        .strip_prefix("https://api.github.com/")
        .map(|path| {
            format!(
                "https://gh-proxy.com/https://api.github.com/{path}",
                path = path
            )
        })
        .unwrap_or_else(|| official_url.clone());

    let mut sources: Vec<(&str, bool)> = if region == "global" {
        // Overseas / VPN exit: official first, mirror as fallback.
        vec![("official", false), ("mirror", true)]
    } else {
        // Mainland / non-overseas VPS: mirror first (direct, no system proxy),
        // official second (may need the system proxy).
        vec![("mirror", true), ("official", false)]
    };
    // `mirror` may equal `official` if the manifest already points at a proxy;
    // keep one entry per distinct physical URL.
    if mirror_url == official_url {
        sources.retain(|(name, _)| *name == "official");
    }

    let mut last_error = String::from("no source attempted");
    for (name, no_proxy) in sources {
        let url = if name == "mirror" {
            &mirror_url
        } else {
            &official_url
        };

        let _ = app.emit("updater://started", ());
        tracing::info!(source = name, url = %url, "downloading update");

        match download_bytes(&app, url, no_proxy).await {
            Ok((bytes, digest)) => {
                tracing::info!(source = name, bytes = bytes.len(), sha256 = %digest, "download complete, verifying");
                match verify_download(&bytes, &signature) {
                    Ok(()) => {
                        return update.install(bytes).map_err(|e| e.to_string());
                    }
                    Err(err) => {
                        tracing::warn!(source = name, sha256 = %digest, "source rejected: {err}");
                        last_error = format!("{name}: {err}");
                        let _ = app.emit("updater://retrying", ());
                    }
                }
            }
            Err(err) => {
                tracing::warn!(source = name, "download failed: {err}");
                last_error = format!("{name}: {err}");
                let _ = app.emit("updater://retrying", ());
            }
        }
    }

    if !is_retryable_install_error(&last_error) {
        return Err(last_error);
    }
    Err(format!(
        "{last_error}（已尝试全部可用更新源，请打开发布页手动安装）"
    ))
}
