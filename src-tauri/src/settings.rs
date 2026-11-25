use std::{collections::HashMap, env::consts::OS};

use anyhow::{Context, Result};
use directories::UserDirs;

use crate::{sql, types::Settings};

pub const MPV_PARAMS: &str = "mpvParams";
pub const USE_STREAM_CACHING: &str = "useStreamingCaching";
pub const DEFAULT_VIEW: &str = "defaultView";
pub const VOLUME: &str = "volume";
pub const REFRESH_ON_START: &str = "refreshOnStart";
pub const RESTREAM_PORT: &str = "restreamPort";
pub const ENABLE_TRAY_ICON: &str = "enableTrayIcon";
pub const ZOOM: &str = "zoom";
pub const DEFAULT_SORT: &str = "defaultSort";
pub const ENABLE_HWDEC: &str = "enableHWDEC";
pub const ENABLE_GPU: &str = "enableGPU";
pub const SCREENSHOT_PATH: &str = "screenshotPath";

pub fn get_settings() -> Result<Settings> {
    let map = sql::get_settings()?;
    let settings = Settings {
        mpv_params: map.get(MPV_PARAMS).map(|s| s.to_string()),
        use_stream_caching: map.get(USE_STREAM_CACHING).and_then(|s| s.parse().ok()),
        default_view: map.get(DEFAULT_VIEW).and_then(|s| s.parse().ok()),
        volume: map.get(VOLUME).and_then(|s| s.parse().ok()),
        refresh_on_start: map.get(REFRESH_ON_START).and_then(|s| s.parse().ok()),
        restream_port: map.get(RESTREAM_PORT).and_then(|s| s.parse().ok()),
        enable_tray_icon: if OS == "linux" {
            Some(false)
        } else {
            map.get(ENABLE_TRAY_ICON).and_then(|s| s.parse().ok())
        },
        zoom: map.get(ZOOM).and_then(|s| s.parse().ok()),
        default_sort: map.get(DEFAULT_SORT).and_then(|s| s.parse().ok()),
        enable_hwdec: map.get(ENABLE_HWDEC).and_then(|s| s.parse().ok()),
        enable_gpu: map.get(ENABLE_GPU).and_then(|s| s.parse().ok()),
        screenshot_path: map.get(SCREENSHOT_PATH).map(|s| s.to_string()),
    };
    Ok(settings)
}

pub fn update_settings(settings: Settings) -> Result<()> {
    let mut map: HashMap<String, Option<String>> = HashMap::with_capacity(13);

    map.insert(MPV_PARAMS.to_string(), settings.mpv_params);

    if let Some(use_stream_caching) = settings.use_stream_caching {
        map.insert(
            USE_STREAM_CACHING.to_string(),
            Some(use_stream_caching.to_string()),
        );
    }
    if let Some(default_view) = settings.default_view {
        map.insert(DEFAULT_VIEW.to_string(), Some(default_view.to_string()));
    }
    if let Some(volume) = settings.volume {
        map.insert(VOLUME.to_string(), Some(volume.to_string()));
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
    if let Some(enable_tray) = settings.enable_tray_icon {
        map.insert(ENABLE_TRAY_ICON.to_string(), Some(enable_tray.to_string()));
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
