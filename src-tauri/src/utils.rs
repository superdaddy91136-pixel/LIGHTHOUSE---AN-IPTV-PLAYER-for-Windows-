use crate::types::{AppState, Channel, ChannelPreserve};
use crate::{
    log::log,
    m3u,
    settings::{get_default_record_path, get_settings},
    source_type, sql,
    types::Source,
    xtream,
};
use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Local, Utc};
use directories::ProjectDirs;
use indexmap::IndexMap;
use regex::Regex;
use reqwest::{
    Client,
    header::{HeaderMap, HeaderValue},
};
use serde::Serialize;
use std::{
    env::{consts::OS, current_exe},
    fs::File,
    path::{Path, PathBuf},
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use which::which;

const MACOS_POTENTIAL_PATHS: [&str; 3] = [
    "/opt/local/bin",    // MacPorts
    "/opt/homebrew/bin", // Homebrew on AARCH64 Mac
    "/usr/local/bin",    // Homebrew on AMD64 Mac
];

const DEFAULT_USER_AGENT: &str = "Fred TV";

static ILLEGAL_CHARS_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1F]"#).unwrap());

static SOURCE_REFRESH_ACTIVE: AtomicBool = AtomicBool::new(false);

struct SourceRefreshGuard;

impl SourceRefreshGuard {
    fn acquire() -> Result<Self> {
        SOURCE_REFRESH_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| anyhow!("A source refresh is already in progress"))?;
        Ok(Self)
    }
}

impl Drop for SourceRefreshGuard {
    fn drop(&mut self) {
        SOURCE_REFRESH_ACTIVE.store(false, Ordering::Release);
    }
}

pub fn emit_source_refresh_progress(
    app: Option<&AppHandle>,
    source_id: i64,
    stage: &str,
    stage_label: &str,
    percent: Option<f64>,
    indeterminate: bool,
    current: Option<usize>,
    total: Option<usize>,
    error: Option<String>,
) {
    if let Some(app) = app {
        let payload = crate::types::SourceRefreshProgress {
            source_id,
            stage: stage.to_string(),
            stage_label: stage_label.to_string(),
            percent,
            indeterminate,
            current,
            total,
            error,
        };
        let _ = app.emit(&format!("source-refresh-progress-{}", source_id), &payload);
        let _ = app.emit("source-refresh-progress", &payload);
    }
}

pub async fn refresh_source(app: &AppHandle, source: Source) -> Result<()> {
    let _guard = SourceRefreshGuard::acquire()?;
    refresh_source_unlocked(app, source).await
}

async fn refresh_source_unlocked(app: &AppHandle, source: Source) -> Result<()> {
    let id = source.id.unwrap_or(0);
    emit_source_refresh_progress(
        Some(app),
        id,
        "connecting",
        "Connecting to provider...",
        None,
        true,
        None,
        None,
        None,
    );
    let res = match source.source_type {
        source_type::M3U => m3u::read_m3u8(Some(app), source, true),
        source_type::M3U_LINK => m3u::get_m3u8_from_link(Some(app), source, true).await,
        source_type::XTREAM => xtream::get_xtream(Some(app), source, true).await,
        source_type::CUSTOM => Ok(()),
        _ => Err(anyhow!("invalid source_type")),
    };
    match res {
        Ok(_) => {
            if id > 0 {
                let _ = sql::update_source_last_updated(id);
            }
            emit_source_refresh_progress(
                Some(app),
                id,
                "complete",
                "Refresh complete",
                Some(100.0),
                false,
                None,
                None,
                None,
            );
            Ok(())
        }
        Err(e) => {
            let err_msg = format!("{:#}", e);
            emit_source_refresh_progress(
                Some(app),
                id,
                "error",
                &format!("Refresh failed: {}", err_msg),
                None,
                false,
                None,
                None,
                Some(err_msg),
            );
            Err(e)
        }
    }
}

pub async fn refresh_all(app: &AppHandle) -> Result<()> {
    let _guard = SourceRefreshGuard::acquire()?;
    let sources = sql::get_sources()?;
    let mut failures = Vec::new();
    for source in sources {
        let source_name = source.name.clone();
        if let Err(error) = refresh_source_unlocked(app, source).await {
            failures.push(format!("{source_name}: {error:#}"));
        }
    }
    if !failures.is_empty() {
        bail!(
            "{} source refresh(es) failed: {}",
            failures.len(),
            failures.join("; ")
        );
    }
    Ok(())
}

pub fn get_local_time(timestamp: i64) -> Result<DateTime<Local>> {
    let datetime = DateTime::<Utc>::from_timestamp(timestamp, 0).context("no time")?;
    Ok(DateTime::<Local>::from(datetime))
}

pub async fn download(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    channel: Channel,
    download_id: &str,
    path: Option<String>,
) -> Result<()> {
    let source_id = channel.source_id.context("no source id provided")?;
    let source = sql::get_source_from_id(source_id)
        .with_context(|| format!("failed to fetch source with id {}", source_id))?;

    _ = handle_max_streams(&source, &state)
        .await
        .map_err(|e| log(format!("{:?}", e)));

    let token = CancellationToken::new();
    _ = insert_play_token(source_id, download_id.to_string(), token.clone(), &state)
        .await
        .map_err(|e| log(format!("{:?}", e)));

    let headers = sql::get_channel_headers_by_id(channel.id.context("no channel id?")?)?;
    let mut client = Client::builder();
    let mut headers_map = HeaderMap::new();
    if let Some(headers) = headers.as_ref() {
        if let Some(origin) = headers.http_origin.as_ref() {
            headers_map.insert("Origin", HeaderValue::from_str(origin)?);
        }
        if let Some(referrer) = headers.referrer.as_ref() {
            headers_map.insert("Referer", HeaderValue::from_str(referrer)?);
        }
        if let Some(ignore_ssl) = headers.ignore_ssl {
            if ignore_ssl {
                client = client.danger_accept_invalid_certs(true);
            }
        }
    }
    let user_agent = headers
        .and_then(|f| f.user_agent)
        .or(source.stream_user_agent)
        .unwrap_or_else(|| DEFAULT_USER_AGENT.to_string());
    let client = client
        .user_agent(user_agent)
        .default_headers(headers_map)
        .build()?;
    let url = channel.url.clone().context("no url provided")?;
    let name = channel.name.clone();
    let mut response = client.get(&url).send().await?;
    let total_size = response.content_length().unwrap_or(0);
    let mut downloaded = 0;
    let path = match path {
        Some(p) => p,
        None => get_download_path(get_filename(name, url)?)?,
    };
    let mut file = tokio::fs::File::create(&path).await?;
    let mut send_threshold: f64 = 0.1;
    if !response.status().is_success() {
        let error = response.status();
        bail!("Failed to download movie: HTTP {error}")
    }

    let result: Result<()> = loop {
        tokio::select! {
          chunk = response.chunk() => {
               match chunk {
                   Ok(Some(chunk)) => {
                       if let Err(e) = file.write(&chunk).await {
                           break Err(e.into());
                       }
                       downloaded += chunk.len() as u64;
                       if total_size > 0 {
                           let progress: f64 = (downloaded as f64 / total_size as f64) * 100.0;
                           let progress = (progress * 10.0).trunc() / 10.0;
                           if progress > send_threshold {
                               let _ = app.emit(&format!("progress-{}", download_id), progress);
                               send_threshold = progress + 0.1 as f64;
                           }
                       }
                   }
                   Ok(None) => break Ok(()),
                   Err(e) => break Err(e.into()),
               }
          }
          _ = token.cancelled() => {
               break Err(anyhow!("download aborted"));
          }
        }
    };

    _ = remove_from_play_stop(state, &source_id, &download_id.to_string())
        .await
        .map_err(|e| log(format!("{:?}", e)));

    if let Err(e) = &result {
        if e.to_string() == "download aborted" {
            drop(file);
            let _ = tokio::fs::remove_file(path).await;
            bail!("download aborted");
        }
    }
    result
}

pub async fn remove_from_play_stop(
    state: State<'_, Mutex<AppState>>,
    source_id: &i64,
    key: &str,
) -> Result<Option<CancellationToken>> {
    let mut state = state.lock().await;
    let map = state
        .play_stop
        .get_mut(&source_id)
        .context("no indexMap for sourceId")?;
    Ok(map.shift_remove(key))
}

pub async fn handle_max_streams(source: &Source, state: &State<'_, Mutex<AppState>>) -> Result<()> {
    let max_streams = source.max_streams.unwrap_or(1);
    let mut guard = state.lock().await;
    let channels = guard
        .play_stop
        .get_mut(source.id.as_ref().context("no id")?);
    if channels.is_none() {
        return Ok(());
    }
    let channels = channels.context("no channels")?;
    if channels.len() < max_streams.into() {
        return Ok(());
    }
    let (_, token) = channels
        .shift_remove_index(0)
        .context("failed to remove channel from indexMap")?;
    token.cancel();
    Ok(())
}

pub async fn insert_play_token(
    source_id: i64,
    key: String,
    token: CancellationToken,
    state: &State<'_, Mutex<AppState>>,
) -> Result<()> {
    let mut guard = state.lock().await;
    if guard.play_stop.get(&source_id).is_none() {
        guard
            .play_stop
            .insert(source_id, IndexMap::<String, CancellationToken>::new());
    }
    let map = guard
        .play_stop
        .get_mut(&source_id)
        .context("no indexMap found")?;
    map.insert(key, token);
    Ok(())
}

fn get_filename(channel_name: String, url: String) -> Result<String> {
    let extension = get_extension(url);
    let channel_name = sanitize(channel_name);
    let filename = format!("{channel_name}.{extension}").to_string();
    Ok(filename)
}

fn get_extension(url: String) -> String {
    url.rsplit(".")
        .next()
        .filter(|ext| !ext.starts_with("php?"))
        .unwrap_or("mp4")
        .to_string()
}

pub fn sanitize(str: String) -> String {
    ILLEGAL_CHARS_REGEX.replace_all(&str, "").to_string()
}

fn get_download_path(file_name: String) -> Result<String> {
    let settings = get_settings()?;
    let path = match settings.recording_path {
        Some(path) => path,
        None => get_default_record_path()?,
    };
    let mut path = Path::new(&path).to_path_buf();
    path.push(file_name);
    Ok(path.to_string_lossy().to_string())
}
pub fn get_bin(bin: &str) -> String {
    if OS == "linux" {
        return bin.to_string();
    } else if OS == "macos" {
        return find_macos_bin(bin);
    } else if OS == "windows" {
        return find_windows_bin(bin);
    }
    if which(bin).is_ok() {
        return bin.to_string();
    }
    return get_bin_from_deps(bin);
}

pub fn find_windows_bin(bin: &str) -> String {
    let bin_with_exe = if bin.to_lowercase().ends_with(".exe") {
        bin.to_string()
    } else {
        format!("{}.exe", bin)
    };

    let check_file = |dir: &Path| -> Option<PathBuf> {
        let candidate_exe = dir.join(&bin_with_exe);
        if candidate_exe.is_file() {
            return Some(candidate_exe);
        }
        let candidate_raw = dir.join(bin);
        if candidate_raw.is_file() {
            return Some(candidate_raw);
        }
        None
    };

    // 1. Search relative to current_exe() and its parent directories
    if let Ok(exe) = current_exe() {
        let mut curr = exe.parent();
        while let Some(dir) = curr {
            if let Some(p) = check_file(&dir.join("deps")) {
                let resolved = p.to_string_lossy().to_string();
                log(format!("Resolved binary '{}' to '{}'", bin, resolved));
                return resolved;
            }
            if let Some(p) = check_file(&dir.join("src-tauri").join("deps")) {
                let resolved = p.to_string_lossy().to_string();
                log(format!("Resolved binary '{}' to '{}'", bin, resolved));
                return resolved;
            }
            if let Some(p) = check_file(dir) {
                let resolved = p.to_string_lossy().to_string();
                log(format!("Resolved binary '{}' to '{}'", bin, resolved));
                return resolved;
            }
            curr = dir.parent();
        }
    }

    // 2. Check CARGO_MANIFEST_DIR (available at compile time during development)
    if let Some(manifest_dir) = option_env!("CARGO_MANIFEST_DIR") {
        let manifest_path = Path::new(manifest_dir);
        if let Some(p) = check_file(&manifest_path.join("deps")) {
            let resolved = p.to_string_lossy().to_string();
            log(format!("Resolved binary '{}' to '{}'", bin, resolved));
            return resolved;
        }
        if let Some(parent) = manifest_path.parent() {
            if let Some(p) = check_file(&parent.join("deps")) {
                let resolved = p.to_string_lossy().to_string();
                log(format!("Resolved binary '{}' to '{}'", bin, resolved));
                return resolved;
            }
        }
    }

    // 3. Check C:\open-tv-deps (standard packaging / build location for Fred TV on Windows)
    let open_tv_deps = Path::new(r"C:\open-tv-deps");
    if let Some(p) = check_file(open_tv_deps) {
        let resolved = p.to_string_lossy().to_string();
        log(format!("Resolved binary '{}' to '{}'", bin, resolved));
        return resolved;
    }

    // 4. Check C:\Program Files\Fred TV\deps (installed package fallback)
    let installed_deps = Path::new(r"C:\Program Files\Fred TV\deps");
    if let Some(p) = check_file(installed_deps) {
        let resolved = p.to_string_lossy().to_string();
        log(format!("Resolved binary '{}' to '{}'", bin, resolved));
        return resolved;
    }

    // 5. Check PATH via which
    if let Ok(path) = which(&bin_with_exe) {
        let resolved = path.to_string_lossy().to_string();
        log(format!("Resolved binary '{}' to '{}'", bin, resolved));
        return resolved;
    }
    if let Ok(path) = which(bin) {
        let resolved = path.to_string_lossy().to_string();
        log(format!("Resolved binary '{}' to '{}'", bin, resolved));
        return resolved;
    }

    // Fallback: default deps path relative to current exe with .exe
    if let Ok(exe) = current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let fallback = exe_dir
                .join("deps")
                .join(&bin_with_exe)
                .to_string_lossy()
                .to_string();
            log(format!(
                "Binary '{}' not found, falling back to '{}'",
                bin, fallback
            ));
            return fallback;
        }
    }

    bin_with_exe
}

fn get_bin_from_deps(bin: &str) -> String {
    let mut path = current_exe().unwrap();
    path.pop();
    path.push("deps");
    path.push(bin);
    return path.to_string_lossy().to_string();
}

pub fn find_macos_bin(bin: &str) -> String {
    return MACOS_POTENTIAL_PATHS
        .iter()
        .map(|path| {
            let mut path = Path::new(path).to_path_buf();
            path.push(bin);
            return path;
        })
        .find(|path| path.exists())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            log(format!("Could not find {} on MacOS host", bin));
            return bin.to_string();
        });
}

pub fn serialize_to_file<T: Serialize>(obj: T, path: String) -> Result<()> {
    let data = serde_json::to_string(&obj)?;
    std::fs::write(path, data)?;
    Ok(())
}

pub fn backup_favs(source_id: i64, path: String) -> Result<()> {
    sql::do_tx(|tx| {
        let preserve = sql::get_preserve(tx, source_id)?;
        serialize_to_file(preserve, path)?;
        Ok(())
    })?;
    Ok(())
}

pub fn restore_favs(source_id: i64, path: String) -> Result<()> {
    let data = std::fs::read_to_string(path)?;
    let preserve: Vec<ChannelPreserve> = serde_json::from_str(&data)?;
    sql::do_tx(|tx| {
        sql::restore_preserve(tx, source_id, preserve)?;
        Ok(())
    })?;
    Ok(())
}

pub fn is_container() -> bool {
    std::env::var("container").is_ok()
}

pub fn create_nuke_request() -> Result<()> {
    let path = get_nuke_path()?;
    File::create(path)?;
    std::process::exit(0);
}

fn get_nuke_path() -> Result<PathBuf> {
    let path = ProjectDirs::from("dev", "fredol", "open-tv").context("project dir not found")?;
    let path = path.cache_dir();
    let path = path.join("nuke.txt");
    Ok(path)
}

pub fn check_nuke() -> Result<()> {
    let path = get_nuke_path()?;
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(path)?;
    let path = ProjectDirs::from("dev", "fredol", "open-tv").context("project dir not found")?;
    let path = path.data_dir();
    let path = path.join(sql::DB_NAME);
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub fn get_user_agent_from_source(source: &Source) -> Result<String> {
    let user_agent: &str = source
        .user_agent
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_USER_AGENT);
    Ok(user_agent.to_string())
}

#[cfg(test)]
mod test_utils {
    use super::sanitize;

    #[test]
    fn test_sanitize() {
        assert_eq!(
            "SuperShow Who will win the million".to_string(),
            sanitize("SuperShow: Who will win the million?".to_string())
        );
    }
}
