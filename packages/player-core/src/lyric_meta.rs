//! Shared helpers for extracting lyrics from audio container metadata.
//!
//! This module is intentionally dependency-free (std only) so that the exact
//! production logic can be compiled and unit-tested in isolation with
//! `rustc --test lyric_meta.rs`, without a full Tauri/FFmpeg build.
//!
//! Background: `ffmpeg_audio` returns the raw `AVDictionary` keys unchanged
//! (see `decode/demuxer.rs::extract_dict`), so key casing and spelling vary by
//! container: ID3v2 (`lyrics`, `USLT`, `TXXX:LYRICS`), Vorbis Comment / FLAC
//! (`LYRICS`, `UNSYNCED LYRICS`), MP4 (`©lyr`), APEv2 (`Lyrics`), etc.

use std::collections::HashMap;

/// Sidecar lyric file extensions, in priority order.
pub const LYRIC_FILE_EXTENSIONS: &[&str] = &["ttml", "lys", "yrc", "qrc", "eslrc", "lrc"];

/// Reduce a metadata key to a comparable form: lowercase, alphanumeric only.
///
/// Examples: `UNSYNCED LYRICS` -> `unsyncedlyrics`, `©lyr` -> `lyr`,
/// `lyrics-eng` -> `lyricseng`, `TXXX:LYRICS` -> `txxxlyrics`.
pub fn normalize_meta_key(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Case/spelling insensitive metadata lookup.
///
/// `keys` are already-normalized targets (e.g. `&["title"]`). When several raw
/// keys normalize to a target, the lexicographically smallest non-empty value's
/// key wins, making the result deterministic regardless of `HashMap` order.
pub fn get_meta_ci<'a>(metadata: &'a HashMap<String, String>, keys: &[&str]) -> Option<&'a str> {
    let mut best: Option<(&str, &str)> = None;
    for (raw_key, value) in metadata {
        if value.trim().is_empty() || !keys.contains(&normalize_meta_key(raw_key).as_str()) {
            continue;
        }
        match best {
            None => best = Some((raw_key.as_str(), value.as_str())),
            Some((best_key, _)) if raw_key.as_str() < best_key => {
                best = Some((raw_key.as_str(), value.as_str()));
            }
            _ => {}
        }
    }
    best.map(|(_, value)| value)
}

/// Priority of a normalized lyric key. Lower is preferred.
///
/// Returns `None` when the key is not a lyric field at all. Fields such as
/// `LYRICIST` / `LYRICS WRITER` must be rejected: they contain "lyric" but hold
/// a person's name, not lyrics.
fn lyric_key_priority(norm: &str) -> Option<u8> {
    if norm.contains("lyricist")
        || norm.contains("writer")
        || norm.contains("author")
        || norm.contains("composer")
        || norm.contains("lyricsurl")
    {
        return None;
    }

    match norm {
        // Canonical primary lyric fields.
        "lyrics" | "lyric" | "lyr" | "uslt" | "unsyncedlyrics" => Some(0),
        // MP4 atom spelling variants.
        "copyrightedlyr" | "ituneslyrics" => Some(0),
        // Synchronized lyric text, still usable if the demuxer exposes it.
        "sylt" | "syncedlyrics" | "synchronouslyrics" => Some(3),
        _ => {
            // Language/description suffixed primary fields: `lyrics-eng`,
            // `USLT:zh`, `unsyncedlyricsjpn`, `TXXX:LYRICS`.
            if norm.starts_with("lyrics")
                || norm.starts_with("uslt")
                || norm.starts_with("unsyncedlyrics")
            {
                Some(1)
            } else if norm.contains("lyric") && norm.starts_with("txxx") {
                Some(2)
            } else if norm.contains("lyric") {
                // Unknown lyric-ish field. Accept with the lowest priority so
                // we never discard lyrics, but prefer known fields.
                Some(4)
            } else {
                None
            }
        }
    }
}

/// Pick the best embedded lyric from a raw metadata map.
///
/// Returns `Some((format, content))`. A candidate is chosen by
/// (priority, normalized-key length, raw key) to be deterministic: short
/// canonical keys beat language-suffixed ones.
pub fn extract_embedded_lyric(metadata: &HashMap<String, String>) -> Option<(String, String)> {
    let mut best: Option<(u8, usize, &str, &str)> = None; // (priority, key_len, raw_key, value)

    for (raw_key, value) in metadata {
        let content = value.trim();
        if content.is_empty() {
            continue;
        }
        let norm = normalize_meta_key(raw_key);
        let priority = match lyric_key_priority(&norm) {
            Some(p) => p,
            None => continue,
        };
        let key_len = norm.len();
        let better = match best {
            None => true,
            Some((bp, bl, bk, _)) => {
                (priority, key_len, raw_key.as_str()) < (bp, bl, bk)
            }
        };
        if better {
            best = Some((priority, key_len, raw_key.as_str(), content));
        }
    }

    best.map(|(_, _, _, content)| {
        (detect_lyric_format(content).to_string(), content.to_string())
    })
}

/// Resolve the lyric for a song from a sidecar file and/or embedded metadata.
///
/// Policy: a non-empty sidecar file wins (external lyrics are usually of
/// higher quality and this preserves the original behaviour); otherwise fall
/// back to the embedded lyric. Returns `(format, content)`; both are empty
/// when no lyric is available.
pub fn resolve_lyric(
    sidecar: Option<(&str, String)>,
    metadata: &HashMap<String, String>,
) -> (String, String) {
    if let Some((ext, content)) = sidecar {
        if !content.trim().is_empty() {
            return (ext.to_string(), content);
        }
    }
    extract_embedded_lyric(metadata).unwrap_or_else(|| (String::new(), String::new()))
}

/// Return `true` when the text contains an LRC-style `[mm:ss.xx]` timestamp.
fn has_lrc_timestamp(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'[' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut j = start;
        while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b':') {
            j += 1;
        }
        // Require "digits:digits" followed by '.' or ':' or ']'.
        let head = &s[start..j];
        let parts: Vec<&str> = head.split(':').collect();
        let valid_head = parts.len() == 2
            && !parts[0].is_empty()
            && parts[1].len() >= 2
            && parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()));
        if valid_head && j < bytes.len() && matches!(bytes[j], b'.' | b':' | b']') {
            return true;
        }
        i += 1;
    }
    false
}

/// Return `true` for syllable/word level timing markers used by YRC/ESLRC.
fn has_word_timestamp(s: &str) -> bool {
    let bytes = s.as_bytes();
    // YRC: "(12345,120)" ; ESLRC/LYS: "<00:12.34>" or "<1234,120>"
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'(' || b == b'<' {
            let mut has_digit = false;
            let mut has_sep = false;
            for &c in &bytes[i + 1..(i + 16).min(bytes.len())] {
                if c.is_ascii_digit() {
                    has_digit = true;
                } else if matches!(c, b',' | b':' | b'.') {
                    has_sep = true;
                } else if matches!(c, b')' | b'>' | b']' | b'\n') {
                    break;
                }
            }
            if has_digit && has_sep {
                return true;
            }
        }
    }
    false
}

/// Sniff the lyric format from its content.
///
/// Embedded lyrics are frequently NOT LRC (TTML, QRC, YRC...). Previously they
/// were unconditionally labelled `lrc`, which made `parseLrc` silently produce
/// zero lines. Unknown/plain text still falls back to `lrc` so behaviour never
/// regresses.
pub fn detect_lyric_format(content: &str) -> &'static str {
    let s = content.trim_start_matches('\u{feff}').trim();
    if s.is_empty() {
        return "lrc";
    }
    let lower = s.to_ascii_lowercase();

    let is_xml = lower.starts_with("<?xml")
        || lower.starts_with("<tt")
        || lower.contains("<tt:tt")
        || lower.contains("http://www.w3.org/ns/ttml");
    if is_xml {
        return if lower.contains("<qrcinfos") || lower.contains("<qrc") {
            "qrc"
        } else {
            "ttml"
        }
    }
    if lower.starts_with("<qrcinfos") {
        return "qrc";
    }

    // A JSON array is a Lyricify Syllable (.lys) document, not an LRC line.
    if s.starts_with('[') && s.contains('"') && !has_lrc_timestamp(s) {
        return "lys";
    }
    if has_lrc_timestamp(s) && has_word_timestamp(s) {
        return "yrc";
    }
    "lrc"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    const LRC: &str = "[00:01.00]Hello world\n[00:03.50]Second line";

    #[test]
    fn normalize_keys() {
        assert_eq!(normalize_meta_key("UNSYNCED LYRICS"), "unsyncedlyrics");
        assert_eq!(normalize_meta_key("lyrics-eng"), "lyricseng");
        assert_eq!(normalize_meta_key("USLT:zh"), "usltzh");
        assert_eq!(normalize_meta_key("©lyr"), "lyr");
        assert_eq!(normalize_meta_key("TXXX:LYRICS"), "txxxlyrics");
    }

    #[test]
    fn empty_metadata_yields_no_lyric() {
        assert_eq!(extract_embedded_lyric(&map(&[])), None);
        assert_eq!(
            extract_embedded_lyric(&map(&[("LYRICS", "   \n  ")])),
            None
        );
    }

    #[test]
    fn canonical_lowercase_key() {
        let m = map(&[("lyrics", LRC)]);
        assert_eq!(extract_embedded_lyric(&m), Some(("lrc".into(), LRC.into())));
    }

    #[test]
    fn flac_vorbis_uppercase_key() {
        let m = map(&[("TITLE", "Song"), ("LYRICS", LRC)]);
        assert_eq!(extract_embedded_lyric(&m), Some(("lrc".into(), LRC.into())));
    }

    #[test]
    fn unsynced_lyrics_variant() {
        let m = map(&[("UNSYNCED LYRICS", LRC)]);
        assert_eq!(extract_embedded_lyric(&m), Some(("lrc".into(), LRC.into())));
    }

    #[test]
    fn id3_uslt_and_language_suffixed_variants() {
        for key in ["USLT", "USLT:eng", "lyrics-eng", "lyrics:zh", "TXXX:LYRICS"] {
            let m = map(&[(key, LRC)]);
            assert_eq!(
                extract_embedded_lyric(&m),
                Some(("lrc".into(), LRC.into())),
                "key={key}"
            );
        }
    }

    #[test]
    fn mp4_atom_key() {
        let m = map(&[("©lyr", LRC)]);
        assert_eq!(extract_embedded_lyric(&m), Some(("lrc".into(), LRC.into())));
    }

    #[test]
    fn lyricist_is_not_a_lyric() {
        let m = map(&[("LYRICIST", "Taylor Swift"), ("ALBUM", "Speak Now")]);
        assert_eq!(extract_embedded_lyric(&m), None);
        let m2 = map(&[("LYRICS WRITER", "Someone")]);
        assert_eq!(extract_embedded_lyric(&m2), None);
    }

    #[test]
    fn canonical_key_beats_language_suffixed_key() {
        let primary = "[00:01.00]primary";
        let translated = "[00:01.00]translated";
        let m = map(&[("lyrics-eng", translated), ("lyrics", primary)]);
        let got = extract_embedded_lyric(&m).unwrap();
        assert_eq!(got.1, primary);
    }

    #[test]
    fn result_is_deterministic_across_hashmap_orders() {
        let entries = [
            ("lyrics-zh", "[00:01.00]zh"),
            ("USLT", "[00:01.00]uslt"),
            ("TXXX:LYRICS", "[00:01.00]txxx"),
            ("©lyr", "[00:01.00]mp4"),
        ];
        let mut results = std::collections::HashSet::new();
        for _ in 0..32 {
            let mut m = HashMap::new();
            for (k, v) in entries.iter().rev() {
                m.insert(k.to_string(), v.to_string());
            }
            results.insert(extract_embedded_lyric(&m).unwrap().1);
        }
        assert_eq!(results.len(), 1, "selection must not depend on hash order");
    }

    #[test]
    fn case_insensitive_metadata_lookup() {
        let m = map(&[("TITLE", "My Song"), ("ARTIST", "Someone"), ("ALBUM", "X")]);
        assert_eq!(get_meta_ci(&m, &["title"]), Some("My Song"));
        assert_eq!(get_meta_ci(&m, &["artist"]), Some("Someone"));
        assert_eq!(get_meta_ci(&m, &["album"]), Some("X"));
        assert_eq!(get_meta_ci(&m, &["lyrics"]), None);
    }

    #[test]
    fn ttml_content_is_detected() {
        let ttml = "<?xml version=\"1.0\"?><tt xmlns=\"http://www.w3.org/ns/ttml\"><body/></tt>";
        assert_eq!(detect_lyric_format(ttml), "ttml");
        assert_eq!(detect_lyric_format("\u{feff} <tt><body/></tt>"), "ttml");
    }

    #[test]
    fn qrc_content_is_detected() {
        assert_eq!(detect_lyric_format("<?xml version=\"1.0\"?><QrcInfos/>"), "qrc");
    }

    #[test]
    fn yrc_content_is_detected() {
        let yrc = "[11:15.470]想(1115470,120)要(1115590,180)";
        assert_eq!(detect_lyric_format(yrc), "yrc");
    }

    #[test]
    fn json_lys_content_is_detected() {
        let lys = "[{\"text\":\"hello\",\"time\":1000}]";
        assert_eq!(detect_lyric_format(lys), "lys");
    }

    #[test]
    fn plain_lrc_and_plain_text_fall_back_to_lrc() {
        assert_eq!(detect_lyric_format(LRC), "lrc");
        assert_eq!(detect_lyric_format("just some words"), "lrc");
        assert_eq!(detect_lyric_format("  "), "lrc");
    }

    #[test]
    fn ttml_embedded_lyric_keeps_ttml_format() {
        let ttml = "<tt xmlns=\"http://www.w3.org/ns/ttml\"><body/></tt>";
        let m = map(&[("LYRICS", ttml)]);
        let got = extract_embedded_lyric(&m).unwrap();
        assert_eq!(got.0, "ttml");
        assert_eq!(got.1, ttml);
    }

    #[test]
    fn sidecar_wins_over_embedded() {
        let m = map(&[("LYRICS", LRC)]);
        let sidecar = "[00:02.00]external";
        let got = resolve_lyric(Some(("lrc", sidecar.into())), &m);
        assert_eq!(got, ("lrc".into(), sidecar.into()));
    }

    #[test]
    fn empty_sidecar_falls_back_to_embedded() {
        let m = map(&[("LYRICS", LRC)]);
        let got = resolve_lyric(Some(("lrc", "  \n ".into())), &m);
        assert_eq!(got, ("lrc".into(), LRC.into()));
    }

    #[test]
    fn no_sidecar_uses_embedded() {
        let m = map(&[("UNSYNCED LYRICS", LRC)]);
        let got = resolve_lyric(None, &m);
        assert_eq!(got, ("lrc".into(), LRC.into()));
    }

    #[test]
    fn nothing_available_is_empty() {
        let m = map(&[("TITLE", "Song")]);
        assert_eq!(resolve_lyric(None, &m), (String::new(), String::new()));
    }

    #[test]
    fn regression_scanner_path_now_sees_embedded_lyrics() {
        // Models the exact scanner situation: a file with embedded lyrics and
        // no sidecar file. The old process_file() returned ("", "") here.
        let m = map(&[
            ("TITLE", "Mine"),
            ("ARTIST", "Taylor Swift"),
            ("LYRICS", LRC),
        ]);
        let (format, content) = resolve_lyric(None, &m);
        assert_eq!(format, "lrc");
        assert!(!content.is_empty());
        assert_eq!(get_meta_ci(&m, &["title"]), Some("Mine"));
        assert_eq!(get_meta_ci(&m, &["artist"]), Some("Taylor Swift"));
    }
}
