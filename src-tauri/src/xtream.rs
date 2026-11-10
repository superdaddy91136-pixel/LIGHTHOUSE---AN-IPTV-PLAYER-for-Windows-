use crate::log;
use crate::media_type;
use crate::source_type;
use crate::sql;
use crate::sql::insert_season;
use crate::types::Channel;
use crate::types::ChannelPreserve;
use crate::types::EPG;
use crate::types::Season;
use crate::types::Source;
use crate::types::XtreamStatus;
use crate::utils::get_local_time;
use crate::utils::get_user_agent_from_source;
use anyhow::anyhow;
use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use chrono::DateTime;
use chrono::Local;
use chrono::NaiveDateTime;
use futures::future::join_all;
use reqwest::Client;
use rusqlite::{Transaction, params};
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use tauri::AppHandle;
use tokio::join;
use url::Url;

const GET_LIVE_STREAMS: &str = "get_live_streams";
const GET_VODS: &str = "get_vod_streams";
const GET_SERIES: &str = "get_series";
const GET_SERIES_INFO: &str = "get_series_info";
const GET_SERIES_CATEGORIES: &str = "get_series_categories";
const GET_LIVE_STREAM_CATEGORIES: &str = "get_live_categories";
const GET_VOD_CATEGORIES: &str = "get_vod_categories";
const GET_EPG: &str = "get_simple_data_table";
const LIVE_STREAM_EXTENSION: &str = "ts";
const NO_SEASON_NUMBER: i64 = -9999;

#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamStream {
    #[serde(default)]
    stream_id: serde_json::Value,
    name: Option<String>,
    #[serde(default)]
    category_id: serde_json::Value,
    stream_icon: Option<String>,
    #[serde(default)]
    series_id: serde_json::Value,
    cover: Option<String>,
    container_extension: Option<String>,
    #[serde(default)]
    tv_archive: serde_json::Value,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamSeries {
    seasons: Vec<XtreamSeason>,
    episodes: HashMap<String, Vec<XtreamEpisode>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamSeason {
    #[serde(default)]
    season_number: serde_json::Value,
    #[serde(default)]
    overview: Option<String>,
    #[serde(default)]
    cover: Option<String>,
    #[serde(default)]
    cover_tmdb: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamEpisode {
    id: serde_json::Value,
    title: String,
    container_extension: String,
    #[serde(default)]
    episode_num: serde_json::Value,
    #[serde(default)]
    season: serde_json::Value,
    #[serde(default)]
    info: serde_json::Value,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamEpisodeInfo {
    movie_image: Option<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamCategory {
    #[serde(default)]
    category_id: serde_json::Value,
    #[serde(default)]
    category_name: Option<String>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamEPG {
    epg_listings: Vec<XtreamEPGItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct XtreamEPGItem {
    id: serde_json::Value,
    title: String,
    description: String,
    start_timestamp: serde_json::Value,
    stop_timestamp: serde_json::Value,
    now_playing: u8,
    has_archive: u8,
    start: String,
    end: String,
}

fn build_xtream_url(source: &mut Source) -> Result<Url> {
    let mut url = Url::parse(&source.url.clone().context("Missing URL")?)?;
    source.url_origin = Some(
        url.origin().ascii_serialization(),
    );
    if url.path().is_empty() || url.path() == "/" {
        url.set_path("/player_api.php");
        source.url = Some(url.to_string());
    }
    let has_username = url.query_pairs().any(|(k, _)| k == "username");
    let has_password = url.query_pairs().any(|(k, _)| k == "password");
    if !has_username {
        url.query_pairs_mut().append_pair(
            "username",
            &source.username.clone().context("Missing username")?,
        );
    }
    if !has_password {
        url.query_pairs_mut().append_pair(
            "password",
            &source.password.clone().context("Missing password")?,
        );
    }
    Ok(url)
}

pub async fn authenticate_xtream(client: &Client, url: &Url) -> Result<XtreamStatus> {
    let t_start = std::time::Instant::now();
    let resp = match client.get(url.clone()).send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                bail!("Connection timed out while connecting to Xtream server: {}", e);
            } else if e.is_connect() {
                bail!("Network error: could not connect to Xtream server (check server URL): {}", e);
            } else {
                bail!("Network error communicating with Xtream server: {}", e);
            }
        }
    };

    let status_code = resp.status();
    if status_code == reqwest::StatusCode::UNAUTHORIZED || status_code == reqwest::StatusCode::FORBIDDEN {
        bail!("Authentication failed: server returned HTTP {} (check username and password)", status_code);
    }
    if !status_code.is_success() {
        bail!("Xtream server error: HTTP {}", status_code);
    }

    let bytes = resp.bytes().await?;
    let trimmed = trim_bytes(&bytes);
    if trimmed.is_empty() {
        bail!("Invalid API response: server returned an empty response");
    }
    if trimmed.starts_with(b"<") {
        bail!("Invalid API response: server returned HTML instead of Xtream JSON (verify the server URL and path)");
    }

    let status: XtreamStatus = match serde_json::from_slice(&bytes) {
        Ok(s) => s,
        Err(e) => {
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(user_info) = val.get("user_info") {
                    if let Some(auth_val) = user_info.get("auth") {
                        if auth_val == 0 || auth_val == "0" {
                            bail!("Authentication failed: invalid username or password");
                        }
                    }
                }
                if let Some(auth_val) = val.get("auth") {
                    if auth_val == 0 || auth_val == "0" {
                        bail!("Authentication failed: invalid username or password");
                    }
                }
                if let Some(msg) = val.get("message").and_then(|m| m.as_str()) {
                    bail!("Authentication failed: {}", msg);
                }
            }
            bail!("Unexpected response format from Xtream server: {}", e);
        }
    };

    if !status.user_info.is_auth_successful() {
        let reason = if let Some(msg) = &status.user_info.message {
            msg.clone()
        } else if let Some(st) = &status.user_info.status {
            format!("account status is '{}'", st)
        } else {
            "invalid username or password".to_string()
        };
        bail!("Authentication failed: {}", reason);
    }

    log::log(format!(
        "[Xtream Auth] Authenticated successfully in {:.2}s (status: {:?})",
        t_start.elapsed().as_secs_f64(),
        status.user_info.status.as_deref().unwrap_or("Active")
    ));

    Ok(status)
}

pub async fn get_xtream(app: Option<&AppHandle>, mut source: Source, wipe: bool) -> Result<()> {
    let source_id = source.id.unwrap_or(0);
    crate::utils::emit_source_refresh_progress(
        app,
        source_id,
        "connecting",
        "Connecting to Xtream server...",
        Some(1.0),
        true,
        None,
        None,
        None,
    );

    let url = build_xtream_url(&mut source)?;
    let user_agent = get_user_agent_from_source(&source)?;
    let client = Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(180))
        .build()?;

    // Step 1: Explicit Authentication & Account Verification
    let _auth_status = authenticate_xtream(&client, &url).await?;

    // Step 2: Fetch categories concurrently (small JSON payloads, very fast)
    crate::utils::emit_source_refresh_progress(
        app,
        source_id,
        "fetching_categories",
        "Fetching categories...",
        Some(3.0),
        true,
        None,
        None,
        None,
    );
    let t_cats = std::time::Instant::now();
    let (live_cats_res, vods_cats_res, series_cats_res) = join!(
        get_xtream_http_list_with_client::<XtreamCategory>(
            &client,
            url.clone(),
            GET_LIVE_STREAM_CATEGORIES
        ),
        get_xtream_http_list_with_client::<XtreamCategory>(
            &client,
            url.clone(),
            GET_VOD_CATEGORIES
        ),
        get_xtream_http_list_with_client::<XtreamCategory>(
            &client,
            url.clone(),
            GET_SERIES_CATEGORIES
        ),
    );
    log::log(format!(
        "[Xtream] Categories fetched in {:.2}s for source {source_id}",
        t_cats.elapsed().as_secs_f64()
    ));

    let live_cats = live_cats_res.unwrap_or_else(|e| {
        log::log(format!(
            "Warning: failed to fetch live categories for source {source_id}: {e:#}"
        ));
        Vec::new()
    });
    let vods_cats = vods_cats_res.unwrap_or_else(|e| {
        log::log(format!(
            "Warning: failed to fetch VOD categories for source {source_id}: {e:#}"
        ));
        Vec::new()
    });
    let series_cats = series_cats_res.unwrap_or_else(|e| {
        log::log(format!(
            "Warning: failed to fetch series categories for source {source_id}: {e:#}"
        ));
        Vec::new()
    });

    // Step 3: Fetch stream lists with stage-specific progress updates and timings
    crate::utils::emit_source_refresh_progress(
        app,
        source_id,
        "fetching_live",
        "Fetching Live TV channels...",
        Some(5.0),
        true,
        None,
        None,
        None,
    );
    let t_live = std::time::Instant::now();
    let live_res = get_xtream_http_list_with_client::<XtreamStream>(
        &client,
        url.clone(),
        GET_LIVE_STREAMS,
    )
    .await;
    log::log(format!(
        "[Xtream] Live TV fetch finished in {:.2}s for source {source_id} (success: {})",
        t_live.elapsed().as_secs_f64(),
        live_res.is_ok()
    ));

    crate::utils::emit_source_refresh_progress(
        app,
        source_id,
        "fetching_vods",
        "Fetching Movies...",
        Some(15.0),
        true,
        None,
        None,
        None,
    );
    let t_vods = std::time::Instant::now();
    let vods_res = get_xtream_http_list_with_client::<XtreamStream>(
        &client,
        url.clone(),
        GET_VODS,
    )
    .await;
    log::log(format!(
        "[Xtream] Movies fetch finished in {:.2}s for source {source_id} (success: {})",
        t_vods.elapsed().as_secs_f64(),
        vods_res.is_ok()
    ));

    crate::utils::emit_source_refresh_progress(
        app,
        source_id,
        "fetching_series",
        "Fetching TV Shows...",
        Some(25.0),
        true,
        None,
        None,
        None,
    );
    let t_series = std::time::Instant::now();
    let series_res = get_xtream_http_list_with_client::<XtreamStream>(
        &client,
        url.clone(),
        GET_SERIES,
    )
    .await;
    log::log(format!(
        "[Xtream] TV Shows fetch finished in {:.2}s for source {source_id} (success: {})",
        t_series.elapsed().as_secs_f64(),
        series_res.is_ok()
    ));

    // Inspect stream results and collect stage-specific errors
    let mut stage_errors: Vec<String> = Vec::new();
    let live_opt = match live_res {
        Ok(items) => Some(items),
        Err(e) => {
            let msg = format!("Live TV: {:#}", e);
            log::log(format!("Source {source_id} {}", msg));
            stage_errors.push(msg);
            None
        }
    };
    let vods_opt = match vods_res {
        Ok(items) => Some(items),
        Err(e) => {
            let msg = format!("Movies: {:#}", e);
            log::log(format!("Source {source_id} {}", msg));
            stage_errors.push(msg);
            None
        }
    };
    let series_opt = match series_res {
        Ok(items) => Some(items),
        Err(e) => {
            let msg = format!("TV Shows: {:#}", e);
            log::log(format!("Source {source_id} {}", msg));
            stage_errors.push(msg);
            None
        }
    };

    // If all stream requests failed, abort without modifying existing database
    if live_opt.is_none() && vods_opt.is_none() && series_opt.is_none() {
        bail!(
            "Failed to retrieve catalog from provider: {}",
            stage_errors.join("; ")
        );
    }

    let live_len = live_opt.as_ref().map(|v| v.len()).unwrap_or(0);
    let vods_len = vods_opt.as_ref().map(|v| v.len()).unwrap_or(0);
    let series_len = series_opt.as_ref().map(|v| v.len()).unwrap_or(0);
    let total_items = live_len + vods_len + series_len;

    let app_clone = app.cloned();
    let stage_errors_clone = stage_errors.clone();
    tokio::task::spawn_blocking(move || {
        let app_ref = app_clone.as_ref();
        let mut sql = sql::get_conn()?;
        let tx = sql.transaction()?;
        let mut channel_preserve: Vec<ChannelPreserve> = Vec::new();

        let effective_source_id = if wipe {
            let id = source.id.context("no source id")?;
            crate::utils::emit_source_refresh_progress(
                app_ref,
                id,
                "preparing",
                "Preparing database...",
                Some(30.0),
                false,
                Some(0),
                Some(total_items),
                None,
            );
            channel_preserve = sql::get_preserve(&tx, id).unwrap_or_default();
            id
        } else {
            let new_id = sql::create_or_find_source_by_name(&tx, &source)?;
            source.id = Some(new_id);
            new_id
        };

        let mut processed_so_far: usize = 0;

        if let Some(live) = live_opt {
            let existing_live =
                sql::get_channel_count_by_media_type(&tx, effective_source_id, media_type::LIVESTREAM)?;
            let should_sync = existing_live == 0 || !live.is_empty();
            if !should_sync {
                log::log(format!(
                    "Source {effective_source_id}: Live streams returned 0 items but database has {existing_live} items; preserving existing live channels to prevent data loss"
                ));
            } else {
                process_xtream(
                    &tx,
                    live,
                    live_cats,
                    &source,
                    media_type::LIVESTREAM,
                    app_ref,
                    effective_source_id,
                    "live",
                    "Live TV",
                    &mut processed_so_far,
                    total_items,
                )?;
            }
        }

        if let Some(vods) = vods_opt {
            let existing_vods =
                sql::get_channel_count_by_media_type(&tx, effective_source_id, media_type::MOVIE)?;
            let should_sync = existing_vods == 0 || !vods.is_empty();
            if !should_sync {
                log::log(format!(
                    "Source {effective_source_id}: VOD streams returned 0 items but database has {existing_vods} items; preserving existing movies to prevent data loss"
                ));
            } else {
                process_xtream(
                    &tx,
                    vods,
                    vods_cats,
                    &source,
                    media_type::MOVIE,
                    app_ref,
                    effective_source_id,
                    "movies",
                    "Movies",
                    &mut processed_so_far,
                    total_items,
                )?;
            }
        }

        if let Some(series) = series_opt {
            let existing_series =
                sql::get_channel_count_by_media_type(&tx, effective_source_id, media_type::SERIE)?;
            let should_sync = existing_series == 0 || !series.is_empty();
            if !should_sync {
                log::log(format!(
                    "Source {effective_source_id}: Series returned 0 items but database has {existing_series} items; preserving existing TV shows to prevent data loss"
                ));
            } else {
                process_xtream(
                    &tx,
                    series,
                    series_cats,
                    &source,
                    media_type::SERIE,
                    app_ref,
                    effective_source_id,
                    "series",
                    "TV Shows",
                    &mut processed_so_far,
                    total_items,
                )?;
            }
        }

        crate::utils::emit_source_refresh_progress(
            app_ref,
            effective_source_id,
            "finalizing",
            "Finalizing database...",
            Some(95.0),
            false,
            Some(processed_so_far),
            Some(total_items),
            None,
        );

        if wipe {
            sql::restore_preserve(&tx, effective_source_id, channel_preserve)?;
        }
        tx.commit()?;

        if !stage_errors_clone.is_empty() {
            log::log(format!(
                "Source {effective_source_id} synchronized with partial warnings: {}",
                stage_errors_clone.join("; ")
            ));
        }
        Ok::<(), anyhow::Error>(())
    })
    .await??;

    Ok(())
}

fn trim_bytes(b: &[u8]) -> &[u8] {
    let mut start = 0;
    while start < b.len() && b[start].is_ascii_whitespace() {
        start += 1;
    }
    let mut end = b.len();
    while end > start && b[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    &b[start..end]
}

async fn get_xtream_http_list_with_client<T>(
    client: &Client,
    mut url: Url,
    action: &str,
) -> Result<Vec<T>>
where
    T: serde::de::DeserializeOwned,
{
    url.query_pairs_mut().append_pair("action", action);
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        bail!("HTTP {} for action {}", resp.status(), action);
    }
    let bytes = resp.bytes().await?;
    let trimmed = trim_bytes(&bytes);
    if trimmed.is_empty() || trimmed == b"{}" || trimmed == b"null" {
        return Ok(Vec::new());
    }
    match serde_json::from_slice::<Vec<T>>(&bytes) {
        Ok(list) => Ok(list),
        Err(e) => {
            if let Ok(map) = serde_json::from_slice::<HashMap<String, T>>(&bytes) {
                return Ok(map.into_values().collect());
            }
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(user_info) = val.get("user_info") {
                    if let Some(auth_val) = user_info.get("auth") {
                        if auth_val == 0 || auth_val == "0" {
                            bail!("Authentication failed: provider returned auth=0 for {action}");
                        }
                    }
                }
                if let Some(auth_val) = val.get("auth") {
                    if auth_val == 0 || auth_val == "0" {
                        bail!("Authentication failed: provider returned auth=0 for {action}");
                    }
                }
            }
            Err(anyhow!("Failed to parse {action}: {e}"))
        }
    }
}

async fn get_xtream_http_data_with_client<T>(
    client: &Client,
    mut url: Url,
    action: &str,
) -> Result<T>
where
    T: serde::de::DeserializeOwned,
{
    url.query_pairs_mut().append_pair("action", action);
    let data = client.get(url).send().await?.json::<T>().await?;
    Ok(data)
}

async fn get_xtream_http_data<T>(url: Url, action: &str, user_agent: &String) -> Result<T>
where
    T: serde::de::DeserializeOwned,
{
    let client = Client::builder()
        .user_agent(user_agent)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()?;
    get_xtream_http_data_with_client(&client, url, action).await
}

struct ExistingChannelMeta {
    id: i64,
    name: String,
    group_id: Option<i64>,
    image: Option<String>,
    url: Option<String>,
    favorite: bool,
    last_watched: Option<i64>,
    hidden: bool,
}

struct ChannelInsert {
    name: String,
    group_id: Option<i64>,
    image: Option<String>,
    url: Option<String>,
    stream_id: u64,
    tv_archive: Option<bool>,
}

struct ChannelUpdate {
    id: i64,
    name: String,
    group_id: Option<i64>,
    image: Option<String>,
    url: Option<String>,
}

fn process_xtream(
    tx: &Transaction,
    streams: Vec<XtreamStream>,
    cats: Vec<XtreamCategory>,
    source: &Source,
    stream_type: u8,
    app: Option<&AppHandle>,
    source_id: i64,
    stage_name: &str,
    stage_prefix: &str,
    processed_so_far: &mut usize,
    total_items: usize,
) -> Result<()> {
    let t_start = std::time::Instant::now();
    let stage_total = streams.len();

    // 1. Pre-load existing channels for this source and media type
    let mut existing_map: HashMap<u64, ExistingChannelMeta> =
        HashMap::with_capacity(stage_total.min(200_000));
    {
        let mut query_stmt = tx.prepare(
            "SELECT id, stream_id, name, group_id, image, url, favorite, last_watched, hidden
             FROM channels
             WHERE source_id = ? AND media_type = ? AND series_id IS NULL AND stream_id IS NOT NULL",
        )?;
        let mut rows = query_stmt.query(params![source_id, stream_type])?;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let stream_id: u64 = row.get::<_, i64>(1)? as u64;
            let name: String = row.get(2)?;
            let group_id: Option<i64> = row.get(3)?;
            let image: Option<String> = row.get(4)?;
            let url: Option<String> = row.get(5)?;
            let favorite: bool = row.get(6)?;
            let last_watched: Option<i64> = row.get(7)?;
            let hidden: bool = row.get(8)?;
            existing_map.insert(
                stream_id,
                ExistingChannelMeta {
                    id,
                    name,
                    group_id,
                    image,
                    url,
                    favorite,
                    last_watched,
                    hidden,
                },
            );
        }
    }

    // 2. Pre-load ALL existing groups for this source across media types to avoid unique constraint collisions
    let mut groups_map: HashMap<String, i64> = HashMap::new();
    {
        let mut group_stmt = tx.prepare(
            "SELECT id, name FROM groups WHERE source_id = ?",
        )?;
        let mut rows = group_stmt.query(params![source_id])?;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            let name: String = row.get(1)?;
            groups_map.insert(name, id);
        }
    }

    // 3. Process categories and register new groups safely
    let cat_names: HashMap<String, String> = cats
        .into_iter()
        .filter_map(|f| {
            let category_id = get_serde_json_string(&f.category_id);
            let name = f.category_name.filter(|n| !n.trim().is_empty());
            match (category_id, name) {
                (Some(cid), Some(name)) => Some((cid, name.trim().to_string())),
                _ => None,
            }
        })
        .collect();

    {
        let mut insert_group_stmt = tx.prepare(
            "INSERT OR IGNORE INTO groups (name, source_id, media_type) VALUES (?, ?, ?)",
        )?;
        let mut select_group_stmt = tx.prepare(
            "SELECT id FROM groups WHERE name = ? AND source_id = ?",
        )?;
        for (_cid, name) in &cat_names {
            if !groups_map.contains_key(name) {
                insert_group_stmt.execute(params![name, source_id, stream_type])?;
                let group_id = select_group_stmt
                    .query_row(params![name, source_id], |row| row.get::<_, i64>(0))
                    .ok();
                if let Some(gid) = group_id {
                    groups_map.insert(name.clone(), gid);
                }
            }
        }
    }

    // 4. Pre-format base stream URL prefix to avoid repetitive String formatting in loop
    let base_url = format!(
        "{}/{}/{}/{}/",
        source.url_origin.as_deref().unwrap_or(""),
        get_media_type_string(stream_type)?,
        source.username.as_deref().unwrap_or(""),
        source.password.as_deref().unwrap_or(""),
    );

    // 5. Compute diff
    let mut to_insert: Vec<ChannelInsert> = Vec::new();
    let mut to_update: Vec<ChannelUpdate> = Vec::new();
    let mut unchanged_count: usize = 0;
    let mut seen_stream_ids: std::collections::HashSet<u64> =
        std::collections::HashSet::with_capacity(stage_total);
    let emit_interval = (stage_total / 30).max(100);

    for (idx, stream) in streams.into_iter().enumerate() {
        let stream_id = get_serde_json_u64(&stream.stream_id)
            .or_else(|| get_serde_json_u64(&stream.series_id));
        let stream_id = match stream_id {
            Some(id) if id > 0 => id,
            _ => continue,
        };

        if !seen_stream_ids.insert(stream_id) {
            continue;
        }

        let name = match stream.name.filter(|n| !n.trim().is_empty()) {
            Some(n) => n.trim().to_string(),
            None => continue,
        };

        let category_name = get_serde_json_string(&stream.category_id)
            .and_then(|cid| cat_names.get(&cid).cloned());
        let group_id = category_name.as_ref().and_then(|cn| groups_map.get(cn).copied());

        let image = stream
            .stream_icon
            .or(stream.cover)
            .map(|x| x.trim().to_string());

        let url = if stream_type == media_type::SERIE {
            Some(stream_id.to_string())
        } else {
            let ext = stream
                .container_extension
                .as_deref()
                .unwrap_or(LIVE_STREAM_EXTENSION);
            Some(format!("{base_url}{stream_id}.{ext}"))
        };

        let tv_archive = get_serde_json_u64(&stream.tv_archive).map(|x| x == 1);

        if let Some(existing) = existing_map.remove(&stream_id) {
            let changed = existing.name != name
                || existing.group_id != group_id
                || existing.image != image
                || existing.url != url;
            if changed {
                to_update.push(ChannelUpdate {
                    id: existing.id,
                    name,
                    group_id,
                    image,
                    url,
                });
            } else {
                unchanged_count += 1;
            }
        } else {
            to_insert.push(ChannelInsert {
                name,
                group_id,
                image,
                url,
                stream_id,
                tv_archive,
            });
        }

        *processed_so_far += 1;
        let current_in_stage = idx + 1;
        if (current_in_stage % emit_interval == 0 || current_in_stage == stage_total)
            && app.is_some()
        {
            let stage_pct = (current_in_stage as f64 / stage_total.max(1) as f64) * 100.0;
            let overall_pct = if total_items > 0 {
                30.0 + ((*processed_so_far as f64 / total_items as f64) * 65.0)
            } else {
                30.0
            };
            crate::utils::emit_source_refresh_progress(
                app,
                source_id,
                stage_name,
                &format!(
                    "Syncing {} ({} / {} • {:.0}%)...",
                    stage_prefix, current_in_stage, stage_total, stage_pct
                ),
                Some((overall_pct * 10.0).round() / 10.0),
                false,
                Some(current_in_stage),
                Some(stage_total),
                None,
            );
        }
    }

    // 6. Removed items (streams no longer present in provider catalog)
    let mut to_delete: Vec<i64> = Vec::new();
    for (_sid, item) in existing_map {
        // Protect user favorites, Continue Watching, and hidden channels!
        if !item.favorite && item.last_watched.is_none() && !item.hidden {
            to_delete.push(item.id);
        }
    }

    let diff_duration = t_start.elapsed();

    // 7. Apply DB writes with prepared statements
    let write_start = std::time::Instant::now();
    let to_insert_len = to_insert.len();
    let to_update_len = to_update.len();
    let to_delete_len = to_delete.len();

    if !to_insert.is_empty() {
        let mut insert_stmt = tx.prepare(
            "INSERT OR IGNORE INTO channels (name, group_id, image, url, source_id, media_type, series_id, favorite, stream_id, tv_archive, season_id, episode_num)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, NULL, NULL)",
        )?;
        for item in to_insert {
            insert_stmt.execute(params![
                item.name,
                item.group_id,
                item.image,
                item.url,
                source_id,
                stream_type,
                item.stream_id as i64,
                item.tv_archive,
            ])?;
        }
    }

    if !to_update.is_empty() {
        let mut update_stmt = tx.prepare(
            "UPDATE channels SET name = ?, group_id = ?, image = ?, url = ? WHERE id = ?",
        )?;
        for item in to_update {
            update_stmt.execute(params![
                item.name,
                item.group_id,
                item.image,
                item.url,
                item.id,
            ])?;
        }
    }

    if !to_delete.is_empty() {
        let mut delete_stmt = tx.prepare(
            "DELETE FROM channels WHERE id = ?",
        )?;
        for id in to_delete {
            delete_stmt.execute(params![id])?;
        }
    }

    let write_duration = write_start.elapsed();
    let total_duration = t_start.elapsed();

    log::log(format!(
        "[Catalog Sync] {} completed in {:.2}s (diff: {:.2}s, writes: {:.2}s) — Total: {}, Unchanged: {}, Inserted: {}, Updated: {}, Deleted: {}",
        stage_prefix,
        total_duration.as_secs_f64(),
        diff_duration.as_secs_f64(),
        write_duration.as_secs_f64(),
        stage_total,
        unchanged_count,
        to_insert_len,
        to_update_len,
        to_delete_len
    ));

    Ok(())
}

#[allow(dead_code)]
fn get_cat_name(cats: &HashMap<String, String>, category_id: Option<String>) -> Option<String> {
    if category_id.is_none() {
        return None;
    }
    return cats.get(&category_id.unwrap()).map(|t| t.to_string());
}

#[allow(dead_code)]
fn convert_xtream_live_to_channel(
    stream: XtreamStream,
    source: &Source,
    stream_type: u8,
    category_name: Option<String>,
) -> Result<Channel> {
    let stream_id = get_serde_json_u64(&stream.stream_id)
        .or_else(|| get_serde_json_u64(&stream.series_id));
    let series_id_str = get_serde_json_string(&stream.series_id)
        .or_else(|| get_serde_json_string(&stream.stream_id));
    let name = stream
        .name
        .filter(|n| !n.trim().is_empty())
        .context("No name")?
        .trim()
        .to_string();

    Ok(Channel {
        id: None,
        group: category_name.map(|x| x.trim().to_string()),
        image: stream
            .stream_icon
            .or(stream.cover)
            .map(|x| x.trim().to_string()),
        media_type: stream_type,
        name,
        source_id: source.id,
        url: if stream_type == media_type::SERIE {
            series_id_str
        } else {
            Some(get_url(
                stream_id.context("missing stream id")?.to_string(),
                source,
                stream_type,
                stream.container_extension,
            )?)
        },
        stream_id,
        favorite: false,
        group_id: None,
        series_id: None,
        tv_archive: get_serde_json_u64(&stream.tv_archive).map(|x| x == 1),
        season_id: None,
        episode_num: None,
        hidden: Some(false),
    })
}

fn get_url(
    stream_id: String,
    source: &Source,
    stream_type: u8,
    extension: Option<String>,
) -> Result<String> {
    Ok(format!(
        "{}/{}/{}/{}/{}.{}",
        source.url_origin.clone().unwrap(),
        get_media_type_string(stream_type)?,
        source.username.clone().unwrap(),
        source.password.clone().unwrap(),
        stream_id,
        extension.unwrap_or(LIVE_STREAM_EXTENSION.to_string())
    ))
}

fn get_media_type_string(stream_type: u8) -> Result<String> {
    match stream_type {
        media_type::LIVESTREAM => Ok("live".to_string()),
        media_type::MOVIE => Ok("movie".to_string()),
        media_type::SERIE => Ok("series".to_string()),
        _ => Err(anyhow!("Invalid stream_type")),
    }
}

pub async fn get_episodes(channel: Channel) -> Result<()> {
    let series_id = channel.url.context("no url")?.parse()?;
    if sql::series_has_episodes(series_id, channel.source_id.context("no source id")?)
        .unwrap_or_else(|e| {
            log::log(format!("{:?}", e));
            return false;
        })
    {
        return Ok(());
    }
    let mut source = sql::get_source_from_id(channel.source_id.context("no source id")?)?;
    let mut url = build_xtream_url(&mut source)?;
    let user_agent = get_user_agent_from_source(&source)?;
    url.query_pairs_mut()
        .append_pair("series_id", &series_id.to_string());
    let mut series =
        get_xtream_http_data::<XtreamSeries>(url, GET_SERIES_INFO, &user_agent).await?;
    let mut episodes: Vec<XtreamEpisode> = series
        .episodes
        .into_values()
        .flat_map(|episode| episode)
        .collect();
    series
        .seasons
        .sort_by_key(|f| get_serde_json_i64(&f.season_number));
    let seasons: HashMap<i64, XtreamSeason> = series
        .seasons
        .iter()
        .filter_map(|x| get_serde_json_i64(&x.season_number).map(|y| (y, x.clone())))
        .collect();
    episodes.sort_by(|a, b| {
        get_serde_json_u64(&a.season)
            .cmp(&get_serde_json_u64(&b.season))
            .then_with(|| {
                get_serde_json_u64(&a.episode_num).cmp(&get_serde_json_u64(&b.episode_num))
            })
    });
    insert_episodes(&source, seasons, episodes, series_id, channel.image)?;
    Ok(())
}

fn insert_episodes(
    source: &Source,
    seasons: HashMap<i64, XtreamSeason>,
    episodes: Vec<XtreamEpisode>,
    series_id: u64,
    default_season_image: Option<String>,
) -> Result<()> {
    let mut seasons_db: HashMap<i64, i64> = HashMap::new();
    sql::do_tx(|tx| {
        for episode in episodes {
            match insert_episode(
                episode.clone(),
                source,
                tx,
                &mut seasons_db,
                &seasons,
                series_id,
                default_season_image.clone(),
            )
            .with_context(|| format!("Failed to insert episode {:?}", episode))
            {
                Ok(_) => (),
                Err(e) => {
                    log::log(format!("{:?}", e));
                    continue;
                }
            }
        }
        Ok(())
    })
}

fn insert_episode(
    episode: XtreamEpisode,
    source: &Source,
    tx: &Transaction,
    seasons_db: &mut HashMap<i64, i64>,
    seasons: &HashMap<i64, XtreamSeason>,
    series_id: u64,
    default_season_image: Option<String>,
) -> Result<()> {
    let season_number = get_serde_json_i64(&episode.season).unwrap_or(NO_SEASON_NUMBER);
    let season_id = seasons_db.get(&season_number);
    let season_id: i64 = match season_id {
        Some(s) => s.clone(),
        None => {
            let season = seasons
                .get(&season_number)
                .and_then(|f| {
                    xtream_season_to_season(f.clone(), source.id.unwrap(), series_id)
                        .with_context(|| "Failed to convert XtreamSeason to Season")
                        .inspect_err(|e| log::log(format!("{}", e)))
                        .ok()
                })
                .unwrap_or_else(|| {
                    create_makeshift_season(
                        season_number,
                        series_id,
                        source.id.unwrap(),
                        default_season_image,
                    )
                });
            let id = insert_season(tx, season)?;
            seasons_db.insert(season_number, id);
            id
        }
    };
    let episode = episode_to_channel(episode, &source, series_id, season_id)?;
    sql::insert_channel(&tx, episode)?;
    Ok(())
}

fn create_makeshift_season(
    number: i64,
    series_id: u64,
    source_id: i64,
    image: Option<String>,
) -> Season {
    Season {
        name: match number == NO_SEASON_NUMBER {
            true => "Uncategorized".to_string(),
            false => format!("Season {number}"),
        },
        series_id,
        season_number: number,
        source_id,
        image,
        ..Default::default()
    }
}

fn get_serde_json_string(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(|cid| cid.to_string())
        .or_else(|| value.as_u64().map(|cid| cid.to_string()))
        .map(|cid| cid.trim().to_string())
}

fn get_serde_json_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_str()
        .and_then(|val| val.trim().parse::<u64>().ok())
        .or_else(|| value.as_u64())
}

fn get_serde_json_i64(value: &serde_json::Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|val| val.trim().parse::<i64>().ok())
        .or_else(|| value.as_i64())
}

fn xtream_season_to_season(season: XtreamSeason, source_id: i64, series_id: u64) -> Result<Season> {
    let season_number = get_serde_json_i64(&season.season_number).context("no season number")?;
    Ok(Season {
        season_number,
        series_id,
        source_id,
        image: season.cover_tmdb.or(season.cover).or(season.overview),
        name: format!("Season {season_number}"),
        ..Default::default()
    })
}

fn episode_to_channel(
    episode: XtreamEpisode,
    source: &Source,
    series_id: u64,
    season_id: i64,
) -> Result<Channel> {
    let episode_stream_id = get_serde_json_u64(&episode.id);
    Ok(Channel {
        id: None,
        group: None,
        image: serde_json::from_value::<XtreamEpisodeInfo>(episode.info)
            .map(|e| e.movie_image)
            .unwrap_or_default(),
        media_type: media_type::MOVIE,
        name: episode.title.trim().to_string(),
        source_id: source.id,
        url: Some(get_url(
            get_serde_json_string(&episode.id).context("no id")?,
            &source,
            media_type::SERIE,
            Some(episode.container_extension),
        )?),
        series_id: Some(series_id),
        episode_num: get_serde_json_i64(&episode.episode_num),
        season_id: Some(season_id),
        stream_id: episode_stream_id,
        group_id: None,
        favorite: false,
        tv_archive: None,
        hidden: Some(false),
    })
}

pub async fn get_epg(channel: Channel) -> Result<Vec<EPG>> {
    let mut source = sql::get_source_from_id(channel.source_id.context("no source id")?)?;
    let mut url = build_xtream_url(&mut source)?;
    let user_agent = get_user_agent_from_source(&source)?;
    let stream_id = channel.stream_id.context("No stream id")?.to_string();
    url.query_pairs_mut().append_pair("stream_id", &stream_id);
    let epg: XtreamEPG = get_xtream_http_data(url, GET_EPG, &user_agent).await?;
    let url = get_timeshift_url_base(&source)?;
    let current_time = Local::now();
    let mut otv_epgs = Vec::new();
    for item in epg.epg_listings {
        let item = xtream_epg_to_epg(item, &url, &stream_id)?;
        if is_valid_epg(&item, &current_time)? {
            otv_epgs.push(item);
        }
    }
    Ok(otv_epgs)
}

fn is_valid_epg(epg: &EPG, now: &DateTime<Local>) -> Result<bool> {
    let epg_start_local = crate::utils::get_local_time(epg.start_timestamp)?;
    if epg_start_local < *now && !epg.has_archive && !epg.now_playing {
        return Ok(false);
    }
    Ok(true)
}

fn xtream_epg_to_epg(epg: XtreamEPGItem, url: &Url, stream_id: &str) -> Result<EPG> {
    let start_timestamp =
        get_serde_json_i64(&epg.start_timestamp).context("no valid start timestamp")?;
    Ok(EPG {
        epg_id: get_serde_json_string(&epg.id).context("no epg id")?,
        title: String::from_utf8(BASE64_STANDARD.decode(&epg.title)?)?,
        description: String::from_utf8(BASE64_STANDARD.decode(&epg.description)?)?,
        start_time: get_local_time(start_timestamp)?
            .format("%B %d, %H:%M")
            .to_string(),
        end_time: get_local_time(
            get_serde_json_i64(&epg.stop_timestamp).context("no valid end timestamp")?,
        )?
        .format("%B %d, %H:%M")
        .to_string(),
        start_timestamp,
        timeshift_url: if epg.has_archive == 1 {
            Some(get_timeshift_url(
                url.clone(),
                epg.start,
                epg.end,
                stream_id,
            )?)
        } else {
            None
        },
        has_archive: epg.has_archive == 1,
        now_playing: epg.now_playing == 1,
    })
}

fn get_timeshift_url_base(source: &Source) -> Result<Url> {
    let mut url = Url::parse(source.url_origin.as_ref().context("no origin")?)?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("Can't mutate url"))?
        .extend(&["streaming", "timeshift.php"]);
    url.query_pairs_mut()
        .append_pair("username", source.username.as_ref().context("no username")?)
        .append_pair("password", source.password.as_ref().context("no password")?);
    Ok(url)
}

fn get_timeshift_url(mut url: Url, start: String, end: String, stream_id: &str) -> Result<String> {
    let start = NaiveDateTime::parse_from_str(&start, "%Y-%m-%d %H:%M:%S")?;
    let duration = NaiveDateTime::parse_from_str(&end, "%Y-%m-%d %H:%M:%S")?
        .signed_duration_since(start)
        .num_minutes()
        .to_string();
    let start = start.format("%Y-%m-%d:%H-%M").to_string();
    url.query_pairs_mut()
        .append_pair("stream", stream_id)
        .append_pair("start", &start)
        .append_pair("duration", &duration);
    Ok(url.to_string())
}

async fn get_status(source: &mut Source) -> Result<(i64, XtreamStatus)> {
    let url = build_xtream_url(source)?;
    let user_agent = get_user_agent_from_source(&source)?;
    let client = Client::builder().user_agent(user_agent).build()?;
    let data = client.get(url).send().await?.json::<XtreamStatus>().await?;
    Ok((source.id.context("no id")?, data))
}

pub async fn get_all_expiries() -> Result<HashMap<i64, i64>> {
    let mut sources = sql::get_sources_by_type(source_type::XTREAM)?;
    let to_await = sources.iter_mut().map(|source| get_status(source));
    let results: Vec<std::result::Result<(i64, XtreamStatus), anyhow::Error>> =
        join_all(to_await).await;
    let statuses: HashMap<i64, i64> = results
        .into_iter()
        .flatten()
        .filter_map(|(id, status)| {
            let exp_date = get_serde_json_i64(&status.user_info.exp_date)?;
            Some((id, exp_date))
        })
        .collect();
    Ok(statuses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::XtreamStatusUserInfo;
    use rusqlite::Connection;

    #[test]
    fn test_auth_check_valid() {
        let u1 = XtreamStatusUserInfo {
            auth: serde_json::json!(1),
            status: Some("Active".to_string()),
            exp_date: serde_json::json!("1735689600"),
            message: None,
        };
        assert!(u1.is_auth_successful());

        let u2 = XtreamStatusUserInfo {
            auth: serde_json::json!("1"),
            status: Some("active".to_string()),
            exp_date: serde_json::Value::Null,
            message: None,
        };
        assert!(u2.is_auth_successful());

        let u3 = XtreamStatusUserInfo {
            auth: serde_json::json!(true),
            status: None,
            exp_date: serde_json::Value::Null,
            message: None,
        };
        assert!(u3.is_auth_successful());

        // Provider omitting auth but returning active status
        let u4 = XtreamStatusUserInfo {
            auth: serde_json::Value::Null,
            status: Some("Active".to_string()),
            exp_date: serde_json::Value::Null,
            message: None,
        };
        assert!(u4.is_auth_successful());
    }

    #[test]
    fn test_auth_check_invalid_credentials() {
        let u1 = XtreamStatusUserInfo {
            auth: serde_json::json!(0),
            status: None,
            exp_date: serde_json::Value::Null,
            message: None,
        };
        assert!(!u1.is_auth_successful());

        let u2 = XtreamStatusUserInfo {
            auth: serde_json::json!("0"),
            status: None,
            exp_date: serde_json::Value::Null,
            message: Some("Invalid details".to_string()),
        };
        assert!(!u2.is_auth_successful());

        let u3 = XtreamStatusUserInfo {
            auth: serde_json::Value::Null,
            status: None,
            exp_date: serde_json::Value::Null,
            message: None,
        };
        assert!(!u3.is_auth_successful());
    }

    #[test]
    fn test_auth_check_disabled_expired_banned() {
        for bad_status in &["Disabled", "Expired", "Banned", "Inactive", "disabled"] {
            let u = XtreamStatusUserInfo {
                auth: serde_json::json!(1),
                status: Some(bad_status.to_string()),
                exp_date: serde_json::Value::Null,
                message: None,
            };
            assert!(!u.is_auth_successful(), "Expected failure for status: {}", bad_status);
        }
    }

    #[test]
    fn test_build_xtream_url_normalization() {
        let mut source = Source {
            id: None,
            name: "Test".to_string(),
            url: Some("http://example.com:8080".to_string()),
            username: Some("myuser".to_string()),
            password: Some("mypass".to_string()),
            source_type: source_type::XTREAM,
            enabled: true,
            user_agent: None,
            url_origin: None,
            use_tvg_id: None,
            max_streams: None,
            stream_user_agent: None,
            last_updated: None,
        };
        let url = build_xtream_url(&mut source).unwrap();
        assert_eq!(url.path(), "/player_api.php");
        assert_eq!(source.url_origin, Some("http://example.com:8080".to_string()));
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q.get("username").map(|s| s.as_str()), Some("myuser"));
        assert_eq!(q.get("password").map(|s| s.as_str()), Some("mypass"));

        let mut source2 = Source {
            id: Some(42),
            name: "Test 2".to_string(),
            url: Some("http://example.com:8080/player_api.php".to_string()),
            username: Some("u2".to_string()),
            password: Some("p2".to_string()),
            source_type: source_type::XTREAM,
            enabled: true,
            user_agent: None,
            url_origin: None,
            use_tvg_id: None,
            max_streams: None,
            stream_user_agent: None,
            last_updated: None,
        };
        let url2 = build_xtream_url(&mut source2).unwrap();
        assert_eq!(url2.path(), "/player_api.php");
    }

    #[test]
    fn test_trim_bytes_and_empty_responses() {
        assert_eq!(trim_bytes(b"   "), b"");
        assert_eq!(trim_bytes(b" \r\n  {} \t "), b"{}");
        assert_eq!(trim_bytes(b" null\n"), b"null");
        assert_eq!(
            trim_bytes(b"[{\"category_id\":\"1\",\"category_name\":\"News\"}]"),
            b"[{\"category_id\":\"1\",\"category_name\":\"News\"}]"
        );
    }

    #[test]
    fn test_stream_deserialization_formats() {
        let json_arr = r#"[
            {"stream_id": 101, "name": "Channel One", "category_id": "1", "container_extension": "ts"},
            {"stream_id": "102", "name": "Channel Two", "category_id": 2, "container_extension": "m3u8"}
        ]"#;
        let streams: Vec<XtreamStream> = serde_json::from_str(json_arr).unwrap();
        assert_eq!(streams.len(), 2);
        assert_eq!(get_serde_json_u64(&streams[0].stream_id), Some(101));
        assert_eq!(get_serde_json_u64(&streams[1].stream_id), Some(102));

        let json_map = r#"{
            "101": {"stream_id": 101, "name": "Channel One", "category_id": "1"},
            "102": {"stream_id": 102, "name": "Channel Two", "category_id": "1"}
        }"#;
        let map: HashMap<String, XtreamStream> = serde_json::from_str(json_map).unwrap();
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn test_process_xtream_foreign_keys_and_group_conflicts() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("
            PRAGMA foreign_keys = ON;
            CREATE TABLE sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name varchar(100),
                source_type integer,
                url varchar(500),
                username varchar(100),
                password varchar(100),
                enabled integer DEFAULT 1
            );
            CREATE TABLE groups (
                id INTEGER PRIMARY KEY,
                name varchar(100),
                image varchar(500),
                source_id integer,
                media_type integer,
                FOREIGN KEY (source_id) REFERENCES sources(id)
            );
            CREATE UNIQUE INDEX index_group_unique ON groups(name, source_id);

            CREATE TABLE channels (
                id INTEGER PRIMARY KEY,
                name varchar(100),
                image varchar(500),
                url varchar(500),
                media_type integer,
                source_id integer,
                favorite integer,
                series_id integer,
                group_id integer,
                stream_id integer,
                tv_archive integer,
                season_id integer,
                episode_num integer,
                hidden integer DEFAULT 0,
                last_watched integer,
                FOREIGN KEY (source_id) REFERENCES sources(id),
                FOREIGN KEY (group_id) REFERENCES groups(id)
            );
            CREATE UNIQUE INDEX channels_unique ON channels(name, source_id, url, series_id, season_id);
        ").unwrap();

        let tx = conn.transaction().unwrap();

        // Simulate creating a new source
        tx.execute(
            "INSERT INTO sources (name, source_type, url, username, password, enabled) VALUES ('Test Provider', 2, 'http://test', 'u', 'p', 1)",
            [],
        ).unwrap();
        let valid_source_id = tx.last_insert_rowid();
        assert!(valid_source_id > 0);

        let source = Source {
            id: Some(valid_source_id),
            name: "Test Provider".to_string(),
            url: Some("http://test/player_api.php".to_string()),
            username: Some("u".to_string()),
            password: Some("p".to_string()),
            source_type: source_type::XTREAM,
            enabled: true,
            user_agent: None,
            url_origin: Some("http://test".to_string()),
            use_tvg_id: None,
            max_streams: None,
            stream_user_agent: None,
            last_updated: None,
        };

        // Live categories have "Documentary"
        let live_cats = vec![
            XtreamCategory {
                category_id: serde_json::json!("1"),
                category_name: Some("Documentary".to_string()),
            },
        ];
        let live_streams = vec![
            XtreamStream {
                stream_id: serde_json::json!(1001),
                name: Some("Nature HD".to_string()),
                category_id: serde_json::json!("1"),
                stream_icon: None,
                series_id: serde_json::Value::Null,
                cover: None,
                container_extension: Some("ts".to_string()),
                tv_archive: serde_json::json!(0),
            },
            // Duplicate stream entry from provider
            XtreamStream {
                stream_id: serde_json::json!(1001),
                name: Some("Nature HD".to_string()),
                category_id: serde_json::json!("1"),
                stream_icon: None,
                series_id: serde_json::Value::Null,
                cover: None,
                container_extension: Some("ts".to_string()),
                tv_archive: serde_json::json!(0),
            },
        ];

        let mut processed = 0;
        let res_live = process_xtream(
            &tx,
            live_streams,
            live_cats,
            &source,
            media_type::LIVESTREAM,
            None,
            valid_source_id,
            "live",
            "Live TV",
            &mut processed,
            2,
        );
        assert!(res_live.is_ok(), "Live sync failed: {:?}", res_live.err());

        // Movie categories ALSO have "Documentary" (cross-media group conflict test)
        let vod_cats = vec![
            XtreamCategory {
                category_id: serde_json::json!("20"),
                category_name: Some("Documentary".to_string()),
            },
        ];
        let vod_streams = vec![
            XtreamStream {
                stream_id: serde_json::json!(5001),
                name: Some("Deep Sea Movie".to_string()),
                category_id: serde_json::json!("20"),
                stream_icon: None,
                series_id: serde_json::Value::Null,
                cover: None,
                container_extension: Some("mp4".to_string()),
                tv_archive: serde_json::json!(0),
            },
        ];

        let res_vod = process_xtream(
            &tx,
            vod_streams,
            vod_cats,
            &source,
            media_type::MOVIE,
            None,
            valid_source_id,
            "movies",
            "Movies",
            &mut processed,
            1,
        );
        assert!(res_vod.is_ok(), "VOD sync with cross-media group failed: {:?}", res_vod.err());

        tx.commit().unwrap();

        // Verify counts
        let channel_count: i64 = conn.query_row("SELECT COUNT(1) FROM channels WHERE source_id = ?", [valid_source_id], |r| r.get(0)).unwrap();
        assert_eq!(channel_count, 2); // 1 live channel (deduplicated) + 1 movie

        let group_count: i64 = conn.query_row("SELECT COUNT(1) FROM groups WHERE source_id = ?", [valid_source_id], |r| r.get(0)).unwrap();
        assert_eq!(group_count, 1); // "Documentary" group reused safely
    }
}
