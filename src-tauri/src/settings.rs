use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use directories::UserDirs;

use crate::{
    sql,
    types::{
        BackupRestoreSummary, Settings, SettingsBackup, SourceFavoritesBackup, StorageStats,
        WindowBoundsState,
    },
};

pub const MPV_PARAMS: &str = "mpvParams";
pub const USE_STREAM_CACHING: &str = "useStreamingCaching";
pub const VOLUME: &str = "volume";
pub const REMEMBER_VOLUME: &str = "rememberVolume";
pub const REFRESH_ON_START: &str = "refreshOnStart";
pub const RESTREAM_PORT: &str = "restreamPort";
pub const ZOOM: &str = "zoom";
pub const DEFAULT_SORT: &str = "defaultSort";
pub const ENABLE_HWDEC: &str = "enableHWDEC";
pub const ENABLE_GPU: &str = "enableGPU";
pub const SCREENSHOT_PATH: &str = "screenshotPath";
pub const AUTO_RECONNECT: &str = "autoReconnect";
pub const RECONNECT_ATTEMPTS: &str = "reconnectAttempts";
pub const DEFAULT_AUDIO_LANG: &str = "defaultAudioLang";
pub const DEFAULT_SUBTITLE_LANG: &str = "defaultSubtitleLang";
pub const ENABLE_DEINTERLACE: &str = "enableDeinterlace";
pub const BUFFER_PRESET: &str = "bufferPreset";
pub const LIVE_START_LAST_CHANNEL: &str = "liveStartLastChannel";
pub const DEFAULT_LIVE_FOLDER: &str = "defaultLiveFolder";
pub const AUTO_REFRESH_HOURS: &str = "autoRefreshHours";
pub const EPG_REFRESH_HOURS: &str = "epgRefreshHours";
pub const REMEMBER_WINDOW_STATE: &str = "rememberWindowState";
pub const CLEAR_HISTORY_ON_EXIT: &str = "clearHistoryOnExit";
pub const PIN_LOCK_ENABLED: &str = "pinLockEnabled";
pub const APP_PIN_HASH: &str = "appPinHash";
pub const HTTP_PROXY: &str = "httpProxy";
pub const OVERLAY_GLASS_BLUR: &str = "overlayGlassBlur";
pub const OVERLAY_GLASS_OPACITY: &str = "overlayGlassOpacity";
pub const ACCENT_COLOR: &str = "accentColor";
pub const KEYBINDINGS: &str = "keybindings";
pub const MAIN_WINDOW_STATE: &str = "main_window_state";

pub fn get_settings() -> Result<Settings> {
    let map = sql::get_settings()?;
    let settings = Settings {
        mpv_params: map.get(MPV_PARAMS).map(|s| s.to_string()),
        use_stream_caching: map.get(USE_STREAM_CACHING).and_then(|s| s.parse().ok()),
        volume: map.get(VOLUME).and_then(|s| s.parse().ok()),
        remember_volume: map.get(REMEMBER_VOLUME).and_then(|s| s.parse().ok()),
        refresh_on_start: map.get(REFRESH_ON_START).and_then(|s| s.parse().ok()),
        restream_port: map.get(RESTREAM_PORT).and_then(|s| s.parse().ok()),
        zoom: map.get(ZOOM).and_then(|s| s.parse().ok()),
        default_sort: map.get(DEFAULT_SORT).and_then(|s| s.parse().ok()),
        enable_hwdec: map.get(ENABLE_HWDEC).and_then(|s| s.parse().ok()),
        enable_gpu: map.get(ENABLE_GPU).and_then(|s| s.parse().ok()),
        screenshot_path: map.get(SCREENSHOT_PATH).map(|s| s.to_string()),
        auto_reconnect: map.get(AUTO_RECONNECT).and_then(|s| s.parse().ok()),
        reconnect_attempts: map
            .get(RECONNECT_ATTEMPTS)
            .and_then(|s| s.parse::<u8>().ok())
            .filter(|v| matches!(v, 1 | 3 | 5)),
        default_audio_lang: map.get(DEFAULT_AUDIO_LANG).cloned(),
        default_subtitle_lang: map.get(DEFAULT_SUBTITLE_LANG).cloned(),
        enable_deinterlace: map.get(ENABLE_DEINTERLACE).and_then(|s| s.parse().ok()),
        buffer_preset: map
            .get(BUFFER_PRESET)
            .filter(|v| matches!(v.as_str(), "low" | "balanced" | "smooth"))
            .cloned(),
        live_start_last_channel: map.get(LIVE_START_LAST_CHANNEL).and_then(|s| s.parse().ok()),
        default_live_folder: map
            .get(DEFAULT_LIVE_FOLDER)
            .filter(|v| matches!(v.as_str(), "favorites" | "all" | "recent"))
            .cloned(),
        auto_refresh_hours: map
            .get(AUTO_REFRESH_HOURS)
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|v| matches!(v, 0 | 12 | 24 | 48)),
        epg_refresh_hours: map
            .get(EPG_REFRESH_HOURS)
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|v| matches!(v, 0 | 12 | 24 | 48)),
        remember_window_state: map.get(REMEMBER_WINDOW_STATE).and_then(|s| s.parse().ok()),
        clear_history_on_exit: map.get(CLEAR_HISTORY_ON_EXIT).and_then(|s| s.parse().ok()),
        pin_lock_enabled: map.get(PIN_LOCK_ENABLED).and_then(|s| s.parse().ok()),
        app_pin_hash: map.get(APP_PIN_HASH).cloned(),
        http_proxy: map.get(HTTP_PROXY).cloned(),
        overlay_glass_blur: map
            .get(OVERLAY_GLASS_BLUR)
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|v| *v <= 120),
        overlay_glass_opacity: map
            .get(OVERLAY_GLASS_OPACITY)
            .and_then(|s| s.parse::<u8>().ok())
            .filter(|v| (40..=100).contains(v)),
        accent_color: map.get(ACCENT_COLOR).cloned(),
        keybindings: map.get(KEYBINDINGS).cloned(),
    };
    Ok(settings)
}

pub fn update_settings(settings: Settings) -> Result<()> {
    let mut map: HashMap<String, Option<String>> = HashMap::with_capacity(30);

    map.insert(MPV_PARAMS.to_string(), settings.mpv_params);

    if let Some(use_stream_caching) = settings.use_stream_caching {
        map.insert(
            USE_STREAM_CACHING.to_string(),
            Some(use_stream_caching.to_string()),
        );
    }
    if let Some(volume) = settings.volume {
        map.insert(VOLUME.to_string(), Some(volume.to_string()));
    }
    if let Some(remember_volume) = settings.remember_volume {
        map.insert(
            REMEMBER_VOLUME.to_string(),
            Some(remember_volume.to_string()),
        );
    }
    if let Some(refresh_on_start) = settings.refresh_on_start {
        map.insert(
            REFRESH_ON_START.to_string(),
            Some(refresh_on_start.to_string()),
        );
    }
    if let Some(port) = settings.restream_port {
        map.insert(RESTREAM_PORT.to_string(), Some(port.to_string()));
    }
    if let Some(zoom) = settings.zoom {
        map.insert(ZOOM.to_string(), Some(zoom.to_string()));
    }
    if let Some(sort) = settings.default_sort {
        map.insert(DEFAULT_SORT.to_string(), Some(sort.to_string()));
    }
    if let Some(hwdec) = settings.enable_hwdec {
        map.insert(ENABLE_HWDEC.to_string(), Some(hwdec.to_string()));
    }
    if let Some(gpu) = settings.enable_gpu {
        map.insert(ENABLE_GPU.to_string(), Some(gpu.to_string()));
    }
    map.insert(
        SCREENSHOT_PATH.to_string(),
        settings.screenshot_path.filter(|s| !s.trim().is_empty()),
    );
    if let Some(auto_reconnect) = settings.auto_reconnect {
        map.insert(
            AUTO_RECONNECT.to_string(),
            Some(auto_reconnect.to_string()),
        );
    }
    if let Some(reconnect_attempts) = settings.reconnect_attempts {
        let valid = match reconnect_attempts {
            1 | 3 | 5 => reconnect_attempts,
            _ => 3,
        };
        map.insert(RECONNECT_ATTEMPTS.to_string(), Some(valid.to_string()));
    }
    map.insert(
        DEFAULT_AUDIO_LANG.to_string(),
        settings
            .default_audio_lang
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty()),
    );
    map.insert(
        DEFAULT_SUBTITLE_LANG.to_string(),
        settings
            .default_subtitle_lang
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty()),
    );
    if let Some(deinterlace) = settings.enable_deinterlace {
        map.insert(ENABLE_DEINTERLACE.to_string(), Some(deinterlace.to_string()));
    }
    if let Some(preset) = settings.buffer_preset {
        let valid = match preset.as_str() {
            "low" | "balanced" | "smooth" => preset,
            _ => "balanced".to_string(),
        };
        map.insert(BUFFER_PRESET.to_string(), Some(valid));
    }
    if let Some(start_last) = settings.live_start_last_channel {
        map.insert(
            LIVE_START_LAST_CHANNEL.to_string(),
            Some(start_last.to_string()),
        );
    }
    if let Some(folder) = settings.default_live_folder {
        let valid = match folder.as_str() {
            "favorites" | "all" | "recent" => folder,
            _ => "favorites".to_string(),
        };
        map.insert(DEFAULT_LIVE_FOLDER.to_string(), Some(valid));
    }
    if let Some(hours) = settings.auto_refresh_hours {
        let valid = match hours {
            0 | 12 | 24 | 48 => hours,
            _ => 48,
        };
        map.insert(AUTO_REFRESH_HOURS.to_string(), Some(valid.to_string()));
    }
    if let Some(hours) = settings.epg_refresh_hours {
        let valid = match hours {
            0 | 12 | 24 | 48 => hours,
            _ => 24,
        };
        map.insert(EPG_REFRESH_HOURS.to_string(), Some(valid.to_string()));
    }
    if let Some(rem_win) = settings.remember_window_state {
        map.insert(REMEMBER_WINDOW_STATE.to_string(), Some(rem_win.to_string()));
    }
    if let Some(clear_exit) = settings.clear_history_on_exit {
        map.insert(
            CLEAR_HISTORY_ON_EXIT.to_string(),
            Some(clear_exit.to_string()),
        );
    }
    if let Some(pin_enabled) = settings.pin_lock_enabled {
        map.insert(PIN_LOCK_ENABLED.to_string(), Some(pin_enabled.to_string()));
    }
    if let Some(pin_hash) = settings.app_pin_hash {
        let trimmed = pin_hash.trim().to_string();
        map.insert(
            APP_PIN_HASH.to_string(),
            if trimmed.is_empty() { None } else { Some(trimmed) },
        );
    }
    map.insert(
        HTTP_PROXY.to_string(),
        settings
            .http_proxy
            .map(|s| s.trim().to_string())
            .filter(|s| {
                let lower = s.to_ascii_lowercase();
                !s.is_empty() && (lower.starts_with("http://") || lower.starts_with("https://"))
            }),
    );
    if let Some(blur) = settings.overlay_glass_blur {
        map.insert(
            OVERLAY_GLASS_BLUR.to_string(),
            Some(blur.min(120).to_string()),
        );
    }
    if let Some(opacity) = settings.overlay_glass_opacity {
        map.insert(
            OVERLAY_GLASS_OPACITY.to_string(),
            Some(opacity.clamp(40, 100).to_string()),
        );
    }
    if let Some(accent) = settings.accent_color {
        let trimmed = accent.trim().to_string();
        map.insert(
            ACCENT_COLOR.to_string(),
            if trimmed.is_empty() { None } else { Some(trimmed) },
        );
    }
    if let Some(kb) = settings.keybindings {
        let trimmed = kb.trim().to_string();
        map.insert(
            KEYBINDINGS.to_string(),
            if trimmed.is_empty() { None } else { Some(trimmed) },
        );
    }
    sql::update_settings(map)?;
    Ok(())
}

pub fn get_default_screenshot_path() -> Result<std::path::PathBuf> {
    let user_dirs = UserDirs::new().context("Failed to get user dirs")?;
    let base = user_dirs
        .picture_dir()
        .or_else(|| user_dirs.video_dir())
        .context("No Pictures directory found; please set a screenshot path in Settings")?;
    let path = base.join("Fred TV");
    std::fs::create_dir_all(&path)
        .with_context(|| format!("Failed to create screenshot directory '{}'", path.display()))?;
    Ok(path)
}

/// Persists `volume` (clamped 0..=100) to SQLite only when `remember_volume` is enabled.
pub fn set_remembered_volume(volume: u8) -> Result<bool> {
    let settings = get_settings()?;
    if settings.remember_volume != Some(true) {
        return Ok(false);
    }
    let clamped = volume.min(100);
    let mut map: HashMap<String, Option<String>> = HashMap::with_capacity(1);
    map.insert(VOLUME.to_string(), Some(clamped.to_string()));
    sql::update_settings(map)?;
    Ok(true)
}

fn sanitize_imported_settings(mut incoming: Settings) -> Settings {
    incoming.volume = incoming.volume.map(|v| v.min(100));
    incoming.restream_port = incoming
        .restream_port
        .map(|p| if (1024..=65535).contains(&p) { p } else { 3000 });
    incoming.reconnect_attempts = incoming
        .reconnect_attempts
        .map(|v| if matches!(v, 1 | 3 | 5) { v } else { 3 });
    incoming.mpv_params = incoming
        .mpv_params
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    incoming.screenshot_path = incoming
        .screenshot_path
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    incoming.buffer_preset = incoming
        .buffer_preset
        .filter(|v| matches!(v.as_str(), "low" | "balanced" | "smooth"));
    incoming.default_live_folder = incoming
        .default_live_folder
        .filter(|v| matches!(v.as_str(), "favorites" | "all" | "recent"));
    incoming.auto_refresh_hours = incoming
        .auto_refresh_hours
        .filter(|v| matches!(v, 0 | 12 | 24 | 48));
    incoming.epg_refresh_hours = incoming
        .epg_refresh_hours
        .filter(|v| matches!(v, 0 | 12 | 24 | 48));
    incoming.overlay_glass_blur = incoming.overlay_glass_blur.map(|v| v.min(120));
    incoming.overlay_glass_opacity = incoming.overlay_glass_opacity.map(|v| v.clamp(40, 100));
    // Never import/overwrite local PIN secrets from backup files
    incoming.pin_lock_enabled = None;
    incoming.app_pin_hash = None;
    incoming.http_proxy = incoming.http_proxy.and_then(|s| {
        let trimmed = s.trim().to_string();
        let lower = trimmed.to_ascii_lowercase();
        if !trimmed.is_empty()
            && !trimmed.contains('@')
            && (lower.starts_with("http://") || lower.starts_with("https://"))
        {
            Some(trimmed)
        } else {
            None
        }
    });
    incoming
}

/// Exports app settings and credential-free per-source favorite mappings to a JSON file.
pub fn export_settings_backup(path: String, startup_page: Option<String>) -> Result<usize> {
    let mut settings = get_settings()?;
    // Strip security-sensitive values from exported backups
    settings.pin_lock_enabled = None;
    settings.app_pin_hash = None;
    if let Some(ref proxy) = settings.http_proxy {
        if proxy.contains('@') {
            settings.http_proxy = None;
        }
    }
    let sources = sql::get_sources()?;
    let mut favorites_by_source = Vec::new();
    let mut total_favorites = 0usize;

    sql::do_tx(|tx| {
        for source in &sources {
            if let Some(source_id) = source.id {
                let favorites = sql::get_favorite_mappings(tx, source_id)?;
                if !favorites.is_empty() {
                    total_favorites += favorites.len();
                    favorites_by_source.push(SourceFavoritesBackup {
                        source_name: source.name.clone(),
                        source_type: Some(source.source_type),
                        favorites,
                    });
                }
            }
        }
        Ok(())
    })?;

    let valid_startup = startup_page.filter(|p| {
        matches!(p.as_str(), "home" | "livetv" | "movies" | "tvshows")
    });
    let exported_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let backup = SettingsBackup {
        version: 1,
        exported_at,
        settings,
        startup_page: valid_startup,
        favorites_by_source,
    };

    let json = serde_json::to_string_pretty(&backup)?;
    std::fs::write(&path, json)
        .with_context(|| format!("Failed to write backup file '{}'", path))?;
    Ok(total_favorites)
}

/// Imports app settings and restores matching favorite mappings from a JSON backup file.
pub fn import_settings_backup(path: String) -> Result<BackupRestoreSummary> {
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read backup file '{}'", path))?;
    let backup: SettingsBackup =
        serde_json::from_str(&raw).context("Selected file is not a valid Lighthouse backup")?;
    if backup.version != 1 {
        bail!("Unsupported backup version: {}", backup.version);
    }

    let sanitized = sanitize_imported_settings(backup.settings);
    update_settings(sanitized)?;

    let sources = sql::get_sources()?;
    let mut restored_favorites = 0usize;
    let mut skipped_sources = 0usize;

    if !backup.favorites_by_source.is_empty() {
        sql::do_tx(|tx| {
            for entry in &backup.favorites_by_source {
                let target_source = sources
                    .iter()
                    .find(|s| s.name == entry.source_name)
                    .or_else(|| {
                        let lower = entry.source_name.trim().to_ascii_lowercase();
                        sources
                            .iter()
                            .find(|s| s.name.trim().to_ascii_lowercase() == lower)
                    });
                if let Some(source_id) = target_source.and_then(|s| s.id) {
                    restored_favorites +=
                        sql::restore_favorite_mappings(tx, source_id, &entry.favorites)?;
                } else {
                    skipped_sources += 1;
                }
            }
            Ok(())
        })?;
    }

    let startup_page = backup.startup_page.filter(|p| {
        matches!(p.as_str(), "home" | "livetv" | "movies" | "tvshows")
    });

    Ok(BackupRestoreSummary {
        settings: get_settings()?,
        startup_page,
        restored_favorites,
        skipped_sources,
    })
}

pub fn get_storage_stats() -> Result<StorageStats> {
    let db_path = sql::get_sqlite_db_path();
    let mut sqlite_bytes = std::fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
    sqlite_bytes += std::fs::metadata(format!("{}-wal", db_path))
        .map(|m| m.len())
        .unwrap_or(0);
    sqlite_bytes += std::fs::metadata(format!("{}-shm", db_path))
        .map(|m| m.len())
        .unwrap_or(0);
    let (history_count, hidden_count, favorites_count) = sql::get_storage_counts()?;
    Ok(StorageStats {
        sqlite_bytes,
        history_count,
        hidden_count,
        favorites_count,
    })
}

pub fn get_window_state() -> Option<WindowBoundsState> {
    let raw = sql::get_setting_value(MAIN_WINDOW_STATE).ok().flatten()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_window_state(state: &WindowBoundsState) -> Result<()> {
    let json = serde_json::to_string(state)?;
    sql::set_setting_value(MAIN_WINDOW_STATE, Some(json))
}

pub fn clear_window_state() -> Result<()> {
    sql::set_setting_value(MAIN_WINDOW_STATE, None)
}
