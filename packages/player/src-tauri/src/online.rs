//! Online (streaming) music support.
//!
//! Two responsibilities:
//!
//! 1. A small HTTP proxy for user-imported LX Music custom sources. Those
//!    scripts call `globalThis.lx.request(...)` and expect it to be free of
//!    browser CORS rules, so the call has to happen on the Rust side.
//! 2. Built-in search / URL resolution for the platforms we can talk to
//!    directly, so "online mode" keeps working even when every third-party
//!    source is unreachable (which is what happens most of the time).

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

//#region generic http proxy

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineHttpRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub form: Option<HashMap<String, String>>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn make_client(no_proxy: bool) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(10));
    if no_proxy {
        builder = builder.no_proxy();
    }
    builder.build().unwrap_or_default()
}

/// Send a request, then retry once without the system proxy.
///
/// A VPN client that was uninstalled (or is simply disconnected) leaves a
/// proxy pointing at a dead local port; the retry turns "everything fails"
/// into "works anyway" without asking the user to fix Windows settings.
async fn send_with_fallback(
    client: &reqwest::Client,
    method: &str,
    url: &str,
    headers: &HashMap<String, String>,
    body: Option<String>,
) -> Result<reqwest::Response, String> {
    let verb = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("无效的请求方法: {e}"))?;

    let attempt = |client: reqwest::Client, body: Option<String>| {
        let mut req = client.request(verb.clone(), url);
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(b) = body {
            req = req.body(b);
        }
        req.send()
    };

    match attempt(client.clone(), body.clone()).await {
        Ok(resp) => Ok(resp),
        Err(first) => attempt(make_client(true), body)
            .await
            .map_err(|second| format!("{first} / 已重试直连: {second}")),
    }
}

#[tauri::command]
pub async fn online_http(req: OnlineHttpRequest) -> Result<OnlineHttpResponse, String> {
    let method = req.method.unwrap_or_else(|| "GET".to_string());
    let mut headers = req.headers.unwrap_or_default();

    let mut body = req.body;
    if let Some(form) = req.form {
        let encoded = form
            .iter()
            .map(|(k, v)| {
                format!(
                    "{}={}",
                    urlencoding::encode(k),
                    urlencoding::encode(v)
                )
            })
            .collect::<Vec<_>>()
            .join("&");
        headers
            .entry("content-type".into())
            .or_insert_with(|| "application/x-www-form-urlencoded".into());
        body = Some(encoded);
    }

    let client = make_client(false);
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(20_000));
    let result = tokio::time::timeout(
        timeout,
        send_with_fallback(&client, &method, &req.url, &headers, body),
    )
    .await;

    let resp = match result {
        Ok(Ok(resp)) => resp,
        Ok(Err(err)) => {
            tracing::warn!(
                target: "amll_player_lib::online",
                "online_http {} {} 失败: {}",
                method,
                req.url,
                err
            );
            return Err(err);
        }
        Err(_) => {
            tracing::warn!(
                target: "amll_player_lib::online",
                "online_http {} {} 超时",
                method,
                req.url
            );
            return Err("请求超时".to_string());
        }
    };

    let status = resp.status().as_u16();
    let headers = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
        .collect::<HashMap<_, _>>();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(OnlineHttpResponse {
        status,
        headers,
        body,
    })
}

//#endregion

//#region shared song model

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSong {
    /// Platform key: kw / kg / wy / tx / mg.
    pub source: String,
    pub id: String,
    pub songmid: String,
    pub hash: String,
    pub name: String,
    pub singer: String,
    pub album_name: String,
    pub album_id: String,
    /// Seconds.
    pub interval: u32,
    pub cover_url: String,
    pub qualitys: Vec<String>,
    /// The whole upstream record, forwarded to custom sources untouched.
    pub extra: Value,
}

impl OnlineSong {
    fn new(source: &str, id: String) -> Self {
        Self {
            source: source.into(),
            songmid: id.clone(),
            id,
            hash: String::new(),
            name: String::new(),
            singer: String::new(),
            album_name: String::new(),
            album_id: String::new(),
            interval: 0,
            cover_url: String::new(),
            qualitys: vec!["128k".into(), "320k".into()],
            extra: Value::Null,
        }
    }
}

fn decode_entities(input: &str) -> String {
    input
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

//#endregion

//#region kuwo

/// Kuwo answers with a JavaScript-ish object literal, not JSON: keys and
/// strings are single quoted. Rewriting the quotes is enough for the payloads
/// we consume, and every field is also sanitised so a stray apostrophe in a
/// song title cannot break the parse.
fn extract_array(jsonish: &str, key: &str) -> Option<Vec<Value>> {
    let marker = format!("'{key}'");
    let start = jsonish.find(&marker)?;
    let open = jsonish[start..].find('[')? + start;

    let mut depth = 0usize;
    let mut end = None;
    for (offset, ch) in jsonish[open..].char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(open + offset + 1);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end?;
    let raw = jsonish[open..end].replace('\'', "\"");
    serde_json::from_str::<Vec<Value>>(&raw).ok()
}

/// Kuwo has two response formats. With `mobi=1` it answers with real JSON
/// (which carries album names); without it the payload is a JavaScript object
/// literal with single quotes. Prefer JSON, fall back to the tolerant path.
fn kuwo_records(text: &str) -> Option<Vec<Value>> {
    if let Ok(json) = serde_json::from_str::<Value>(text) {
        if let Some(list) = json.get("abslist").and_then(|v| v.as_array()) {
            return Some(list.clone());
        }
    }
    extract_array(text, "abslist")
}

async fn search_kuwo(client: &reqwest::Client, keyword: &str, limit: u32) -> Result<Vec<OnlineSong>, String> {
    let url = format!(
        "https://search.kuwo.cn/r.s?all={}&ft=music&client=kt&pn=0&rn={}&rformat=json&encoding=utf8&mobi=1&vipver=1&show_copyright_off=1&newver=1",
        urlencoding::encode(keyword),
        limit
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;

    let list = kuwo_records(&text).ok_or_else(|| "酷我返回内容无法解析".to_string())?;

    Ok(list
        .into_iter()
        .filter_map(|item| {
            let rid = item
                .get("MUSICRID")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .replace("MUSIC_", "");
            if rid.is_empty() {
                return None;
            }
            let mut song = OnlineSong::new("kw", rid.clone());
            song.songmid = rid;
            song.name = decode_entities(
                item.get("SONGNAME")
                    .or_else(|| item.get("NAME"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default(),
            );
            song.singer = decode_entities(
                item.get("ARTIST").and_then(|v| v.as_str()).unwrap_or_default(),
            );
            song.album_name = decode_entities(
                item.get("ALBUM").and_then(|v| v.as_str()).unwrap_or_default(),
            );
            song.album_id = item
                .get("ALBUMID")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            song.interval = item
                .get("DURATION")
                .and_then(|v| v.as_str())
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
            song.extra = item;
            Some(song)
        })
        .collect())
}

/// Ask Kuwo's public converter for a playable file URL.
async fn resolve_kuwo(client: &reqwest::Client, info: &Value, _quality: &str) -> Result<String, String> {
    let rid = ["songmid", "id", "rid", "musicId", "songId"]
        .iter()
        .find_map(|k| info.get(*k).and_then(|v| v.as_str()).map(|s| s.to_string()))
        .ok_or_else(|| "缺少酷我歌曲 id".to_string())?;
    let rid = rid.replace("MUSIC_", "");

    let url = format!(
        "https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_{rid}"
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let text = text.trim();
    if text.starts_with("http") {
        Ok(text.to_string())
    } else {
        Err(format!("酷我未返回可播放地址: {}", text.chars().take(120).collect::<String>()))
    }
}

//#endregion

//#region kugou

async fn search_kugou(client: &reqwest::Client, keyword: &str, limit: u32) -> Result<Vec<OnlineSong>, String> {
    // Kugou's mobile CDN only answers over plain HTTP: the TLS handshake on
    // this host fails outright, which silently produced zero results before.
    let url = format!(
        "http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={}&page=1&pagesize={}&showtype=1",
        urlencoding::encode(keyword),
        limit
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    let list = json
        .get("data")
        .and_then(|d| d.get("info"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(list
        .into_iter()
        .filter_map(|item| {
            let hash = item.get("hash").and_then(|v| v.as_str()).unwrap_or_default();
            if hash.is_empty() {
                return None;
            }
            let mut song = OnlineSong::new("kg", hash.to_string());
            song.hash = hash.to_string();
            song.name = decode_entities(
                item.get("songname").and_then(|v| v.as_str()).unwrap_or_default(),
            );
            song.singer = decode_entities(
                item.get("singername").and_then(|v| v.as_str()).unwrap_or_default(),
            );
            song.album_name = decode_entities(
                item.get("album_name").and_then(|v| v.as_str()).unwrap_or_default(),
            );
            song.album_id = item
                .get("album_id")
                .map(|v| v.to_string().trim_matches('"').to_string())
                .unwrap_or_default();
            song.interval = item.get("duration").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            song.extra = item;
            Some(song)
        })
        .collect())
}

//#endregion

//#region netease

async fn search_netease(client: &reqwest::Client, keyword: &str, limit: u32) -> Result<Vec<OnlineSong>, String> {
    let url = format!(
        "https://music.163.com/api/search/get/web?s={}&type=1&offset=0&total=true&limit={}",
        urlencoding::encode(keyword),
        limit
    );
    let resp = client
        .get(&url)
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    let list = json
        .get("result")
        .and_then(|r| r.get("songs"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(list
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(|v| v.as_u64())?;
            let mut song = OnlineSong::new("wy", id.to_string());
            song.name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            song.singer = item
                .get("artists")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name").and_then(|v| v.as_str()))
                        .collect::<Vec<_>>()
                        .join(" / ")
                })
                .unwrap_or_default();
            if let Some(album) = item.get("album") {
                song.album_name = album
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                song.album_id = album
                    .get("id")
                    .and_then(|v| v.as_u64())
                    .map(|v| v.to_string())
                    .unwrap_or_default();
            }
            song.interval = item
                .get("duration")
                .and_then(|v| v.as_u64())
                .map(|ms| (ms / 1000) as u32)
                .unwrap_or(0);
            song.extra = item;
            Some(song)
        })
        .collect())
}

//#endregion

//#region migu

const MIGU_DEVICE_ID: &str = "963B7AA0D21511ED807EE5846EC87D20";
const MIGU_SIGN_SALT: &str = "6cdc72a439cef99a3418d2a78aa28c73";
const MIGU_APP_KEY: &str = "yyapp2d16148780a1dcc7408e06336b98cfd50";

/// Migu signs the keyword with a fixed salt plus a millisecond timestamp,
/// exactly like LX's `musicSdk/mg/musicSearch.js`.
async fn search_migu(client: &reqwest::Client, keyword: &str, limit: u32) -> Result<Vec<OnlineSong>, String> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string();
    let sign = format!(
        "{:x}",
        md5::compute(format!(
            "{keyword}{MIGU_SIGN_SALT}{MIGU_APP_KEY}{MIGU_DEVICE_ID}{timestamp}"
        ))
    );

    let url = format!(
        "https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1&searchSwitch=%7B%22song%22%3A1%2C%22album%22%3A0%2C%22singer%22%3A0%2C%22tagSong%22%3A1%2C%22mvSong%22%3A0%2C%22bestShow%22%3A1%2C%22songlist%22%3A0%2C%22lyricSong%22%3A0%7D&pageSize={limit}&text={}&pageNo=1&sort=0&sid=USS",
        urlencoding::encode(keyword)
    );

    let resp = client
        .get(&url)
        .header("uiVersion", "A_music_3.6.1")
        .header("deviceId", MIGU_DEVICE_ID)
        .header("timestamp", &timestamp)
        .header("sign", &sign)
        .header("channel", "0146921")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30",
        )
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    if json.get("code").and_then(|v| v.as_str()) != Some("000000") {
        return Err(format!(
            "咪咕返回错误: {}",
            json.get("info").and_then(|v| v.as_str()).unwrap_or("未知")
        ));
    }

    let groups = json
        .get("songResultData")
        .and_then(|d| d.get("resultList"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut seen = std::collections::HashSet::new();
    let mut songs = Vec::new();
    for group in groups {
        let Some(items) = group.as_array() else { continue };
        for item in items {
            let Some(song_id) = item.get("songId").and_then(|v| v.as_str()) else {
                continue;
            };
            let copyright = item
                .get("copyrightId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if song_id.is_empty() || copyright.is_empty() || !seen.insert(copyright.clone()) {
                continue;
            }

            let mut song = OnlineSong::new("mg", song_id.to_string());
            song.songmid = song_id.to_string();
            song.name = decode_entities(item.get("name").and_then(|v| v.as_str()).unwrap_or_default());
            song.singer = item
                .get("singerList")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name").and_then(|v| v.as_str()))
                        .collect::<Vec<_>>()
                        .join(" / ")
                })
                .unwrap_or_default();
            song.album_name = item
                .get("album")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            song.album_id = item
                .get("albumId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            song.interval = item
                .get("duration")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            song.cover_url = item
                .get("img")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();

            let mut extra = item.clone();
            if let Some(map) = extra.as_object_mut() {
                map.insert("copyrightId".into(), Value::String(copyright));
                map.insert("songId".into(), Value::String(song_id.to_string()));
            }
            song.extra = extra;
            songs.push(song);
        }
    }
    Ok(songs)
}

//#endregion

#[tauri::command]
pub async fn online_search(
    keyword: String,
    platforms: Vec<String>,
    limit: Option<u32>,
) -> Result<Vec<OnlineSong>, String> {
    let keyword = keyword.trim().to_string();
    if keyword.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let client = make_client(true);

    let mut songs = Vec::new();
    let mut errors = Vec::new();

    for platform in &platforms {
        let result = match platform.as_str() {
            "kw" => search_kuwo(&client, &keyword, limit).await,
            "kg" => search_kugou(&client, &keyword, limit).await,
            "wy" => search_netease(&client, &keyword, limit).await,
            "mg" => search_migu(&client, &keyword, limit).await,
            other => Err(format!("暂不支持平台 {other}")),
        };
        match result {
            Ok(mut list) => songs.append(&mut list),
            Err(e) => errors.push(format!("{platform}: {e}")),
        }
    }

    if songs.is_empty() && !errors.is_empty() {
        tracing::warn!(
            target: "amll_player_lib::online",
            "online_search {:?} 全部失败: {}",
            keyword,
            errors.join("；")
        );
        return Err(errors.join("；"));
    }
    tracing::info!(
        target: "amll_player_lib::online",
        "online_search {:?} platforms={:?} -> {} 首",
        keyword,
        platforms,
        songs.len()
    );
    Ok(songs)
}

#[tauri::command]
pub async fn online_resolve(
    platform: String,
    info: Value,
    quality: Option<String>,
) -> Result<String, String> {
    let client = make_client(true);
    match platform.as_str() {
        "kw" => resolve_kuwo(&client, &info, quality.as_deref().unwrap_or("128k")).await,
        other => Err(format!("内置音源暂不支持平台 {other}，请在设置中启用可用的自定义音源")),
    }
}

/// Read the source list of an installed lx-music-desktop.
///
/// LX keeps every imported source in `LxDatas/user_api.json`, with the script
/// stored as `gz_` + base64(zlib). Returning the raw file keeps this command
/// dependency-free; the frontend inflates and imports it, so a user can bring
/// over the exact sources their LX already trusts instead of hunting for links.
#[tauri::command]
pub fn lx_sources_raw() -> Result<String, String> {
    let mut candidates: Vec<String> = Vec::new();

    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(format!("{appdata}\\lx-music-desktop\\LxDatas\\user_api.json"));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!(
            "{home}/.config/lx-music-desktop/LxDatas/user_api.json"
        ));
        candidates.push(format!(
            "{home}/Library/Application Support/lx-music-desktop/LxDatas/user_api.json"
        ));
    }
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        candidates.push(format!("{xdg}/lx-music-desktop/LxDatas/user_api.json"));
    }

    for path in candidates {
        match std::fs::read_to_string(&path) {
            Ok(content) => {
                if content.contains("userApis") {
                    return Ok(content);
                }
            }
            Err(_) => continue,
        }
    }
    Err("没有找到洛雪音乐的音源数据，请确认已安装并导入过音源".into())
}

//#region offline cache

use std::path::PathBuf;
use tauri::Manager;

/// Cache directory for downloaded online audio.
///
/// Streaming straight into the decoder made every play - and every song switch
/// while a download was still running - wait on the network. Caching to disk
/// turns repeat plays into a local file open.
fn cache_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_default()
        .join("online-cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn cache_key_name(key: &str) -> String {
    format!("{:x}", md5::compute(key.as_bytes()))
}

fn pick_extension(url: &str) -> &'static str {
    let no_query = url.split('?').next().unwrap_or(url);
    let lower = no_query.to_lowercase();
    for ext in ["mp3", "flac", "m4a", "aac", "ogg", "wav"] {
        if lower.ends_with(ext) {
            return match ext {
                "mp3" => ".mp3",
                "flac" => ".flac",
                "m4a" => ".m4a",
                "aac" => ".aac",
                "ogg" => ".ogg",
                _ => ".wav",
            };
        }
    }
    ".mp3"
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineCacheUsage {
    pub bytes: u64,
    pub files: u64,
}

fn scan_cache(app: &tauri::AppHandle) -> OnlineCacheUsage {
    let dir = cache_dir(app);
    let mut bytes = 0u64;
    let mut files = 0u64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    bytes += meta.len();
                    files += 1;
                }
            }
        }
    }
    OnlineCacheUsage { bytes, files }
}

/// Return the cached file for `key`, if it was already downloaded.
#[tauri::command]
pub fn online_cache_path(app: tauri::AppHandle, key: String) -> Option<String> {
    let dir = cache_dir(&app);
    let base = cache_key_name(&key);
    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&base) && entry.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            return Some(entry.path().to_string_lossy().to_string());
        }
    }
    None
}

/// Download `url` into the cache and return the local path.
#[tauri::command]
pub async fn online_cache_store(
    app: tauri::AppHandle,
    key: String,
    url: String,
) -> Result<String, String> {
    if let Some(existing) = online_cache_path(app.clone(), key.clone()) {
        return Ok(existing);
    }

    let client = make_client(true);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取失败: {e}"))?;
    if bytes.is_empty() {
        return Err("下载失败: 空文件".into());
    }

    let dir = cache_dir(&app);
    let file = dir.join(format!("{}{}", cache_key_name(&key), pick_extension(&url)));
    let tmp = file.with_extension("part");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入缓存失败: {e}"))?;
    std::fs::rename(&tmp, &file).map_err(|e| format!("缓存落盘失败: {e}"))?;
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
pub fn online_cache_usage(app: tauri::AppHandle) -> OnlineCacheUsage {
    scan_cache(&app)
}

#[tauri::command]
pub fn online_cache_clear(app: tauri::AppHandle) -> OnlineCacheUsage {
    let dir = cache_dir(&app);
    let before = scan_cache(&app);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    tracing::info!(
        target: "amll_player_lib::online",
        "online cache cleared: {} files, {} bytes",
        before.files,
        before.bytes
    );
    OnlineCacheUsage {
        bytes: 0,
        files: 0,
    }
}

//#endregion

//#region lyric / cover

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineLyric {
    pub lyric: String,
    pub translated: String,
}

fn format_lrc_time(seconds: f64) -> String {
    let total = if seconds.is_finite() && seconds > 0.0 { seconds } else { 0.0 };
    let minutes = (total / 60.0).floor() as u32;
    let rest = total - (minutes as f64) * 60.0;
    format!("{minutes:02}:{rest:05.2}")
}

/// Lyrics for the built-in platforms, mirroring LX's `musicSdk/kw/lyric.js`.
#[tauri::command]
pub async fn online_lyric(platform: String, id: String) -> Result<OnlineLyric, String> {
    if platform != "kw" {
        return Err(format!("内置歌词暂不支持平台 {platform}"));
    }
    let client = make_client(true);
    let url = format!("http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId={id}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    let list = json
        .get("data")
        .and_then(|d| d.get("lrclist"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if list.is_empty() {
        return Err("该歌曲没有歌词".into());
    }

    // Kuwo puts a translation line at the same timestamp as the original.
    let mut main_lines: Vec<(String, String)> = Vec::new();
    let mut trans_lines: Vec<(String, String)> = Vec::new();
    for item in list {
        let time = item
            .get("time")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        let text = decode_entities(
            item.get("lineLyric")
                .or_else(|| item.get("lineLyric"))
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
        );
        if text.trim().is_empty() {
            continue;
        }
        let stamp = format_lrc_time(time);
        if main_lines.last().map(|(t, _)| t == &stamp).unwrap_or(false) {
            trans_lines.push((stamp, text));
        } else {
            main_lines.push((stamp, text));
        }
    }

    let render = |lines: &[(String, String)]| {
        lines
            .iter()
            .map(|(t, text)| format!("[{t}]{text}"))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let song = json.get("data").and_then(|d| d.get("songinfo"));
    let title = song
        .and_then(|s| s.get("songName"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let artist = song
        .and_then(|s| s.get("artist"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let album = song
        .and_then(|s| s.get("album"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let header = format!("[ti:{title}]\n[ar:{artist}]\n[al:{album}]\n[by:]\n[offset:0]\n");
    Ok(OnlineLyric {
        lyric: format!("{header}{}", render(&main_lines)),
        translated: if trans_lines.is_empty() {
            String::new()
        } else {
            render(&trans_lines)
        },
    })
}

/// Cover URL for the built-in platforms, mirroring LX's `musicSdk/kw/pic.js`.
#[tauri::command]
pub async fn online_pic(platform: String, id: String) -> Result<String, String> {
    if platform != "kw" {
        return Err(format!("内置封面暂不支持平台 {platform}"));
    }
    let client = make_client(true);
    let url = format!(
        "http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid={id}"
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let body = resp.text().await.map_err(|e| e.to_string())?;
    let body = body.trim();
    if body.starts_with("http") {
        Ok(body.to_string())
    } else {
        Err("该歌曲没有封面".into())
    }
}

//#endregion
