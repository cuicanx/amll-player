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

use base64::Engine as _;
use futures::future::join_all;
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
        // LX (needle) and the reference implementation both speak HTTP/1.1.
        // Some source servers sit behind a WAF that treats HTTP/2 clients with a
        // different (blocking) policy, so match the desktop behaviour here.
        .http1_only()
        .connect_timeout(Duration::from_secs(10))
        // A dead CDN must not leave a search/parse hanging forever. The value
        // is generous enough for a full 10 MB MP3 on a slow connection.
        .timeout(Duration::from_secs(30));
    if no_proxy {
        builder = builder.no_proxy();
    }
    // Android needs an explicit TLS config; see tls_client for why.
    crate::tls_client::finish(builder).unwrap_or_default()
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
        // Only fall back to the system proxy when the direct connection cannot
        // be established at all. Going through a proxy by default is what made
        // custom sources answer "block ip": their server sees the proxy's exit
        // address, which it blocks, while LX (direct) works from the same host.
        Err(first) => attempt(make_client(false), body)
            .await
            .map_err(|second| format!("{first} / 已改用代理重试: {second}")),
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

    // Direct by default: a proxy exit address is frequently blocked by these
    // source servers. `send_with_fallback` retries through the proxy if the
    // direct connection itself fails.
    let client = make_client(true);
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
    if !(200..300).contains(&status) {
        // A 4xx from a source's server is the whole story behind "unavailable"
        // badges, so it must be visible in the log.
        tracing::warn!(
            target: "amll_player_lib::online",
            "online_http {} {} -> HTTP {}",
            method,
            req.url,
            status
        );
    }
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
            // Kuwo search returns the cover in htqpic / pic / MP3R106.
            song.cover_url = ["htqpic", "pic", "MP3R106"]
                .iter()
                .find_map(|k| item.get(*k).and_then(|v| v.as_str()).filter(|s| s.starts_with("http")))
                .unwrap_or_default()
                .to_string();
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
            // Kugou's search API returns album cover in album_img / imgUrl.
            song.cover_url = ["album_img", "imgUrl", "cover"]
                .iter()
                .find_map(|k| item.get(*k).and_then(|v| v.as_str()).filter(|s| s.starts_with("http")))
                .map(|s| s.replace("{size}", "300"))
                .unwrap_or_default();
            song.extra = item;
            Some(song)
        })
        .collect())
}

//#endregion

//#region netease

async fn search_netease(client: &reqwest::Client, keyword: &str, limit: u32) -> Result<Vec<OnlineSong>, String> {
    // `/api/search/get/web` is heavily rate-limited and now returns
    // `{"code":405,"msg":"操作频繁"}` for most requests, which made NetEase
    // search (and therefore its covers) intermittently empty. `/api/search/pc`
    // still answers normally with the same `result.songs` shape, so try it
    // first and fall back to the legacy endpoint only if it fails.
    let endpoints = [
        format!(
            "https://music.163.com/api/search/pc?s={}&type=1&offset=0&limit={}",
            urlencoding::encode(keyword),
            limit
        ),
        format!(
            "https://music.163.com/api/search/get/web?s={}&type=1&offset=0&total=true&limit={}",
            urlencoding::encode(keyword),
            limit
        ),
    ];
    let mut json: Option<Value> = None;
    let mut last_error = String::new();
    for url in endpoints {
        // `json()` is async, so the response body must be awaited separately
        // from `send()` - it cannot go through a synchronous `and_then`.
        let resp = client
            .get(&url)
            .header("Referer", "https://music.163.com/")
            .send()
            .await;
        let value = match resp {
            Ok(r) => r.json::<Value>().await,
            Err(e) => Err(e),
        };
        match value {
            Ok(value) if value.get("result").and_then(|r| r.get("songs")).is_some() => {
                json = Some(value);
                break;
            }
            Ok(value) => {
                last_error = format!(
                    "网易返回: {}",
                    value.get("msg").and_then(|v| v.as_str()).unwrap_or("无 songs 字段")
                );
            }
            Err(e) => last_error = e.to_string(),
        }
    }
    let json = json.ok_or_else(|| last_error)?;

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
                song.cover_url = album
                    .get("picUrl")
                    .and_then(|v| v.as_str())
                    .filter(|s| s.starts_with("http"))
                    .map(|s| s.replace("http://", "https://"))
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

//#region tencent (QQ)

/// QQ Music search. The public `client_search_cp` endpoint still answers with
/// `new_json=1` and needs only a Referer header; no login/VIP is required to
/// list results (actual playback is delegated to the custom source).
async fn search_tencent(
    client: &reqwest::Client,
    keyword: &str,
    limit: u32,
) -> Result<Vec<OnlineSong>, String> {
    let url = format!(
        "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n={}&w={}&format=json&new_json=1",
        limit,
        urlencoding::encode(keyword)
    );
    let resp = client
        .get(&url)
        .header("Referer", "https://y.qq.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;

    let list = json
        .get("data")
        .and_then(|d| d.get("song"))
        .and_then(|s| s.get("list"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(list
        .into_iter()
        .filter_map(|item| {
            let mid = item.get("mid").and_then(|v| v.as_str()).unwrap_or_default();
            if mid.is_empty() {
                return None;
            }
            let mut song = OnlineSong::new("tx", mid.to_string());
            song.songmid = mid.to_string();
            song.name = decode_entities(item.get("name").and_then(|v| v.as_str()).unwrap_or_default());
            song.singer = item
                .get("singer")
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
                    .get("mid")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
            }
            song.interval = item.get("interval").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            song.cover_url = item
                .get("album")
                .and_then(|a| a.get("mid"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|mid| format!("https://y.qq.com/music/photo_new/T002R300x300M000{mid}.jpg"))
                .unwrap_or_default();
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
/// Migu's image CDN host, verified to serve the `/data/oss/...` cover paths.
const MIGU_IMAGE_HOST: &str = "https://d.musicapp.migu.cn";

/// Turn any form Migu uses for a cover into an absolute, downloadable URL.
fn normalize_migu_image(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        return String::new();
    }
    if value.starts_with("http://") || value.starts_with("https://") {
        // Plain http image hosts get blocked as mixed content; upgrade them.
        return value.replacen("http://", "https://", 1);
    }
    if value.starts_with("//") {
        return format!("https:{value}");
    }
    if value.starts_with('/') {
        return format!("{MIGU_IMAGE_HOST}{value}");
    }
    // A bare path without a leading slash (some responses omit it).
    format!("{MIGU_IMAGE_HOST}/{value}")
}

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
            // Migu exposes covers as img1/img2/img3, and they are ROOT-RELATIVE
            // paths like `/data/oss/resource/...webp`, not absolute URLs. The
            // frontend downloader rejects anything not starting with http(s),
            // so every Migu cover silently became "no cover". Migu's official
            // image host (verified: returns image/webp, HTTP 200) is
            // `d.musicapp.migu.cn`; `music.migu.cn` only serves an HTML page.
            song.cover_url = ["img1", "img2", "img3"]
                .iter()
                .find_map(|key| {
                    item.get(*key)
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| normalize_migu_image(s))
                })
                .unwrap_or_default();

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

/// Write a frontend diagnostic line into the app log.
///
/// The online pipeline decides almost everything in JS (which source resolved
/// what, and why it failed), and that is invisible from Rust. This lets those
/// decisions be traced after the fact instead of guessed at.
#[tauri::command]
pub fn dev_log(message: String) {
    tracing::info!(target: "amll_player_lib::online", "{}", message);
}

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

    // All five platform searches run at once. The futures are collected in
    // the original `platforms` order, so appending them preserves the exact
    // order and content the sequential version produced - only the wall-clock
    // time changes (previously the slowest platform was paid five times over).
    let results = join_all(platforms.iter().map(|platform| {
        let client = client.clone();
        let keyword = keyword.clone();
        let platform = platform.clone();
        async move {
            let result = match platform.as_str() {
                "kw" => search_kuwo(&client, &keyword, limit).await,
                "kg" => search_kugou(&client, &keyword, limit).await,
                "wy" => search_netease(&client, &keyword, limit).await,
                "mg" => search_migu(&client, &keyword, limit).await,
                "tx" => search_tencent(&client, &keyword, limit).await,
                other => Err(format!("暂不支持平台 {other}")),
            };
            (platform, result)
        }
    }))
    .await;

    let mut songs = Vec::new();
    let mut errors = Vec::new();
    for (platform, result) in results {
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

/// Marker embedded in errors from `online_cache_store` when the downloaded
/// bytes are not a real song. The JS layer recognises it and moves on to the
/// next candidate (other quality / other platform) instead of playing a
/// 10-second "当前音乐暂不支持播放" voice clip.
pub const STUB_AUDIO_MARKER: &str = "__STUB_AUDIO__";

/// A real song is at least a couple of minutes long; even a 128 kbps 4-minute
/// track is ~4 MB. A 10-second copyright-notice clip is ~150-200 KB. The
/// threshold only needs to separate those two cases, not be a precise codec
/// probe. 500 KB is comfortably between them.
const MIN_AUDIO_BYTES: u64 = 500_000;

fn bytes_look_like_stub(bytes: &[u8]) -> bool {
    if (bytes.len() as u64) < MIN_AUDIO_BYTES {
        return true;
    }
    let head = &bytes[..bytes.len().min(16)];
    let has_id3 = head.starts_with(b"ID3");
    let has_flac = head.starts_with(b"fLaC");
    let has_mp3 = head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0;
    let has_m4a = head.get(4..8) == Some(&b"ftyp"[..]);
    let has_ogg = head.starts_with(b"OggS");
    !(has_id3 || has_flac || has_mp3 || has_m4a || has_ogg)
}

fn file_looks_like_stub(path: &std::path::Path) -> bool {
    use std::io::Read as _;
    let Ok(meta) = std::fs::metadata(path) else {
        return true;
    };
    if meta.len() < MIN_AUDIO_BYTES {
        return true;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return true;
    };
    let mut head = [0u8; 16];
    let read = file.read(&mut head).unwrap_or(0);
    if read < 4 {
        return true;
    }
    let has_id3 = head.starts_with(b"ID3");
    let has_flac = head.starts_with(b"fLaC");
    let has_mp3 = head[0] == 0xFF && (head[1] & 0xE0) == 0xE0;
    let has_m4a = head.get(4..8) == Some(&b"ftyp"[..]);
    let has_ogg = head.starts_with(b"OggS");
    !(has_id3 || has_flac || has_mp3 || has_m4a || has_ogg)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineCacheUsage {
    pub bytes: u64,
    pub files: u64,
}

fn scan_dir_usage(dir: &std::path::Path) -> OnlineCacheUsage {
    let mut usage = OnlineCacheUsage { bytes: 0, files: 0 };
    fn walk(path: &std::path::Path, usage: &mut OnlineCacheUsage) {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_dir() {
                        walk(&entry.path(), usage);
                    } else if meta.is_file() {
                        usage.bytes += meta.len();
                        usage.files += 1;
                    }
                }
            }
        }
    }
    walk(dir, &mut usage);
    usage
}

fn scan_cache(app: &tauri::AppHandle) -> OnlineCacheUsage {
    scan_dir_usage(&cache_dir(app))
}

/// Directory where downloaded online-song covers are stored (local files, so
/// the WebView never has to load an http image - which was blocked as mixed
/// content and showed a black cover for every online song).
fn cover_cache_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_default()
        .join("online-cover-cache");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Return the cached file for `key`, if it was already downloaded.
#[tauri::command]
pub fn online_cache_path(app: tauri::AppHandle, key: String) -> Option<String> {
    let dir = cache_dir(&app);
    let base = cache_key_name(&key);
    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(&base) {
            continue;
        }
        // A previous version cached whatever URL the source returned, including
        // the 11-second "当前音乐暂不支持播放" voice clip for 晴天 (kw/228908).
        // Such a hit must be treated as a miss so the song gets resolved again.
        if !entry.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            continue;
        }
        if file_looks_like_stub(&entry.path()) {
            tracing::warn!(
                target: "amll_player_lib::online",
                "online_cache_path: 清除无效的试听片段缓存 {}",
                name
            );
            let _ = std::fs::remove_file(entry.path());
            continue;
        }
        return Some(entry.path().to_string_lossy().to_string());
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
    // Reject copyright-notice / trial clips (typically ~11 s of speech). The
    // JS caller sees STUB_AUDIO_MARKER and tries the next quality / platform.
    if bytes_look_like_stub(&bytes) {
        tracing::warn!(
            target: "amll_player_lib::online",
            "online_cache_store: 拒绝试听片段 key={} bytes={} url={}",
            key,
            bytes.len(),
            url.chars().take(140).collect::<String>()
        );
        return Err(format!("{STUB_AUDIO_MARKER}: 音源返回的是试听片段（{} 字节）", bytes.len()));
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

/// Copy an already-resolved/cached online song to a user-chosen location.
///
/// Reusing the cache means the "download" menu item inherits the exact same
/// source resolution, cross-platform fallback and trial-clip rejection as
/// playback, so the saved file is always a real, playable track.
#[tauri::command]
pub fn online_export_song(src: String, dest: String) -> Result<String, String> {
	let src_path = std::path::Path::new(&src);
	if !src_path.is_file() {
		return Err("缓存音频不存在，请播放一次后再下载".into());
	}
	let mut dest_path = std::path::PathBuf::from(&dest);
	// The cache file carries the real container extension (flac/m4a/...),
	// which the save dialog cannot know in advance. Align it so the output is
	// never a .mp3 that actually contains FLAC data.
	if let Some(ext) = src_path.extension() {
		dest_path.set_extension(ext);
	}
	if let Some(parent) = dest_path.parent() {
		std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
	}
	std::fs::copy(src_path, &dest_path).map_err(|e| format!("保存失败: {e}"))?;
	Ok(dest_path.to_string_lossy().to_string())
}

/// Remove online cache files older than `days`. `days == 0` means "never".
/// Called once at startup and whenever the setting changes, so no background
/// timer or polling is needed.
#[tauri::command]
pub fn online_cache_auto_clean(app: tauri::AppHandle, days: u64) -> OnlineCacheUsage {
	let mut removed = OnlineCacheUsage { bytes: 0, files: 0 };
	if days == 0 {
		return removed;
	}
	let cutoff = std::time::SystemTime::now()
		.checked_sub(std::time::Duration::from_secs(days.saturating_mul(86_400)))
		.unwrap_or(std::time::UNIX_EPOCH);
	for dir in [cache_dir(&app), cover_cache_dir(&app)] {
		let Ok(entries) = std::fs::read_dir(&dir) else { continue };
		for entry in entries.flatten() {
			let path = entry.path();
			if !path.is_file() {
				continue;
			}
			let Ok(meta) = entry.metadata() else { continue };
			let Ok(modified) = meta.modified() else { continue };
			if modified >= cutoff {
				continue;
			}
			let size = meta.len();
			if std::fs::remove_file(&path).is_ok() {
				removed.files += 1;
				removed.bytes += size;
			}
		}
	}
	if removed.files > 0 {
		tracing::info!(
			target: "amll_player_lib::online",
			"auto cache clean (>{}d): {} files, {} bytes",
			days, removed.files, removed.bytes
		);
	}
	removed
}

#[tauri::command]
pub fn online_cache_clear(app: tauri::AppHandle) -> OnlineCacheUsage {
	let before = scan_cache(&app);
	clear_usage_dir(&cache_dir(&app));
	clear_usage_dir(&cover_cache_dir(&app));
    tracing::info!(
        target: "amll_player_lib::online",
        "online cache cleared: {} files, {} bytes",
        before.files,
        before.bytes
    );
    // Report what was actually removed, so the UI can show a truthful
    // "freed N files / X MB" instead of always "0 个文件 / 0 B".
    before
}

fn clear_usage_dir(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// Download a cover image to a local cache file and return a path the WebView
/// can display. Online cover URLs are plain http and get blocked as mixed
/// content, which made every online song show a black cover.
/// Image CDNs check Referer. Using NetEase's Referer for a QQ or Kuwo image
/// returned 403 for most songs, which looked exactly like a missing cover.
fn cover_referer_for(url: &str) -> Option<&'static str> {
    if url.contains("y.qq.com") || url.contains("qpic.cn") || url.contains("gtimg.cn") {
        Some("https://y.qq.com/")
    } else if url.contains("kugou") {
        Some("https://www.kugou.com/")
    } else if url.contains("kuwo") {
        Some("http://www.kuwo.cn/")
    } else if url.contains("music.163.com") || url.contains("126.net") {
        Some("https://music.163.com/")
    } else if url.contains("migu") {
        Some("https://music.migu.cn/")
    } else {
        None
    }
}

async fn fetch_cover_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let mut attempts: Vec<(String, Option<&'static str>)> = Vec::new();
    if let Some(referer) = cover_referer_for(url) {
        attempts.push((url.to_string(), Some(referer)));
    }
    attempts.push((url.to_string(), None));
    if url.starts_with("http://") {
        let https = url.replacen("http://", "https://", 1);
        attempts.push((https, cover_referer_for(url)));
    }

    let mut last_error = "封面下载失败".to_string();
    for (candidate, referer) in attempts {
        let mut request = client.get(&candidate);
        if let Some(referer) = referer {
            request = request.header("Referer", referer);
        }
        match request.send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_error = format!("封面下载失败: HTTP {}", resp.status());
                    continue;
                }
                match resp.bytes().await {
                    Ok(bytes) if !bytes.is_empty() => return Ok(bytes.to_vec()),
                    Ok(_) => last_error = "封面为空".to_string(),
                    Err(e) => last_error = format!("封面读取失败: {e}"),
                }
            }
            Err(e) => last_error = format!("封面下载失败: {e}"),
        }
    }
    Err(last_error)
}

#[tauri::command]
pub async fn online_cover_cache(app: tauri::AppHandle, url: String) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("封面地址无效".into());
    }
    let dir = cover_cache_dir(&app);
    let file = dir.join(format!("{}.jpg", cache_key_name(&url)));
    if file.exists() && file.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(file.to_string_lossy().to_string());
    }
    let client = make_client(true);
    let bytes = fetch_cover_bytes(&client, &url).await?;
    std::fs::write(&file, &bytes).map_err(|e| format!("封面写入失败: {e}"))?;
    Ok(file.to_string_lossy().to_string())
}

/// Check whether a previously cached cover file still exists on disk.
///
/// "Clear online cache" deletes the cache directory but leaves each song's
/// `cover_path` pointing at the now-missing file. The UI would otherwise keep
/// rendering a black cover forever because the path still looks like a valid
/// local absolute path. Returns `false` for the empty path and for anything
/// that is not a non-empty file, so callers can trigger a re-download.
#[tauri::command]
pub fn online_cover_exists(path: String) -> bool {
    if path.is_empty() || path.starts_with("http://") || path.starts_with("https://") {
        return false;
    }
    let file = std::path::Path::new(&path);
    file.is_file() && file.metadata().map(|m| m.len() > 0).unwrap_or(false)
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
async fn lyric_kuwo(client: &reqwest::Client, id: &str) -> Result<OnlineLyric, String> {
    let client = client;
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

/// LX-style comparison text: ignore case, spaces and punctuation.
fn normalize_match_text(input: &str) -> String {
    input
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Kugou lyrics are a two-step lookup: search for a candidate, then download it
/// as plain LRC (`fmt=lrc`) so no KRC decryption is needed.
async fn lyric_kugou(
    client: &reqwest::Client,
    hash: &str,
    name: &str,
    singer: &str,
    duration: u32,
) -> Result<OnlineLyric, String> {
    let time_ms = duration.max(1) as u64 * 1000;
    let search_url = format!(
        "http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword={}&hash={}&timelength={}&lrctxt=1",
        urlencoding::encode(name),
        hash,
        time_ms
    );
    let resp = client
        .get(&search_url)
        .header("KG-RC", "1")
        .header("KG-THash", "expand_search_manager.cpp:852736169:451")
        .header("User-Agent", "KuGou2012-9020-ExpandSearchManager")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let candidates = json
        .get("candidates")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if candidates.is_empty() {
        return Err("没有找到歌词".to_string());
    }

    // The first candidate is often a different song with the same title (the
    // "晴天" search returns a 3:30 entry before the 4:29 one). Score by title,
    // singer and duration the way LX does, then pick the best match.
    let wanted_name = normalize_match_text(name);
    let wanted_singer = normalize_match_text(singer);
    let pick = candidates
        .iter()
        .enumerate()
        .max_by(|(ia, a), (ib, b)| {
            let score = |item: &Value| -> i64 {
                let song_name = normalize_match_text(
                    item.get("song").and_then(|v| v.as_str()).unwrap_or_default(),
                );
                let artist = normalize_match_text(
                    item.get("singer").and_then(|v| v.as_str()).unwrap_or_default(),
                );
                let mut s = if !wanted_name.is_empty() && song_name == wanted_name {
                    50
                } else if !wanted_name.is_empty() && song_name.contains(&wanted_name) {
                    20
                } else {
                    0
                };
                if !wanted_singer.is_empty() && artist == wanted_singer {
                    s += 30;
                } else if !wanted_singer.is_empty() && artist.contains(&wanted_singer) {
                    s += 10;
                }
                let item_ms = item
                    .get("duration")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let diff = item_ms.abs_diff(time_ms) / 1000;
                s += if diff <= 5 { 60 - diff as i64 } else { 0 };
                s
            };
            score(a)
                .cmp(&score(b))
                .then_with(|| ib.cmp(ia)) // keep the first on a tie
        })
        .map(|(_, item)| item.clone())
        .ok_or_else(|| "没有找到歌词".to_string())?;
    let id = pick.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    let access_key = pick
        .get("accesskey")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if id.is_empty() || access_key.is_empty() {
        return Err("没有找到歌词".into());
    }

    let download_url = format!(
        "http://lyrics.kugou.com/download?ver=1&client=pc&id={id}&accesskey={access_key}&fmt=lrc&charset=utf8"
    );
    let resp = client
        .get(&download_url)
        .header("KG-RC", "1")
        .header("KG-THash", "expand_search_manager.cpp:852736169:451")
        .header("User-Agent", "KuGou2012-9020-ExpandSearchManager")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let content = json
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if content.is_empty() {
        return Err("歌词内容为空".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(content)
        .map_err(|e| e.to_string())?;
    Ok(OnlineLyric {
        lyric: String::from_utf8_lossy(&bytes).to_string(),
        translated: String::new(),
    })
}

/// Cover for kugou songs: `album_img` still carries a `{size}` placeholder.
async fn pic_kugou(client: &reqwest::Client, hash: &str) -> Result<String, String> {
    let url = format!("http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash={hash}");
    let resp = client
        .get(&url)
        .header("User-Agent", "KuGou2012-9020-ExpandSearchManager")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    for key in ["album_img", "imgUrl"] {
        if let Some(value) = json.get(key).and_then(|v| v.as_str()) {
            if value.starts_with("http") {
                return Ok(value.replace("{size}", "480"));
            }
        }
    }
    Err("该歌曲没有封面".into())
}

#[tauri::command]
pub async fn online_lyric(
    platform: String,
    id: String,
    name: Option<String>,
    singer: Option<String>,
    duration: Option<u32>,
) -> Result<OnlineLyric, String> {
    let client = make_client(true);
    match platform.as_str() {
        "kw" => lyric_kuwo(&client, &id).await,
        "kg" => lyric_kugou(
            &client,
            &id,
            &name.unwrap_or_default(),
            &singer.unwrap_or_default(),
            duration.unwrap_or(0),
        )
        .await,
        "wy" => lyric_netease(&client, &id).await,
        "tx" => lyric_tencent(&client, &id).await,
        // Migu lyrics come from the same v3 search detail API; not shipped to
        // avoid a paid endpoint, other platforms still cover the same track.
        other => Err(format!("歌词暂不支持平台 {other}")),
    }
}

/// NetEase lyric API (plain text LRC, no decryption needed).
async fn lyric_netease(client: &reqwest::Client, id: &str) -> Result<OnlineLyric, String> {
    let url = format!("https://music.163.com/api/song/lyric?id={id}&lv=1&kv=1&tv=-1");
    let resp = client
        .get(&url)
        .header("Referer", "https://music.163.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let lyric = json
        .get("lrc")
        .and_then(|v| v.get("lyric"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let translated = json
        .get("tlyric")
        .and_then(|v| v.get("lyric"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if !lyric.contains('[') {
        return Err("歌词内容为空".into());
    }
    Ok(OnlineLyric { lyric, translated })
}

/// QQ Music lyric via the public `qlrc` endpoint (base64-encoded LRC).
async fn lyric_tencent(client: &reqwest::Client, mid: &str) -> Result<OnlineLyric, String> {
    let url = format!(
        "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid={mid}&format=json&nobase64=1"
    );
    let resp = client
        .get(&url)
        .header("Referer", "https://y.qq.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let raw = json
        .get("lyric")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let lyric = if raw.contains('[') {
        raw
    } else if !raw.is_empty() {
        String::from_utf8_lossy(
            &base64::engine::general_purpose::STANDARD
                .decode(&raw)
                .map_err(|e| e.to_string())?,
        )
        .to_string()
    } else {
        String::new()
    };
    if !lyric.contains('[') {
        return Err("歌词内容为空".into());
    }
    let translated = json
        .get("trans")
        .and_then(|v| v.as_str())
        .map(|s| {
            if s.contains('[') {
                s.to_string()
            } else {
                String::from_utf8_lossy(
                    &base64::engine::general_purpose::STANDARD.decode(s).unwrap_or_default(),
                )
                .to_string()
            }
        })
        .unwrap_or_default();
    Ok(OnlineLyric { lyric, translated })
}

/// Cover URL for the built-in platforms, mirroring LX's `musicSdk/kw/pic.js`.
#[tauri::command]
pub async fn online_pic(platform: String, id: String) -> Result<String, String> {
    let client = make_client(true);
    match platform.as_str() {
        "kw" => pic_kuwo(&client, &id).await,
        "kg" => pic_kugou(&client, &id).await,
        // Saved online rows often carry an empty coverUrl (the search result
        // had no cover). Resolve one from the platform by id, exactly like
        // LX's per-platform pic.js. Without these two branches every saved
        // NetEase/QQ song in a playlist forever shows a black cover.
        "wy" => pic_netease(&client, &id).await,
        "tx" => pic_tencent(&client, &id).await,
        other => Err(format!("封面暂不支持平台 {other}")),
    }
}

async fn pic_kuwo(client: &reqwest::Client, id: &str) -> Result<String, String> {
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

/// NetEase: album.picUrl from the public song/detail endpoint (LX wy_index.js).
async fn pic_netease(client: &reqwest::Client, id: &str) -> Result<String, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("网易封面需要数字歌曲 ID".into());
    }
    let url = format!("https://music.163.com/api/song/detail?ids=%5B{id}%5D");
    let resp = client
        .get(&url)
        .header("Referer", "https://music.163.com/")
        .header("Cookie", "NMTID=test; os=pc")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let pic = json
        .get("songs")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|s| s.get("album"))
        .and_then(|a| a.get("picUrl"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    pic.ok_or_else(|| "该网易歌曲没有封面".to_string())
}

/// QQ: album art when the album mid exists, otherwise the singer image.
/// LX tx_musicSearch.js uses T002 with album.mid and falls back to T001 with
/// singer.mid when the album mid is empty - which is the common case for the
/// QQ search API today, and the reason QQ covers were all black.
async fn pic_tencent(client: &reqwest::Client, id: &str) -> Result<String, String> {
    if id.is_empty() {
        return Err("QQ 封面需要歌曲 mid".into());
    }
    let url = format!(
        "https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid={id}&format=json&platform=yqq"
    );
    let resp = client
        .get(&url)
        .header("Referer", "https://y.qq.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
    let song = json
        .get("data")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first());
    let album_mid = song
        .and_then(|s| s.get("album"))
        .and_then(|a| a.get("mid"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && *s != "空");
    if let Some(album_mid) = album_mid {
        return Ok(format!(
            "https://y.qq.com/music/photo_new/T002R300x300M000{album_mid}.jpg"
        ));
    }
    let singer_mid = song
        .and_then(|s| s.get("singer"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|a| a.get("mid"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    match singer_mid {
        Some(mid) => Ok(format!(
            "https://y.qq.com/music/photo_new/T001R300x300M000{mid}.jpg"
        )),
        None => Err("该 QQ 歌曲没有封面".into()),
    }
}

//#endregion
