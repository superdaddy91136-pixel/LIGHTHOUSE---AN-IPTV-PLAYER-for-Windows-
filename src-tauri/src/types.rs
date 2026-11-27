use std::{
    collections::HashMap,
    sync::{Arc, atomic::AtomicBool},
    thread::JoinHandle,
};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct Channel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    #[serde(default)]
    pub name: String,
    pub url: Option<String>,
    pub group: Option<String>,
    pub image: Option<String>,
    #[serde(default)]
    pub media_type: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<i64>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tv_archive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub season_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub episode_num: Option<i64>,
    pub hidden: Option<bool>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct Season {
    pub id: Option<i64>,
    pub name: String,
    pub season_number: i64,
    pub image: Option<String>,
    pub series_id: u64,
    pub source_id: i64,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct Source {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url_origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    pub source_type: u8,
    pub use_tvg_id: Option<bool>,
    pub enabled: bool,
    pub user_agent: Option<String>,
    pub max_streams: Option<u8>,
    pub stream_user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<i64>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct XtreamStatus {
    #[serde(default)]
    pub user_info: XtreamStatusUserInfo,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct XtreamStatusUserInfo {
    #[serde(default)]
    pub auth: serde_json::Value,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub exp_date: serde_json::Value,
    #[serde(default)]
    pub message: Option<String>,
}

impl XtreamStatusUserInfo {
    pub fn is_auth_successful(&self) -> bool {
        if let Some(status) = &self.status {
            let s = status.trim().to_ascii_lowercase();
            if s == "disabled" || s == "expired" || s == "banned" || s == "inactive" {
                return false;
            }
        }
        match &self.auth {
            serde_json::Value::Number(n) => n.as_i64() == Some(1),
            serde_json::Value::String(s) => s.trim() == "1" || s.trim().eq_ignore_ascii_case("true"),
            serde_json::Value::Bool(b) => *b,
            serde_json::Value::Null => {
                if let Some(status) = &self.status {
                    status.trim().eq_ignore_ascii_case("active")
                } else {
                    false
                }
            }
            _ => false,
        }
    }
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct Settings {
    pub mpv_params: Option<String>,
    pub use_stream_caching: Option<bool>,
    pub volume: Option<u8>,
    #[serde(default)]
    pub remember_volume: Option<bool>,
    pub refresh_on_start: Option<bool>,
    pub restream_port: Option<u16>,
    pub zoom: Option<u16>,
    pub default_sort: Option<u8>,
    pub enable_hwdec: Option<bool>,
    pub enable_gpu: Option<bool>,
    #[serde(default)]
    pub screenshot_path: Option<String>,
    #[serde(default)]
    pub auto_reconnect: Option<bool>,
    #[serde(default)]
    pub reconnect_attempts: Option<u8>,
    #[serde(default)]
    pub default_audio_lang: Option<String>,
    #[serde(default)]
    pub default_subtitle_lang: Option<String>,
    #[serde(default)]
    pub enable_deinterlace: Option<bool>,
    #[serde(default)]
    pub buffer_preset: Option<String>,
    #[serde(default)]
    pub live_start_last_channel: Option<bool>,
    #[serde(default)]
    pub default_live_folder: Option<String>,
    #[serde(default)]
    pub auto_refresh_hours: Option<u16>,
    #[serde(default)]
    pub epg_refresh_hours: Option<u16>,
    #[serde(default)]
    pub remember_window_state: Option<bool>,
    #[serde(default)]
    pub clear_history_on_exit: Option<bool>,
    #[serde(default)]
    pub pin_lock_enabled: Option<bool>,
    #[serde(default)]
    pub app_pin_hash: Option<String>,
    #[serde(default)]
    pub http_proxy: Option<String>,
    #[serde(default)]
    pub overlay_glass_blur: Option<u16>,
    #[serde(default)]
    pub overlay_glass_opacity: Option<u8>,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub keybindings: Option<String>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct Filters {
    pub query: Option<String>,
    pub source_ids: Vec<i64>,
    pub media_types: Option<Vec<u8>>,
    pub view_type: u8,
    pub page: u16,
    pub series_id: Option<i64>,
    pub group_id: Option<i64>,
    pub use_keywords: bool,
    #[serde(default)]
    pub sort: u8,
    pub season: Option<i64>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct ChannelHttpHeaders {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<i64>,
    pub referrer: Option<String>,
    pub user_agent: Option<String>,
    pub http_origin: Option<String>,
    pub ignore_ssl: Option<bool>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct CustomChannel {
    pub data: Channel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<ChannelHttpHeaders>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct Group {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub name: String,
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<i64>,
    pub hidden: Option<bool>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct IdName {
    pub id: i64,
    pub name: String,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct CustomChannelExtraData {
    pub headers: Option<ChannelHttpHeaders>,
    pub group: Option<Group>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct ExportedGroup {
    pub group: Group,
    pub channels: Vec<CustomChannel>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct ExportedSource {
    pub source: Source,
    pub groups: Vec<ExportedGroup>,
    pub channels: Vec<CustomChannel>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct EPG {
    pub epg_id: String,
    pub title: String,
    pub description: String,
    pub start_time: String,
    pub start_timestamp: i64,
    pub end_time: String,
    pub timeshift_url: Option<String>,
    pub has_archive: bool,
    pub now_playing: bool,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct EPGNotify {
    pub epg_id: String,
    pub title: String,
    pub start_timestamp: i64,
    pub channel_name: String,
}

#[derive(Debug, Default)]
pub struct AppState {
    pub notify_stop: Arc<AtomicBool>,
    pub thread_handle: Option<JoinHandle<Result<(), anyhow::Error>>>,
    pub restream_stop_signal: Arc<AtomicBool>,

    pub play_stop: HashMap<i64, IndexMap<String, CancellationToken>>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct NetworkInfo {
    pub port: u16,
    pub local_ips: Vec<String>,
    pub wan_ip: String,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct ChannelPreserve {
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub media_type: u8,
    #[serde(default)]
    pub stream_id: Option<u64>,
    #[serde(default)]
    pub series_id: Option<u64>,
    #[serde(default)]
    pub season_id: Option<i64>,
    #[serde(default)]
    pub episode_num: Option<i64>,
    pub favorite: bool,
    #[serde(default)]
    pub favorite_added: Option<i64>,
    pub last_watched: Option<usize>,
    pub hidden: Option<bool>,
    #[serde(default)]
    pub is_group: bool,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct FavoriteMapping {
    pub name: String,
    #[serde(default)]
    pub media_type: u8,
    #[serde(default)]
    pub stream_id: Option<u64>,
    #[serde(default)]
    pub series_id: Option<u64>,
    #[serde(default)]
    pub season_id: Option<i64>,
    #[serde(default)]
    pub episode_num: Option<i64>,
    #[serde(default)]
    pub favorite_added: Option<i64>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct SourceFavoritesBackup {
    pub source_name: String,
    #[serde(default)]
    pub source_type: Option<u8>,
    pub favorites: Vec<FavoriteMapping>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct SettingsBackup {
    pub version: u32,
    pub exported_at: u64,
    pub settings: Settings,
    #[serde(default)]
    pub startup_page: Option<String>,
    #[serde(default)]
    pub favorites_by_source: Vec<SourceFavoritesBackup>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct BackupRestoreSummary {
    pub settings: Settings,
    pub startup_page: Option<String>,
    pub restored_favorites: usize,
    pub skipped_sources: usize,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct StorageStats {
    pub sqlite_bytes: u64,
    pub history_count: u64,
    pub hidden_count: u64,
    pub favorites_count: u64,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct ProfileSectionCounts {
    pub total: u64,
    pub live: u64,
    pub movies: u64,
    pub series: u64,
    pub groups: u64,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct ProfileCounts {
    pub favorites: ProfileSectionCounts,
    pub history: ProfileSectionCounts,
    pub hidden: ProfileSectionCounts,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct WindowBoundsState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct SourceContentCounts {
    pub live: u64,
    pub movies: u64,
    pub series: u64,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct SourceRefreshProgress {
    pub source_id: i64,
    pub stage: String,
    pub stage_label: String,
    pub percent: Option<f64>,
    pub indeterminate: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct SourceDeviceRefreshStatus {
    pub source_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_successful_refresh: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_eligible_refresh: Option<i64>,
    pub current_status: String,
    pub is_deferred_playback: bool,
    pub is_deferred_metered: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct WatchProgressUpsert {
    pub channel_id: i64,
    pub position_sec: f64,
    pub duration_sec: f64,
    #[serde(default)]
    pub progress_percent: Option<f64>,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub tmdb_id: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub next_ep_channel_id: Option<i64>,
    #[serde(default)]
    pub next_ep_stream_id: Option<i64>,
    #[serde(default)]
    pub next_ep_season_number: Option<i64>,
    #[serde(default)]
    pub next_ep_episode_number: Option<i64>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct LegacyWatchProgressEntry {
    pub channel_id: i64,
    pub position_sec: f64,
    pub duration_sec: f64,
    #[serde(default)]
    pub progress_percent: Option<f64>,
    #[serde(default)]
    pub completed: Option<bool>,
    #[serde(default)]
    pub tmdb_id: Option<i64>,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub next_ep_channel_id: Option<i64>,
    #[serde(default)]
    pub next_ep_stream_id: Option<i64>,
    #[serde(default)]
    pub next_ep_season_number: Option<i64>,
    #[serde(default)]
    pub next_ep_episode_number: Option<i64>,
    #[serde(default)]
    pub fallback_name: Option<String>,
    #[serde(default)]
    pub fallback_series_id: Option<i64>,
    #[serde(default)]
    pub fallback_is_episode: Option<bool>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize, Default)]
pub struct WatchProgressRecord {
    pub identity_key: String,
    pub channel_id: Option<i64>,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub progress_percent: f64,
    pub completed: bool,
    pub updated_at: i64,
    pub last_watched: i64,
    pub tmdb_id: Option<i64>,
}

#[derive(Clone, PartialEq, Debug, Deserialize, Serialize)]
pub struct ContinueWatchingEntry {
    pub channel: Channel,
    pub identity_key: String,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub progress_percent: f64,
    pub completed: bool,
    pub last_watched: i64,
    pub updated_at: i64,
    pub tmdb_id: Option<i64>,
    pub is_episode: bool,
    pub show_title: Option<String>,
    pub season_number: Option<i64>,
    pub episode_number: Option<i64>,
    pub next_episode: Option<Channel>,
}
