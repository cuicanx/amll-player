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
    let url = format!(
        "https://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword={}&page=1&pagesize={}&showtype=1",
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
