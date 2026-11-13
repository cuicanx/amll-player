use crate::AudioInfo;
use crate::lyric_meta::{extract_embedded_lyric, get_meta_ci};
use ffmpeg_audio::AudioReader;

pub fn build_audio_info(reader: &AudioReader) -> AudioInfo {
    let mut info = AudioInfo::default();

    // ffmpeg_audio returns raw AVDictionary keys without normalization, so key
    // casing/spelling differs between ID3v2, Vorbis Comment, MP4 and APEv2.
    // Use the shared case-insensitive helpers instead of one hard-coded key.
    let metadata = reader.metadata();

    info.name = get_meta_ci(&metadata, &["title"])
        .unwrap_or_default()
        .to_string();
    info.artist = get_meta_ci(&metadata, &["artist"])
        .unwrap_or_default()
        .to_string();
    info.album = get_meta_ci(&metadata, &["album"])
        .unwrap_or_default()
        .to_string();
    info.lyric = extract_embedded_lyric(&metadata)
        .map(|(_, content)| content)
        .unwrap_or_default();

    if let Some(cover) = reader.cover() {
        info.cover = Some(cover.data);
        info.cover_media_type = cover.mime_type.unwrap_or_default();
    }

    if let Some(duration) = reader.duration() {
        info.duration = duration.as_secs_f64();
    }

    info
}
