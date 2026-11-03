use std::io::Write;
use std::sync::LazyLock;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
};

use anyhow::{Context, Result, bail};
use regex::{Captures, Regex};
use rusqlite::Transaction;
use tauri::AppHandle;
use types::{Channel, Source};

use crate::types::ChannelPreserve;
use crate::{
    log, media_type, source_type,
    sql::{self, set_channel_group_id},
    types::{self, ChannelHttpHeaders},
    utils::get_user_agent_from_source,
};

static NAME_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tvg-name="(?P<name>[^"]*)""#).unwrap());
static NAME_REGEX_ALT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#",(?P<name>[^\n\r\t]*)"#).unwrap());
static ID_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tvg-id="(?P<id>[^"]*)""#).unwrap());
static LOGO_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tvg-logo="(?P<logo>[^"]*)""#).unwrap());
static GROUP_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"group-title="(?P<group>[^"]*)""#).unwrap());

static HTTP_ORIGIN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"http-origin=(?P<origin>.+)"#).unwrap());
static HTTP_REFERRER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"http-referrer=(?P<referrer>.+)"#).unwrap());
static HTTP_USER_AGENT_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"http-user-agent=(?P<user_agent>.+)"#).unwrap());

struct M3UProcessing {
    channel_line: Option<String>,
    channel_headers: Option<ChannelHttpHeaders>,
    channel_headers_set: bool,
    last_non_empty_line: Option<String>,
    groups: HashMap<String, i64>,
    source_id: i64,
    use_tvg_id: Option<bool>,
    line_count: usize,
}

pub fn read_m3u8(app: Option<&AppHandle>, mut source: Source, wipe: bool) -> Result<()> {
    let source_id = source.id.unwrap_or(0);
    crate::utils::emit_source_refresh_progress(
        app,
        source_id,
        "reading",
        "Reading playlist file...",
        Some(10.0),
        false,
        None,
        None,
        None,
    );
    let path = match source.source_type {
        source_type::M3U_LINK => get_tmp_path(source_id),
        _ => source.url.clone().context("no file path found")?,
    };
    let total_channels = count_playlist_entries(&path)?;
    crate::utils::emit_source_refresh_progress(
        app,
        source_id,
        "parsing",
        &format!(
            "Parsing and validating playlist (0 / {})...",
            total_channels
        ),
        Some(10.0),
        false,
        Some(0),
        Some(total_channels),
        None,
    );
    let file = File::open(path).context("Failed to open m3u8 file")?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines().enumerate();
    let mut sql = sql::get_conn()?;
    let mut channel_preserve: Vec<ChannelPreserve> = Vec::new();
    let tx = sql.transaction()?;
    if wipe {
        channel_preserve =
            sql::get_preserve(&tx, source.id.context("no source id")?).unwrap_or_default();
        sql::wipe(&tx, source.id.context("no source id")?)?;
    } else {
        source.id = Some(sql::create_or_find_source_by_name(&tx, &source)?);
    }
    let mut processing = M3UProcessing {
        channel_headers: None,
        channel_headers_set: false,
        channel_line: None,
        groups: HashMap::new(),
        last_non_empty_line: None,
        source_id: source.id.context("no source id")?,
        use_tvg_id: source.use_tvg_id,
        line_count: 0,
    };
    let mut channel_count = 0;
    let emit_interval = (total_channels / 80).max(25);
    while let Some((c1, l1)) = lines.next() {
        processing.line_count = c1;
        let l1 = match l1.with_context(|| format!("Failed to process line {c1}")) {
            Ok(r) => r,
            Err(e) => {
                log::log(format!("{:?}", e));
                continue;
            }
        };
        let l1_upper = l1.to_uppercase();
        if l1_upper.starts_with("#EXTINF") {
            if processing.channel_line.is_some() {
                try_commit_channel(&mut processing, &tx);
                channel_count += 1;
            }
            if channel_count > 0
                && (channel_count % emit_interval == 0 || channel_count == total_channels)
                && app.is_some()
            {
                crate::utils::emit_source_refresh_progress(
                    app,
                    source_id,
                    "processing",
                    &format!(
                        "Processing channels and categories ({} / {})...",
                        channel_count, total_channels
                    ),
                    Some(10.0 + (channel_count as f64 / total_channels.max(1) as f64) * 85.0),
                    false,
                    Some(channel_count),
                    Some(total_channels),
                    None,
                );
            }
            processing.channel_line = Some(l1);
            processing.channel_headers_set = false;
        } else if l1_upper.starts_with("#EXTVLCOPT") {
            if processing.channel_headers.is_none() {
                processing.channel_headers = Some(ChannelHttpHeaders {
                    ..Default::default()
                });
            }
            if set_http_headers(
                &l1,
                processing.channel_headers.as_mut().context("no headers")?,
            ) {
                processing.channel_headers_set = true;
            }
        } else if !l1.trim().is_empty() {
            processing.last_non_empty_line = Some(l1);
        }
    }
    if processing.channel_line.is_some() {
        try_commit_channel(&mut processing, &tx);
        channel_count += 1;
    }

    crate::utils::emit_source_refresh_progress(
        app,
        source_id,
        "finalizing",
        "Finalizing database...",
        Some(95.0),
        false,
        Some(channel_count),
        Some(total_channels),
        None,
    );

    if wipe {
        sql::restore_preserve(&tx, source.id.context("no source id")?, channel_preserve)?;
    }
    sql::analyze(&tx)?;
    tx.commit()?;
    Ok(())
}

fn try_commit_channel(processing: &mut M3UProcessing, tx: &Transaction) {
    if let Some(channel) = processing.channel_line.take() {
        if !processing.channel_headers_set {
            processing.channel_headers = None;
        }
        commit_channel(
            channel,
            processing.last_non_empty_line.take(),
            &mut processing.groups,
            processing.channel_headers.take(),
            processing.source_id,
            processing.use_tvg_id,
            &tx,
        )
        .with_context(|| {
            format!(
                "Failed to process channel ending at line {}",
                processing.line_count
            )
        })
        .unwrap_or_else(|e| {
            log::log(format!("{:?}", e));
        });
    }
}

fn commit_channel(
    channel_line: String,
    last_line: Option<String>,
    groups: &mut HashMap<String, i64>,
    headers: Option<ChannelHttpHeaders>,
    source_id: i64,
    use_tvg_id: Option<bool>,
    tx: &Transaction,
) -> Result<()> {
    let mut channel = get_channel_from_lines(
        channel_line,
        last_line.context("missing last line")?,
        source_id,
        use_tvg_id,
    )?;
    set_channel_group_id(groups, &mut channel, tx, &source_id).unwrap_or_else(|e| {
        log::log(format!(
            "Failed to set group id for channel: {}, Error: {:?}",
            channel.name, e
        ))
    });
    sql::insert_channel(tx, channel)?;
    if let Some(mut headers) = headers {
        headers.channel_id = Some(tx.last_insert_rowid());
        sql::insert_channel_headers(tx, headers)?;
    }
    Ok(())
}

pub async fn get_m3u8_from_link(app: Option<&AppHandle>, source: Source, wipe: bool) -> Result<()> {
    let source_id = source.id.unwrap_or(0);
    crate::utils::emit_source_refresh_progress(
        app,
        source_id,
        "downloading",
        "Downloading playlist from URL...",
        None,
        true,
        None,
        None,
        None,
    );
    let user_agent = get_user_agent_from_source(&source)?;
    let client = reqwest::Client::builder()
        .user_agent(user_agent)
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()?;
    let url = source.url.clone().context("Invalid source")?;
    let mut response = client.get(&url).send().await?;
    if !response.status().is_success() {
        log::log(format!(
            "Failed to get m3u8 from link, status: {}",
            response.status()
        ));
        bail!(
            "Failed to get m3u8 from link, status: {}",
            response.status()
        );
    }
    let mut file = std::fs::File::create(get_tmp_path(source_id))?;
    while let Some(chunk) = response.chunk().await? {
        file.write(&chunk)?;
    }
    read_m3u8(app, source, wipe)
}

fn get_tmp_path(source_id: i64) -> String {
    let mut path = directories::ProjectDirs::from("dev", "fredol", "open-tv")
        .unwrap()
        .cache_dir()
        .to_owned();
    if !path.exists() {
        std::fs::create_dir_all(&path).unwrap();
    }
    path.push(format!("get-{source_id}.m3u"));
    return path.to_string_lossy().to_string();
}

fn count_playlist_entries(path: &str) -> Result<usize> {
    let file = File::open(path).context("Failed to open m3u8 file for validation")?;
    Ok(BufReader::new(file)
        .lines()
        .filter_map(Result::ok)
        .filter(|line| {
            line.trim_start()
                .to_ascii_uppercase()
                .starts_with("#EXTINF")
        })
        .count())
}

fn extract_non_empty_capture(caps: Captures) -> Option<String> {
    caps.get(1)
        .map(|m| m.as_str().to_string())
        .filter(|s| !s.trim().is_empty())
}

fn set_http_headers(line: &str, headers: &mut ChannelHttpHeaders) -> bool {
    if let Some(origin) = HTTP_ORIGIN_REGEX
        .captures(&line)
        .and_then(extract_non_empty_capture)
    {
        headers.http_origin = Some(origin);
        return true;
    } else if let Some(referrer) = HTTP_REFERRER_REGEX
        .captures(&line)
        .and_then(extract_non_empty_capture)
    {
        headers.referrer = Some(referrer);
        return true;
    } else if let Some(user_agent) = HTTP_USER_AGENT_REGEX
        .captures(&line)
        .and_then(extract_non_empty_capture)
    {
        headers.user_agent = Some(user_agent);
        return true;
    }
    return false;
}

fn get_channel_from_lines(
    first: String,
    mut second: String,
    source_id: i64,
    use_tvg_id: Option<bool>,
) -> Result<Channel> {
    second = second.trim().to_string();
    if second.is_empty() {
        bail!("second line is empty");
    }
    let name = NAME_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture)
        .or_else(|| {
            let id = || {
                ID_REGEX
                    .captures(&first)
                    .and_then(extract_non_empty_capture)
            };
            let name_alt = || {
                NAME_REGEX_ALT
                    .captures(&first)
                    .and_then(extract_non_empty_capture)
            };
            if let Some(true) = use_tvg_id {
                return id().or(name_alt());
            } else {
                return name_alt().or(id());
            }
        })
        .context("Couldn't find name from Name or ID")?;
    let group = GROUP_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture);
    let image = LOGO_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture);
    let channel = Channel {
        id: None,
        name: name.trim().to_string(),
        group: group.map(|x| x.trim().to_string()),
        image: image.map(|x| x.trim().to_string()),
        url: Some(second.clone()),
        media_type: get_media_type(second),
        source_id: Some(source_id),
        series_id: None,
        group_id: None,
        favorite: false,
        stream_id: None,
        tv_archive: None,
        season_id: None,
        episode_num: None,
        hidden: Some(false),
    };
    Ok(channel)
}

fn get_media_type(url: String) -> u8 {
    let media_type = if url.ends_with(".mp4") || url.ends_with(".mkv") {
        media_type::MOVIE
    } else {
        media_type::LIVESTREAM
    };
    return media_type;
}

#[cfg(test)]
mod test_m3u {
    use std::{env, time::Instant};

    use crate::{
        m3u::{get_channel_from_lines, get_m3u8_from_link},
        types::Source,
    };

    use super::read_m3u8;

    #[test]
    fn test_get_channel_from_lines() {
        get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Amazing Channel" tvg-name="Amazing Channel" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0,Some(true)).unwrap();
        get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Amazing Channel" tvg-name="" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0, Some(true)).unwrap();
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="" tvg-name="" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0, Some(true)).is_err());
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id=" " tvg-name="" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0, Some(true)).is_err());
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Id Of Channel" tvg-name="Name Of Channel" tvg-logo="http://myurl.local/amazing/stuff.png" group-title="|EU| FRANCE HEVC",Alt Name Of Channel"#.to_string(), "http://myurl.local/1111/1111.ts".to_string(), 0, Some(true)).unwrap().name == "Name Of Channel");
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Id Of Channel" tvg-name="" tvg-logo="http://myurl.local/amazing/stuff.png" group-title="|EU| FRANCE HEVC",Alt Name Of Channel"#.to_string(), "http://myurl.local/1111/1111.ts".to_string(), 0, Some(true)).unwrap().name == "Id Of Channel");
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Id Of Channel" tvg-name="" tvg-logo="http://myurl.local/amazing/stuff.png" group-title="|EU| FRANCE HEVC",Alt Name Of Channel"#.to_string(), "http://myurl.local/1111/1111.ts".to_string(), 0, Some(false)).unwrap().name == "Alt Name Of Channel");
    }
}
