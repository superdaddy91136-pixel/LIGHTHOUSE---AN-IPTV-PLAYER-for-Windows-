use std::vec;
use std::{collections::HashMap, sync::LazyLock};

use crate::log::log;
use crate::sort_type;
use crate::types::{
    ChannelPreserve, CustomChannel, CustomChannelExtraData, EPGNotify, ExportedGroup,
    FavoriteMapping, Group, IdName, Season,
};
use crate::{
    media_type, source_type,
    types::{Channel, ChannelHttpHeaders, Filters, Source, SourceContentCounts},
    view_type,
};
use anyhow::{Context, Result, anyhow};
use directories::ProjectDirs;
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{InterruptHandle, OptionalExtension, Row, Transaction, params, params_from_iter};
use rusqlite_migration::{M, Migrations};
use std::sync::atomic::{AtomicU64, Ordering};
use url::Url;

const PAGE_SIZE: u8 = 36;
pub const DB_NAME: &str = "db.sqlite";
static CONN: LazyLock<Pool<SqliteConnectionManager>> = LazyLock::new(|| create_connection_pool());
static ACTIVE_SEARCH_HANDLES: LazyLock<std::sync::Mutex<Vec<(u64, InterruptHandle)>>> =
    LazyLock::new(|| std::sync::Mutex::new(Vec::new()));
static SEARCH_HANDLE_COUNTER: AtomicU64 = AtomicU64::new(1);

struct SearchHandleGuard(u64);
impl Drop for SearchHandleGuard {
    fn drop(&mut self) {
        if let Ok(mut handles) = ACTIVE_SEARCH_HANDLES.lock() {
            handles.retain(|(id, _)| *id != self.0);
        }
    }
}

fn register_search_handle(
    sql: &PooledConnection<SqliteConnectionManager>,
    query: Option<&str>,
) -> Option<SearchHandleGuard> {
    if let Some(q) = query {
        if !q.trim().is_empty() {
            let query_id = SEARCH_HANDLE_COUNTER.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut handles) = ACTIVE_SEARCH_HANDLES.lock() {
                handles.push((query_id, sql.get_interrupt_handle()));
            }
            return Some(SearchHandleGuard(query_id));
        }
    }
    None
}

pub fn cancel_active_searches() {
    if let Ok(mut handles) = ACTIVE_SEARCH_HANDLES.lock() {
        for (_, handle) in handles.drain(..) {
            handle.interrupt();
        }
    }
}

pub fn get_conn() -> Result<PooledConnection<SqliteConnectionManager>> {
    CONN.try_get().context("No sqlite conns available")
}

fn create_connection_pool() -> Pool<SqliteConnectionManager> {
    let manager = SqliteConnectionManager::file(get_and_create_sqlite_db_path())
        .with_init(|conn| {
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA busy_timeout = 5000;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA foreign_keys = ON;",
            )
        });
    r2d2::Pool::builder().max_size(20).build(manager).unwrap()
}

pub fn get_sqlite_db_path() -> String {
    get_and_create_sqlite_db_path()
}

fn get_and_create_sqlite_db_path() -> String {
    let mut path = ProjectDirs::from("dev", "fredol", "open-tv")
        .unwrap()
        .data_dir()
        .to_owned();
    if !path.exists() {
        std::fs::create_dir_all(&path).unwrap();
    }
    path.push(DB_NAME);
    return path.to_string_lossy().to_string();
}

fn create_structure_on_conn(sql: &rusqlite::Connection) -> Result<()> {
    sql.execute_batch(
        r#"
CREATE TABLE "sources" (
  "id"          INTEGER PRIMARY KEY,
  "name"        varchar(100),
  "source_type" integer,
  "url"         varchar(500),
  "username"    varchar(100),
  "password"    varchar(100),
  "enabled"     integer DEFAULT 1
);

CREATE TABLE "channels" (
  "id" INTEGER PRIMARY KEY,
  "name" varchar(100),
  "image" varchar(500),
  "url" varchar(500),
  "media_type" integer,
  "source_id" integer,
  "favorite" integer,
  "series_id" integer,
  "group_id" integer,
  FOREIGN KEY (source_id) REFERENCES sources(id)
  FOREIGN KEY (group_id) REFERENCES groups(id)
);

CREATE TABLE "settings" (
  "key" VARCHAR(50) PRIMARY KEY,
  "value" VARCHAR(100)
);

CREATE TABLE "groups" (
  "id" INTEGER PRIMARY KEY,
  "name" varchar(100),
  "image" varchar(500),
  "source_id" integer,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE INDEX index_channel_name ON channels(name);
CREATE UNIQUE INDEX channels_unique ON channels(name, url);

CREATE UNIQUE INDEX index_source_name ON sources(name);
CREATE INDEX index_source_enabled ON sources(enabled);

CREATE UNIQUE INDEX index_group_unique ON groups(name, source_id);
CREATE INDEX index_group_name ON groups(name);

CREATE INDEX index_channel_source_id ON channels(source_id);
CREATE INDEX index_channel_favorite ON channels(favorite);
CREATE INDEX index_channel_series_id ON channels(series_id);
CREATE INDEX index_channel_group_id ON channels(group_id);
CREATE INDEX index_channel_media_type ON channels(media_type);

CREATE INDEX index_group_source_id ON groups(source_id);
"#,
    )?;
    Ok(())
}

fn structure_exists() -> Result<bool> {
    let sql = get_conn()?;
    let table_exists: bool = sql
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels' LIMIT 1",
            [],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some();
    Ok(table_exists)
}

pub fn create_or_initialize_db() -> Result<()> {
    let mut sql = get_conn()?;
    sql.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    if !structure_exists()? {
        create_structure_on_conn(&sql)?;
    }
    apply_migrations_on_conn(&mut sql)?;
    if let Err(e) = backfill_watch_history_on_conn(&mut sql) {
        log(format!("Failed to backfill watch_history: {:?}", e));
    }
    Ok(())
}

fn apply_migrations_on_conn(sql: &mut rusqlite::Connection) -> Result<()> {
    let migrations = Migrations::new(vec![
        M::up(
            r#"
                DROP INDEX IF EXISTS channels_unique;
                CREATE UNIQUE INDEX channels_unique ON channels(name, url, source_id);
                CREATE TABLE IF NOT EXISTS "channel_http_headers" (
                    "id" INTEGER PRIMARY KEY,
                    "channel_id" integer,
                    "referrer" varchar(500),
                    "user_agent" varchar(500),
                    "http_origin" varchar(500),
                    "ignore_ssl" integer DEFAULT 0,
                    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
                );
                CREATE UNIQUE INDEX IF NOT EXISTS index_channel_http_headers_channel_id ON channel_http_headers(channel_id);
                ALTER TABLE sources ADD COLUMN use_tvg_id integer;
                UPDATE sources SET use_tvg_id = 1 WHERE source_type in (0,1);
            "#,
        ),
        M::up(
            r#"
                ALTER TABLE channels ADD COLUMN stream_id integer;
                CREATE INDEX IF NOT EXISTS index_channels_stream_id on channels(stream_id);
                CREATE TABLE IF NOT EXISTS "epg" (
                  "id" INTEGER PRIMARY KEY,
                  "epg_id" varchar(25),
                  "channel_name" varchar(100),
                  "title" varchar(100),
                  "start_timestamp" INTEGER
                );
                CREATE UNIQUE INDEX IF NOT EXISTS index_epg_epg_id on epg(epg_id);
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE channels ADD COLUMN last_watched integer;
              CREATE INDEX index_channels_last_watched on channels(last_watched);

              DROP INDEX IF EXISTS channels_unique;
              DELETE FROM channels
              WHERE ROWID NOT IN (
                  SELECT MIN(ROWID)
                  FROM channels
                  GROUP BY name, source_id
              );
              CREATE UNIQUE INDEX channels_unique ON channels(name, source_id);
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE channels ADD COLUMN tv_archive integer;
              CREATE INDEX index_channels_tv_archive on channels(tv_archive);
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE groups
              ADD COLUMN media_type INTEGER;
              CREATE INDEX index_groups_media_type ON groups(media_type);

              ALTER TABLE channels
              ADD COLUMN season_id INTEGER;
              CREATE INDEX index_channels_season_id ON channels(season_id);

              ALTER TABLE channels
              ADD COLUMN episode_num INTEGER;
              CREATE INDEX index_channels_episode_num on channels(episode_num);

              CREATE TABLE IF NOT EXISTS "seasons" (
                "id" INTEGER PRIMARY KEY,
                "name" VARCHAR(50),
                "season_number" INTEGER,
                "series_id" INTEGER,
                "source_id" INTEGER,
                "image" varchar(200),
                FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
              );
              CREATE INDEX index_seasons_name ON seasons(name);
              CREATE UNIQUE INDEX unique_seasons ON seasons(season_number, series_id, source_id);
            "#,
        ),
        M::up(
            r#"
              DROP INDEX IF EXISTS channels_unique;
              CREATE UNIQUE INDEX channels_unique ON channels(name, source_id, url, series_id, season_id);
        "#,
        ),
        M::up(
            r#"
              ALTER TABLE sources ADD COLUMN user_agent varchar(500);
              ALTER TABLE sources ADD COLUMN max_streams integer;
              ALTER TABLE sources ADD COLUMN stream_user_agent varchar(500);
              ALTER TABLE channels ADD COLUMN hidden integer DEFAULT 0;
              ALTER TABLE groups ADD COLUMN hidden integer DEFAULT 0;
              CREATE INDEX index_channels_hidden ON channels(hidden);
              CREATE INDEX index_groups_hidden ON groups(hidden);
              ANALYZE;
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE sources ADD COLUMN last_updated integer;
              ANALYZE;
            "#,
        ),
        M::up(
            r#"
              ALTER TABLE channels ADD COLUMN favorite_added integer;
              -- Historical favorites predate this field, so retain their stable
              -- catalog order beneath favorites added after this migration.
              UPDATE channels SET favorite_added = 0
              WHERE favorite = 1 AND favorite_added IS NULL;
              CREATE INDEX index_channels_favorite_added
              ON channels(favorite, favorite_added DESC);
            "#,
        ),
        M::up(
            r#"
              CREATE INDEX IF NOT EXISTS index_channels_group_hidden
              ON channels(group_id, hidden);
              CREATE INDEX IF NOT EXISTS index_channels_fav_media_hidden
              ON channels(favorite, media_type, hidden);
            "#,
        ),
        M::up(
            r#"
              CREATE INDEX IF NOT EXISTS index_channels_source_media_hidden
              ON channels(source_id, media_type, hidden, series_id);
            "#,
        ),
        M::up(
            r#"
              CREATE TABLE IF NOT EXISTS "source_refresh_state" (
                "source_id" INTEGER PRIMARY KEY,
                "last_successful_refresh" INTEGER,
                "last_refresh_attempt" INTEGER,
                "last_error" TEXT,
                FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
              );
            "#,
        ),
        M::up(
            r#"
              CREATE TABLE IF NOT EXISTS "watch_history" (
                "id"                     INTEGER PRIMARY KEY,
                "identity_key"           TEXT NOT NULL UNIQUE,
                "channel_id"             INTEGER,
                "source_id"              INTEGER,
                "source_missing"         INTEGER NOT NULL DEFAULT 0,
                "source_type"            INTEGER NOT NULL,
                "source_fingerprint"     TEXT NOT NULL,
                "source_host"            TEXT,
                "source_username"        TEXT,
                "source_name"            TEXT,
                "media_type"             INTEGER NOT NULL,
                "is_episode"             INTEGER NOT NULL DEFAULT 0,
                "provider_stream_id"     INTEGER,
                "provider_series_id"     INTEGER,
                "season_number"          INTEGER,
                "episode_number"         INTEGER,
                "stream_url_path"        TEXT,
                "stream_url"             TEXT,
                "channel_name"           TEXT NOT NULL,
                "normalized_title"       TEXT NOT NULL,
                "show_title"             TEXT,
                "normalized_show_title"  TEXT,
                "release_year"           INTEGER,
                "tmdb_id"                INTEGER,
                "last_watched"           INTEGER NOT NULL,
                "position_sec"           REAL NOT NULL DEFAULT 0,
                "duration_sec"           REAL NOT NULL DEFAULT 0,
                "progress_percent"       REAL NOT NULL DEFAULT 0,
                "completed"              INTEGER NOT NULL DEFAULT 0,
                "updated_at"             INTEGER NOT NULL,
                "next_ep_stream_id"      INTEGER,
                "next_ep_season_number"  INTEGER,
                "next_ep_episode_number" INTEGER,
                "next_ep_channel_id"     INTEGER
              );
              CREATE INDEX IF NOT EXISTS index_wh_visible_recent
                ON watch_history(source_missing, last_watched DESC);
              CREATE INDEX IF NOT EXISTS index_wh_channel_id
                ON watch_history(channel_id);
              CREATE INDEX IF NOT EXISTS index_wh_source_id
                ON watch_history(source_id);
              CREATE INDEX IF NOT EXISTS index_wh_relink_stream
                ON watch_history(source_fingerprint, media_type, provider_stream_id);
              CREATE INDEX IF NOT EXISTS index_wh_relink_episode
                ON watch_history(source_fingerprint, provider_series_id, season_number, episode_number);
              CREATE INDEX IF NOT EXISTS index_wh_relink_title
                ON watch_history(media_type, is_episode, normalized_title);
              CREATE INDEX IF NOT EXISTS index_wh_relink_tmdb
                ON watch_history(tmdb_id, is_episode, season_number, episode_number);
            "#,
        ),
    ]);
    migrations.to_latest(sql)?;
    Ok(())
}

pub fn drop_db() -> Result<()> {
    let sql = get_conn()?;
    sql.execute_batch(
        "DROP TABLE channels; DROP TABLE groups; DROP TABLE sources; DROP TABLE settings;",
    )?;
    Ok(())
}

pub fn create_or_find_source_by_name(tx: &Transaction, source: &Source) -> Result<i64> {
    let id: Option<i64> = tx
        .query_row(
            "SELECT id FROM sources WHERE name = ?1",
            params![source.name],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = id {
        return Ok(id);
    }
    tx.execute(
    "INSERT INTO sources (name, source_type, url, username, password, use_tvg_id, user_agent, max_streams, last_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    params![source.name, source.source_type.clone() as u8, source.url, source.username, source.password, source.use_tvg_id, source.user_agent, source.max_streams, chrono::Utc::now().timestamp()],
    )?;
    Ok(tx.last_insert_rowid())
}

pub fn insert_season(tx: &Transaction, season: Season) -> Result<i64> {
    tx.execute(
        r#"
        INSERT INTO seasons (name, image, series_id, season_number, source_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (series_id, season_number, source_id)
        DO UPDATE SET
          image = excluded.image,
          name = excluded.name
        "#,
        params![
            season.name,
            season.image,
            season.series_id,
            season.season_number,
            season.source_id,
        ],
    )?;
    Ok(tx.query_row(
        r#"
        SELECT id
        FROM seasons
        WHERE series_id = ?
        AND season_number = ?
        AND source_id = ?
      "#,
        params![season.series_id, season.season_number, season.source_id],
        |r| r.get(0),
    )?)
}

pub fn insert_channel(tx: &Transaction, channel: Channel) -> Result<()> {
    let mut stmt = tx.prepare_cached(
        r#"
INSERT INTO channels (name, group_id, image, url, source_id, media_type, series_id, favorite, stream_id, tv_archive, season_id, episode_num)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (name, source_id, url, series_id, season_id)
DO UPDATE SET
    url = excluded.url,
    media_type = excluded.media_type,
    stream_id = excluded.stream_id,
    image = excluded.image,
    group_id = excluded.group_id,
    series_id = excluded.series_id,
    tv_archive = excluded.tv_archive,
    season_id = excluded.season_id;
"#,
    )?;
    stmt.execute(params![
        channel.name,
        channel.group_id,
        channel.image,
        channel.url,
        channel.source_id,
        channel.media_type as u8,
        channel.series_id,
        channel.favorite,
        channel.stream_id,
        channel.tv_archive,
        channel.season_id,
        channel.episode_num
    ])?;
    Ok(())
}

pub fn insert_channel_headers(tx: &Transaction, headers: ChannelHttpHeaders) -> Result<()> {
    let mut stmt = tx.prepare_cached(
        r#"
INSERT OR IGNORE INTO channel_http_headers (channel_id, referrer, user_agent, http_origin, ignore_ssl)
VALUES (?, ?, ?, ?, ?);
"#,
    )?;
    stmt.execute(params![
        headers.channel_id,
        headers.referrer,
        headers.user_agent,
        headers.http_origin,
        headers.ignore_ssl
    ])?;
    Ok(())
}

fn get_or_insert_group(
    tx: &Transaction,
    group: &str,
    image: &Option<String>,
    source_id: &i64,
    media_type: u8,
) -> Result<i64> {
    let mut insert_stmt = tx.prepare_cached(
        r#"
        INSERT OR IGNORE INTO groups (name, image, source_id, media_type)
        VALUES (?, ?, ?, ?);
        "#,
    )?;
    let rows_changed = insert_stmt.execute(params![group, &image, source_id, media_type])?;
    if rows_changed == 0 {
        let mut select_stmt = tx.prepare_cached(
            "SELECT id FROM groups WHERE name = ? and source_id = ?",
        )?;
        return Ok(select_stmt.query_row(
            params![group, source_id],
            |row| row.get::<_, i64>("id"),
        )?);
    }
    Ok(tx.last_insert_rowid())
}

pub fn set_channel_group_id(
    groups: &mut HashMap<String, i64>,
    channel: &mut Channel,
    tx: &Transaction,
    source_id: &i64,
) -> Result<()> {
    if channel.group.is_none() {
        return Ok(());
    }
    if !groups.contains_key(channel.group.as_ref().unwrap()) {
        let id = get_or_insert_group(
            tx,
            channel.group.as_ref().unwrap(),
            &channel.image,
            source_id,
            channel.media_type,
        )?;
        groups.insert(channel.group.clone().unwrap(), id);
        channel.group_id = Some(id);
    } else {
        channel.group_id = groups
            .get(channel.group.as_ref().unwrap())
            .map(|x| x.to_owned());
    }
    Ok(())
}

pub fn get_channel_headers_by_id(id: i64) -> Result<Option<ChannelHttpHeaders>> {
    let sql = get_conn()?;
    let headers = sql
        .query_row(
            "SELECT * FROM channel_http_headers WHERE channel_id = ?",
            params![id],
            row_to_channel_headers,
        )
        .optional()?;
    Ok(headers)
}

fn row_to_channel_headers(row: &Row) -> Result<ChannelHttpHeaders, rusqlite::Error> {
    Ok(ChannelHttpHeaders {
        id: row.get("id")?,
        channel_id: row.get("channel_id")?,
        http_origin: row.get("http_origin")?,
        referrer: row.get("referrer")?,
        user_agent: row.get("user_agent")?,
        ignore_ssl: row.get("ignore_ssl")?,
    })
}

pub fn get_settings() -> Result<HashMap<String, String>> {
    let sql = get_conn()?;
    let map = sql
        .prepare("SELECT key, value FROM Settings")?
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(map)
}

pub fn update_settings(map: HashMap<String, Option<String>>) -> Result<()> {
    let mut sql: PooledConnection<SqliteConnectionManager> = get_conn()?;
    let tx = sql.transaction()?;
    for (key, value) in map {
        tx.execute(
            r#"
            INSERT INTO Settings (key, value)
            VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = ?2
            "#,
            params![key, value],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn get_setting_value(key: &str) -> Result<Option<String>> {
    let sql = get_conn()?;
    let val = sql
        .query_row(
            "SELECT value FROM Settings WHERE key = ?1 LIMIT 1",
            params![key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    Ok(val)
}

pub fn set_setting_value(key: &str, value: Option<String>) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        INSERT INTO Settings (key, value)
        VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = ?2
        "#,
        params![key, value],
    )?;
    Ok(())
}

pub fn get_storage_counts() -> Result<(u64, u64, u64)> {
    let sql = get_conn()?;
    let history_count: i64 = sql.query_row(
        "SELECT COUNT(1) FROM channels WHERE last_watched IS NOT NULL",
        [],
        |row| row.get(0),
    )?;
    let hidden_channels: i64 = sql.query_row(
        "SELECT COUNT(1) FROM channels WHERE hidden = 1",
        [],
        |row| row.get(0),
    )?;
    let hidden_groups: i64 = sql.query_row(
        "SELECT COUNT(1) FROM groups WHERE hidden = 1",
        [],
        |row| row.get(0),
    )?;
    let favorites_count: i64 = sql.query_row(
        "SELECT COUNT(1) FROM channels WHERE favorite = 1",
        [],
        |row| row.get(0),
    )?;
    Ok((
        history_count.max(0) as u64,
        (hidden_channels + hidden_groups).max(0) as u64,
        favorites_count.max(0) as u64,
    ))
}

pub fn search(filters: Filters) -> Result<Vec<Channel>> {
    if filters.view_type == view_type::CATEGORIES
        && filters.group_id.is_none()
        && filters.series_id.is_none()
    {
        return search_group(filters);
    }
    if filters.view_type == view_type::HIDDEN {
        return search_hidden(filters);
    }
    if filters.series_id.is_some()
        && filters.season.is_none()
        && filters.view_type != view_type::HISTORY
    {
        return search_series(filters);
    }
    let sql = get_conn()?;
    let _guard = register_search_handle(&sql, filters.query.as_deref());
    let offset: u32 = (filters.page.max(1) as u32 - 1) * PAGE_SIZE as u32;
    let media_types = match filters.series_id.is_some() {
        true => vec![1],
        false => filters.media_types.clone().unwrap(),
    };
    let query = filters.query.unwrap_or("".to_string());
    let keywords: Vec<String> = match filters.use_keywords {
        true => {
            let mut words: Vec<&str> = query.split(' ').filter(|w| !w.is_empty()).collect();
            words.sort_by(|a, b| b.len().cmp(&a.len()));
            words.into_iter().map(|f| format!("%{f}%")).collect()
        }
        false => vec![format!("%{query}%")],
    };
    let mut sql_query = format!(
        r#"
        SELECT * FROM CHANNELS
        WHERE ({})
        AND media_type IN ({})
        AND source_id IN ({})
        AND url IS NOT NULL
        AND hidden = 0"#,
        get_keywords_sql(keywords.len()),
        generate_placeholders(media_types.len()),
        generate_placeholders(filters.source_ids.len()),
    );
    let mut baked_params = 2;
    if filters.view_type == view_type::FAVORITES && filters.series_id.is_none() {
        sql_query += "\nAND favorite = 1";
    }

    if filters.series_id.is_some() {
        sql_query += &format!("\nAND series_id = ?");
        baked_params += 1;
    } else {
        if filters.view_type != view_type::HISTORY {
            sql_query += "\nAND series_id IS NULL AND season_id IS NULL AND episode_num IS NULL";
        }
        if filters.group_id.is_some() {
            sql_query += &format!("\nAND group_id = ?");
            baked_params += 1;
        }
    }
    if filters.season.is_some() {
        sql_query += &format!("\nAND season_id = ?");
        baked_params += 1;
    }
    let order = match filters.sort {
        sort_type::ALPHABETICAL_DESC => "DESC",
        _ => "ASC",
    };
    if filters.view_type == view_type::HISTORY {
        sql_query += "\nAND last_watched IS NOT NULL";
        sql_query += "\nORDER BY last_watched DESC";
    } else if filters.view_type == view_type::FAVORITES {
        sql_query += "\nORDER BY favorite_added DESC, id DESC";
    } else if filters.season.is_some() {
        sql_query += &format!("\nORDER BY episode_num {0}, name {0}", order)
    } else if filters.sort != sort_type::PROVIDER {
        sql_query += &format!("\nORDER BY name {}", order);
    }
    sql_query += "\nLIMIT ?, ?";
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(
        baked_params + media_types.len() + filters.source_ids.len() + keywords.len(),
    );
    params.extend(to_to_sql(&keywords));
    params.extend(to_to_sql(&media_types));
    params.extend(to_to_sql(&filters.source_ids));
    if let Some(ref series_id) = filters.series_id {
        params.push(series_id);
    } else if let Some(ref group) = filters.group_id {
        params.push(group);
    }
    if let Some(ref season) = filters.season {
        params.push(season);
    }
    params.push(&offset);
    params.push(&PAGE_SIZE);
    let channels: Vec<Channel> = {
        let mut stmt = sql.prepare(&sql_query)?;
        match stmt.query_map(params_from_iter(params), row_to_channel) {
            Ok(mapped) => mapped.filter_map(Result::ok).collect(),
            Err(rusqlite::Error::SqliteFailure(ffi_err, _)) if ffi_err.extended_code == 9 => {
                Vec::new()
            }
            Err(e) => return Err(e.into()),
        }
    };
    Ok(channels)
}

fn search_series(filters: Filters) -> Result<Vec<Channel>> {
    let sql = get_conn()?;
    let _guard = register_search_handle(&sql, filters.query.as_deref());
    let offset: u32 = (filters.page.max(1) as u32 - 1) * PAGE_SIZE as u32;
    let query = filters.query.unwrap_or("".to_string());
    let keywords: Vec<String> = match filters.use_keywords {
        true => {
            let mut words: Vec<&str> = query.split(' ').filter(|w| !w.is_empty()).collect();
            words.sort_by(|a, b| b.len().cmp(&a.len()));
            words.into_iter().map(|f| format!("%{f}%")).collect()
        }
        false => vec![format!("%{query}%")],
    };
    let mut sql_query = format!(
        r#"
      SELECT *
      FROM seasons
      WHERE ({})
      AND source_id = ?
      AND series_id = ?
      "#,
        get_keywords_sql(keywords.len()),
    );
    let order = match filters.sort {
        sort_type::ALPHABETICAL_DESC => "DESC",
        _ => "ASC",
    };
    sql_query += &format!("\nORDER BY season_number {}", order);
    sql_query += "\nLIMIT ?, ?";
    let mut params: Vec<&dyn rusqlite::ToSql> =
        Vec::with_capacity(2 + filters.source_ids.len() + keywords.len());
    params.extend(to_to_sql(&keywords));
    params.push(filters.source_ids.first().context("no source ids")?);
    params.push(filters.series_id.as_ref().context("no series id")?);
    params.push(&offset);
    params.push(&PAGE_SIZE);
    let channels: Vec<Channel> = sql
        .prepare(&sql_query)?
        .query_map(params_from_iter(params), season_row_to_channel)?
        .filter_map(Result::ok)
        .collect();
    Ok(channels)
}

fn season_row_to_channel(row: &Row) -> std::result::Result<Channel, rusqlite::Error> {
    Ok(Channel {
        id: row.get("id")?,
        image: row.get("image")?,
        favorite: false,
        group: None,
        group_id: None,
        media_type: media_type::SEASON,
        name: row.get("name")?,
        series_id: row.get("series_id")?,
        season_id: None,
        source_id: None,
        stream_id: None,
        tv_archive: None,
        url: None,
        episode_num: None,
        hidden: Some(false),
    })
}

use crate::bulk_action_type;

fn get_action_params(action: u8) -> Result<(&'static str, u8)> {
    match action {
        bulk_action_type::HIDE => Ok((bulk_action_type::FIELD_HIDDEN, 1)),
        bulk_action_type::UNHIDE => Ok((bulk_action_type::FIELD_HIDDEN, 0)),
        bulk_action_type::FAVORITE => Ok((bulk_action_type::FIELD_FAVORITE, 1)),
        bulk_action_type::UNFAVORITE => Ok((bulk_action_type::FIELD_FAVORITE, 0)),
        _ => Err(anyhow!("Invalid action")),
    }
}

fn favorite_update_assignment(field: &str, value: u8) -> String {
    if field == bulk_action_type::FIELD_FAVORITE {
        format!(
            "favorite = {value}, favorite_added = CASE WHEN {value} = 1 THEN CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) ELSE NULL END"
        )
    } else {
        format!("{field} = {value}")
    }
}

pub fn bulk_update(filters: Filters, action: u8) -> Result<()> {
    if filters.series_id.is_some() && filters.season.is_none() {
        return Ok(());
    }

    let (field, value) = get_action_params(action)?;

    let query = filters.query.as_deref().unwrap_or("");
    let keywords: Vec<String> = match filters.use_keywords {
        true => {
            let mut words: Vec<&str> = query.split(' ').filter(|w| !w.is_empty()).collect();
            words.sort_by(|a, b| b.len().cmp(&a.len()));
            words.into_iter().map(|f| format!("%{f}%")).collect()
        }
        false => vec![format!("%{query}%")],
    };

    if filters.view_type == view_type::CATEGORIES
        && filters.group_id.is_none()
        && filters.series_id.is_none()
    {
        return apply_bulk_categories(&filters, field, value, &keywords);
    }

    if filters.view_type == view_type::HIDDEN {
        return apply_bulk_hidden(&filters, field, value, &keywords);
    }

    apply_bulk_channels(&filters, field, value, &keywords)
}

fn apply_bulk_categories(
    filters: &Filters,
    field: &str,
    value: u8,
    keywords: &[String],
) -> Result<()> {
    if field == bulk_action_type::FIELD_FAVORITE {
        return Ok(());
    }

    let sql = get_conn()?;
    let media_types = filters
        .media_types
        .as_ref()
        .context("media types not found")?;

    let mut sql_query = format!(
        r#"
        UPDATE groups
        SET {} = {}
        WHERE ({})
        AND source_id in ({})
        AND (media_type IS NULL OR media_type in ({}))
        "#,
        field,
        value,
        get_keywords_sql(keywords.len()),
        generate_placeholders(filters.source_ids.len()),
        generate_placeholders(media_types.len())
    );

    sql_query += "\nAND hidden = 0";

    let mut params: Vec<&dyn rusqlite::ToSql> =
        Vec::with_capacity(keywords.len() + filters.source_ids.len() + media_types.len());
    params.extend(to_to_sql(keywords));
    params.extend(to_to_sql(&filters.source_ids));
    params.extend(to_to_sql(media_types));

    sql.execute(&sql_query, params_from_iter(params))?;
    Ok(())
}

fn apply_bulk_hidden(filters: &Filters, field: &str, value: u8, keywords: &[String]) -> Result<()> {
    let sql = get_conn()?;
    let media_types = match filters.series_id.is_some() {
        true => vec![1],
        false => filters
            .media_types
            .clone()
            .context("media types not found")?,
    };

    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();
    let assignment = favorite_update_assignment(field, value);

    let sql_query_channels = format!(
        r#"
        UPDATE channels
        SET {}
        WHERE ({})
        AND media_type IN ({})
        AND source_id IN ({})
        AND url IS NOT NULL
        AND hidden = 1
        "#,
        assignment,
        get_keywords_sql(keywords.len()),
        generate_placeholders(media_types.len()),
        generate_placeholders(filters.source_ids.len())
    );
    params.extend(to_to_sql(keywords));
    params.extend(to_to_sql(&media_types));
    params.extend(to_to_sql(&filters.source_ids));

    sql.execute(&sql_query_channels, params_from_iter(params))?;

    if field != bulk_action_type::FIELD_FAVORITE {
        let mut params_groups: Vec<&dyn rusqlite::ToSql> = Vec::new();
        let sql_query_groups = format!(
            r#"
            UPDATE groups
            SET {} = {}
            WHERE ({})
            AND source_id IN ({})
            AND (media_type IS NULL OR media_type IN ({}))
            AND hidden = 1
            "#,
            field,
            value,
            get_keywords_sql(keywords.len()),
            generate_placeholders(filters.source_ids.len()),
            generate_placeholders(media_types.len())
        );
        params_groups.extend(to_to_sql(keywords));
        params_groups.extend(to_to_sql(&filters.source_ids));
        params_groups.extend(to_to_sql(&media_types));
        sql.execute(&sql_query_groups, params_from_iter(params_groups))?;
    }
    Ok(())
}

fn apply_bulk_channels(
    filters: &Filters,
    field: &str,
    value: u8,
    keywords: &[String],
) -> Result<()> {
    let sql = get_conn()?;
    let media_types = match filters.series_id.is_some() {
        true => vec![1],
        false => filters
            .media_types
            .clone()
            .context("media types not found")?,
    };
    let assignment = favorite_update_assignment(field, value);

    let mut sql_query = format!(
        r#"
        UPDATE channels
        SET {}
        WHERE ({})
        AND media_type IN ({})
        AND source_id IN ({})
        AND url IS NOT NULL
        AND hidden = 0"#,
        assignment,
        get_keywords_sql(keywords.len()),
        generate_placeholders(media_types.len()),
        generate_placeholders(filters.source_ids.len()),
    );

    if filters.view_type == view_type::FAVORITES && filters.series_id.is_none() {
        sql_query += "\nAND favorite = 1";
    }

    if filters.series_id.is_some() {
        sql_query += "\nAND series_id = ?";
    } else {
        if filters.view_type != view_type::HISTORY {
            sql_query += "\nAND series_id IS NULL AND season_id IS NULL AND episode_num IS NULL";
        }
        if filters.group_id.is_some() {
            sql_query += "\nAND group_id = ?";
        }
    }
    if filters.season.is_some() {
        sql_query += "\nAND season_id = ?";
    }

    if filters.view_type == view_type::HISTORY {
        sql_query += "\nAND last_watched IS NOT NULL";
    }

    let mut params: Vec<&dyn rusqlite::ToSql> =
        Vec::with_capacity(media_types.len() + filters.source_ids.len() + keywords.len() + 3);
    params.extend(to_to_sql(keywords));
    params.extend(to_to_sql(&media_types));
    params.extend(to_to_sql(&filters.source_ids));
    if let Some(ref series_id) = filters.series_id {
        params.push(series_id);
    } else if let Some(ref group) = filters.group_id {
        params.push(group);
    }
    if let Some(ref season) = filters.season {
        params.push(season);
    }

    sql.execute(&sql_query, params_from_iter(params))?;
    Ok(())
}

fn search_hidden(filters: Filters) -> Result<Vec<Channel>> {
    let sql = get_conn()?;
    let _guard = register_search_handle(&sql, filters.query.as_deref());
    let offset: u32 = (filters.page.max(1) as u32 - 1) * PAGE_SIZE as u32;

    let media_types = match filters.series_id.is_some() {
        true => vec![1],
        false => filters.media_types.clone().unwrap(),
    };

    let query = filters.query.unwrap_or("".to_string());
    let keywords: Vec<String> = match filters.use_keywords {
        true => {
            let mut words: Vec<&str> = query.split(' ').filter(|w| !w.is_empty()).collect();
            words.sort_by(|a, b| b.len().cmp(&a.len()));
            words.into_iter().map(|f| format!("%{f}%")).collect()
        }
        false => vec![format!("%{query}%")],
    };

    let keywords_sql = get_keywords_sql(keywords.len());
    let media_placeholders = generate_placeholders(media_types.len());
    let source_placeholders = generate_placeholders(filters.source_ids.len());

    let sql_query = format!(
        r#"
        SELECT id, image, name, series_id, source_id, stream_id, tv_archive, url, episode_num, hidden, media_type, NULL as group_id, NULL as season_id, favorite
        FROM channels
        WHERE ({})
        AND media_type IN ({})
        AND source_id IN ({})
        AND hidden = 1
        AND series_id IS NULL
        UNION ALL
        SELECT id, image, name, NULL as series_id, source_id, NULL as stream_id, NULL as tv_archive, NULL as url, NULL as episode_num, hidden, 3 as media_type, NULL as group_id, NULL as season_id, 0 as favorite
        FROM groups
        WHERE ({})
        AND source_id IN ({})
        AND (media_type IS NULL OR media_type IN ({}))
        AND hidden = 1
        ORDER BY name ASC
        LIMIT ?, ?
        "#,
        keywords_sql,
        media_placeholders,
        source_placeholders,
        keywords_sql,
        source_placeholders,
        media_placeholders
    );

    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();

    // Channels params
    params.extend(to_to_sql(&keywords));
    params.extend(to_to_sql(&media_types));
    params.extend(to_to_sql(&filters.source_ids));

    // Groups params
    params.extend(to_to_sql(&keywords));
    params.extend(to_to_sql(&filters.source_ids));
    params.extend(to_to_sql(&media_types));

    params.push(&offset);
    params.push(&PAGE_SIZE);

    let channels: Vec<Channel> = sql
        .prepare(&sql_query)?
        .query_map(params_from_iter(params), row_to_channel)?
        .filter_map(Result::ok)
        .collect();

    Ok(channels)
}

fn to_to_sql<T: rusqlite::ToSql>(values: &[T]) -> Vec<&dyn rusqlite::ToSql> {
    values.iter().map(|x| x as &dyn rusqlite::ToSql).collect()
}

fn get_keywords_sql(size: usize) -> String {
    std::iter::repeat("name LIKE ?")
        .take(size)
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn generate_placeholders(size: usize) -> String {
    std::iter::repeat("?")
        .take(size)
        .collect::<Vec<_>>()
        .join(",")
}

pub fn series_has_episodes(series_id: u64, source_id: i64) -> Result<bool> {
    let sql = get_conn()?;
    let series_exists = sql
        .query_row(
            r#"
      SELECT 1
      FROM channels
      WHERE series_id = ? AND source_id = ?
      LIMIT 1
    "#,
            params![series_id, source_id],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some();
    Ok(series_exists)
}

fn to_sql_like(query: Option<String>) -> String {
    query.map(|x| format!("%{x}%")).unwrap_or("%".to_string())
}

pub fn search_group(filters: Filters) -> Result<Vec<Channel>> {
    let sql = get_conn()?;
    let _guard = register_search_handle(&sql, filters.query.as_deref());
    let offset: u32 = (filters.page.max(1) as u32 - 1) * PAGE_SIZE as u32;
    let query = filters.query.unwrap_or("".to_string());
    let media_types = filters.media_types.context("no media types")?;
    let keywords: Vec<String> = match filters.use_keywords {
        true => {
            let mut words: Vec<&str> = query.split(' ').filter(|w| !w.is_empty()).collect();
            words.sort_by(|a, b| b.len().cmp(&a.len()));
            words.into_iter().map(|f| format!("%{f}%")).collect()
        }
        false => vec![format!("%{query}%")],
    };
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(2 + filters.source_ids.len());
    let count_subquery = if query.trim().is_empty() {
        "(SELECT COUNT(1) FROM channels c WHERE c.group_id = groups.id AND c.hidden = 0) as channel_count"
    } else {
        "NULL as channel_count"
    };
    let mut sql_query = format!(
        r#"
        SELECT *, {}
        FROM groups
        WHERE ({})
        AND source_id in ({})
        AND (media_type IS NULL OR media_type in ({}))
    "#,
        count_subquery,
        get_keywords_sql(keywords.len()),
        generate_placeholders(filters.source_ids.len()),
        generate_placeholders(media_types.len())
    );
    sql_query += "\nAND hidden = 0";
    if filters.sort != sort_type::PROVIDER {
        let order = match filters.sort {
            sort_type::ALPHABETICAL_ASC => "ASC",
            sort_type::ALPHABETICAL_DESC => "DESC",
            _ => "ASC",
        };
        sql_query += &format!("\nORDER BY name {}", order);
    }
    sql_query += "\nLIMIT ?, ?";
    params.extend(to_to_sql(&keywords));
    params.extend(to_to_sql(&filters.source_ids));
    params.extend(to_to_sql(&media_types));
    params.push(&offset);
    params.push(&PAGE_SIZE);
    let channels: Vec<Channel> = {
        let mut stmt = sql.prepare(&sql_query)?;
        match stmt.query_map(params_from_iter(params), row_to_group) {
            Ok(mapped) => mapped.filter_map(Result::ok).collect(),
            Err(rusqlite::Error::SqliteFailure(ffi_err, _)) if ffi_err.extended_code == 9 => {
                Vec::new()
            }
            Err(e) => return Err(e.into()),
        }
    };
    Ok(channels)
}

fn row_to_group(row: &Row) -> std::result::Result<Channel, rusqlite::Error> {
    let channel = Channel {
        id: row.get("id")?,
        name: row.get("name")?,
        group: None,
        image: row.get("image")?,
        media_type: media_type::GROUP,
        url: None,
        series_id: None,
        group_id: None,
        favorite: false,
        source_id: row.get("source_id")?,
        stream_id: row
            .get::<_, Option<i64>>("channel_count")
            .ok()
            .flatten()
            .map(|c| c.max(0) as u64),
        tv_archive: None,
        season_id: None,
        episode_num: None,
        hidden: row.get("hidden")?,
    };
    Ok(channel)
}

fn row_to_channel(row: &Row) -> std::result::Result<Channel, rusqlite::Error> {
    let channel = Channel {
        id: row.get("id")?,
        name: row.get("name")?,
        group_id: row.get("group_id")?,
        image: row.get("image")?,
        media_type: row.get("media_type")?,
        source_id: row.get("source_id")?,
        url: row.get("url")?,
        favorite: row.get("favorite")?,
        episode_num: row.get("episode_num")?,
        series_id: row.get("series_id")?,
        group: None,
        stream_id: row.get("stream_id")?,
        tv_archive: row.get("tv_archive")?,
        season_id: row.get("season_id")?,
        hidden: row.get("hidden")?,
    };
    Ok(channel)
}

pub fn delete_channels_by_source(tx: &Transaction, source_id: i64) -> Result<()> {
    tx.execute(
        r#"
        DELETE FROM channels
        WHERE source_id = ?
    "#,
        params![source_id],
    )?;
    Ok(())
}

pub fn delete_seasons_by_source(tx: &Transaction, source_id: i64) -> Result<()> {
    tx.execute(
        r#"
        DELETE FROM seasons
        WHERE source_id = ?
    "#,
        params![source_id],
    )?;
    Ok(())
}

pub fn delete_groups_by_source(tx: &Transaction, source_id: i64) -> Result<()> {
    tx.execute(
        r#"
        DELETE FROM groups
        WHERE source_id = ?
    "#,
        params!(source_id),
    )?;
    Ok(())
}

fn detach_watch_history_for_source(tx: &Transaction, source_id: i64) -> Result<()> {
    tx.execute(
        r#"
        UPDATE watch_history
        SET channel_id = NULL,
            source_id = NULL,
            source_missing = 1
        WHERE source_id = ?1
    "#,
        params![source_id],
    )?;
    Ok(())
}

pub fn delete_source(id: i64) -> Result<()> {
    let mut sql = get_conn()?;
    delete_source_on_conn(&mut sql, id)
}

fn delete_source_on_conn(sql: &mut rusqlite::Connection, id: i64) -> Result<()> {
    let tx = sql.transaction()?;
    if let Err(e) = detach_watch_history_for_source(&tx, id) {
        log(format!(
            "Failed to detach watch_history for source {id}: {:?}",
            e
        ));
    }
    tx.execute(
        r#"
        DELETE FROM channels
        WHERE source_id = ?;
    "#,
        params![id],
    )?;
    tx.execute(
        r#"
        DELETE FROM groups
        WHERE source_id = ?;
    "#,
        params![id],
    )?;
    tx.execute(
        r#"
        DELETE FROM seasons
        WHERE source_id = ?;
    "#,
        params![id],
    )?;
    let _ = tx.execute(
        r#"
        DELETE FROM source_refresh_state
        WHERE source_id = ?;
    "#,
        params![id],
    );
    let count = tx.execute(
        r#"
        DELETE FROM sources
        WHERE id = ?;
    "#,
        params![id],
    )?;
    if count != 1 {
        return Err(anyhow!("No sources were deleted"));
    }
    tx.execute("ANALYZE;", params![])?;
    tx.commit()?;
    Ok(())
}

pub fn get_channel_count_by_source(id: i64) -> Result<u64> {
    let sql = get_conn()?;
    let count = sql.query_row(
        "SELECT COUNT(*) FROM channels WHERE source_id = ?",
        params![id],
        |row| row.get::<_, u64>(0),
    )?;
    Ok(count)
}

pub fn get_source_content_counts(id: i64) -> Result<SourceContentCounts> {
    let sql = get_conn()?;
    let counts = sql.query_row(
        r#"
        SELECT 
            COUNT(CASE WHEN media_type = 0 THEN 1 END),
            COUNT(CASE WHEN media_type = 1 AND series_id IS NULL THEN 1 END),
            COUNT(CASE WHEN media_type = 2 THEN 1 END)
        FROM channels
        WHERE source_id = ?
        "#,
        params![id],
        |row| {
            Ok(SourceContentCounts {
                live: row.get(0)?,
                movies: row.get(1)?,
                series: row.get(2)?,
            })
        },
    )?;
    Ok(counts)
}

pub fn get_all_source_content_counts() -> Result<HashMap<i64, SourceContentCounts>> {
    let sql = get_conn()?;
    let mut stmt = sql.prepare(
        r#"
        SELECT 
            source_id,
            COUNT(CASE WHEN media_type = 0 THEN 1 END),
            COUNT(CASE WHEN media_type = 1 AND series_id IS NULL THEN 1 END),
            COUNT(CASE WHEN media_type = 2 THEN 1 END)
        FROM channels
        WHERE source_id IS NOT NULL
        GROUP BY source_id
        "#,
    )?;
    let mut map = HashMap::new();
    let rows = stmt.query_map([], |row| {
        let source_id: i64 = row.get(0)?;
        let counts = SourceContentCounts {
            live: row.get(1)?,
            movies: row.get(2)?,
            series: row.get(3)?,
        };
        Ok((source_id, counts))
    })?;
    for row in rows {
        let (id, counts) = row?;
        map.insert(id, counts);
    }
    Ok(map)
}

pub fn source_name_exists(name: &str) -> Result<bool> {
    let sql = get_conn()?;
    Ok(sql
        .query_row(
            r#"
    SELECT 1
    FROM sources
    WHERE name = ?1
    "#,
            [name],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some())
}

pub fn favorite_channel(channel_id: i64, favorite: bool) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE channels
        SET favorite = ?1,
            favorite_added = CASE
                WHEN ?1 = 1 AND (favorite = 0 OR favorite IS NULL OR favorite_added IS NULL)
                    THEN CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                WHEN ?1 = 1 THEN favorite_added
                ELSE NULL
            END
        WHERE id = ?2
    "#,
        params![favorite, channel_id],
    )?;
    Ok(())
}

pub fn hide_channel(channel_id: i64, hidden: bool) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE channels
        SET hidden = ?1
        WHERE id = ?2
    "#,
        params![hidden, channel_id],
    )?;
    Ok(())
}

pub fn hide_group(group_id: i64, hidden: bool) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE groups
        SET hidden = ?1
        WHERE id = ?2
    "#,
        params![hidden, group_id],
    )?;
    Ok(())
}

pub fn remove_last_watched(channel_id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE channels
        SET last_watched = NULL
        WHERE id = ?1
    "#,
        params![channel_id],
    )?;
    Ok(())
}

pub fn get_sources() -> Result<Vec<Source>> {
    let sql = get_conn()?;
    let sources: Vec<Source> = sql
        .prepare("SELECT * FROM sources")?
        .query_map([], row_to_source)?
        .filter_map(Result::ok)
        .collect();
    Ok(sources)
}

pub fn get_sources_by_type(source_type: u8) -> Result<Vec<Source>> {
    let sql = get_conn()?;
    let sources: Vec<Source> = sql
        .prepare("SELECT * FROM sources WHERE source_type = ?")?
        .query_map([source_type], row_to_source)?
        .filter_map(Result::ok)
        .collect();
    Ok(sources)
}

pub fn get_enabled_sources() -> Result<Vec<Source>> {
    let sql = get_conn()?;
    let sources: Vec<Source> = sql
        .prepare("SELECT * FROM sources WHERE enabled = 1")?
        .query_map([], row_to_source)?
        .filter_map(Result::ok)
        .collect();
    Ok(sources)
}

fn row_to_source(row: &Row) -> std::result::Result<Source, rusqlite::Error> {
    Ok(Source {
        id: row.get("id")?,
        name: row.get("name")?,
        username: row.get("username")?,
        password: row.get("password")?,
        url: row.get("url")?,
        source_type: row.get("source_type")?,
        url_origin: None,
        enabled: row.get("enabled")?,
        use_tvg_id: row.get("use_tvg_id")?,
        user_agent: row.get("user_agent")?,
        max_streams: row.get("max_streams")?,
        stream_user_agent: row.get("stream_user_agent")?,
        last_updated: row.get("last_updated")?,
    })
}

pub fn get_source_from_id(source_id: i64) -> Result<Source> {
    let sql = get_conn()?;
    Ok(sql.query_row(
        r#"
    SELECT * FROM sources where id = ?"#,
        [source_id],
        row_to_source,
    )?)
}

pub fn set_source_enabled(value: bool, source_id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE sources
        SET enabled = ?
        WHERE id = ?
    "#,
        params![value, source_id],
    )?;
    Ok(())
}

pub fn add_custom_channel(tx: &Transaction, channel: CustomChannel) -> Result<()> {
    insert_channel(tx, channel.data)?;
    if let Some(mut headers) = channel.headers {
        if channel_headers_empty(&headers) {
            return Ok(());
        }
        headers.channel_id = Some(tx.last_insert_rowid());
        insert_channel_headers(tx, headers)?;
    }
    Ok(())
}

fn channel_headers_empty(headers: &ChannelHttpHeaders) -> bool {
    return headers.ignore_ssl.is_none()
        && headers.http_origin.is_none()
        && headers.referrer.is_none()
        && headers.user_agent.is_none();
}

pub fn get_custom_source(name: String) -> Source {
    Source {
        id: None,
        name: name.to_string(),
        enabled: true,
        username: None,
        password: None,
        source_type: source_type::CUSTOM,
        url: None,
        url_origin: None,
        use_tvg_id: None,
        user_agent: None,
        max_streams: None,
        stream_user_agent: None,
        last_updated: None,
    }
}

pub fn edit_custom_channel(channel: CustomChannel) -> Result<()> {
    let mut sql = get_conn()?;
    let tx = sql.transaction()?;
    match edit_custom_channel_tx(channel, &tx) {
        Ok(_) => {
            tx.commit()?;
            Ok(())
        }
        Err(e) => {
            tx.rollback().unwrap_or_else(|e| log(format!("{:?}", e)));
            return Err(e);
        }
    }
}

fn edit_custom_channel_tx(channel: CustomChannel, tx: &Transaction) -> Result<()> {
    tx.execute(
        r#"
        UPDATE channels
        SET name = ?, image = ?, url = ?, media_type = ?, group_id = ?
        WHERE id = ?
    "#,
        params![
            channel.data.name,
            channel.data.image,
            channel.data.url,
            channel.data.media_type,
            channel.data.group_id,
            channel.data.id
        ],
    )?;
    if let Some(mut headers) = channel.headers {
        headers.channel_id = channel.data.id;
        tx.execute(
            r#"
            INSERT INTO channel_http_headers (referrer, user_agent, http_origin, ignore_ssl, channel_id)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(channel_id) DO UPDATE SET
                referrer = ?1,
                user_agent = ?2,
                http_origin = ?3,
                ignore_ssl = ?4
        "#,
            params![
                headers.referrer,
                headers.user_agent,
                headers.http_origin,
                headers.ignore_ssl,
                headers.channel_id
            ],
        )?;
    } else {
        tx.execute(
            "DELETE FROM channel_http_headers WHERE channel_id = ?",
            params![channel.data.id],
        )?;
    }
    Ok(())
}

pub fn delete_custom_channel(id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute("DELETE FROM channels WHERE id = ?", params![id])?;
    Ok(())
}

pub fn group_exists(name: &str, source_id: i64) -> Result<bool> {
    let sql = get_conn()?;
    Ok(sql
        .query_row(
            r#"
            SELECT 1
            FROM groups
            WHERE name = ? AND source_id = ?
        "#,
            params![name, source_id],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some())
}

pub fn channel_exists(name: &str, url: &str, source_id: i64) -> Result<bool> {
    let sql = get_conn()?;
    Ok(sql
        .query_row(
            r#"
            SELECT 1
            FROM channels
            WHERE name = ? AND source_id = ? AND url = ?
        "#,
            params![name, source_id, url],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some())
}

pub fn add_custom_group(tx: &Transaction, group: Group) -> Result<i64> {
    tx.execute(
        r#"
        INSERT INTO groups (name, image, source_id)
        VALUES (?, ?, ?)
    "#,
        params!(group.name, group.image, group.source_id),
    )?;
    Ok(tx.last_insert_rowid())
}

pub fn group_auto_complete(query: Option<String>, source_id: i64) -> Result<Vec<IdName>> {
    let sql = get_conn()?;
    let groups = sql
        .prepare(
            r#"
        SELECT id, name
        FROM groups
        WHERE name LIKE ?
        AND source_id = ?
    "#,
        )?
        .query_map(params![to_sql_like(query), source_id], row_to_id_name)?
        .filter_map(Result::ok)
        .collect();
    Ok(groups)
}

fn row_to_id_name(row: &Row) -> Result<IdName, rusqlite::Error> {
    Ok(IdName {
        id: row.get("id")?,
        name: row.get("name")?,
    })
}

pub fn edit_custom_group(group: Group) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE groups
        SET name = ?, image = ?
        WHERE id = ?
    "#,
        params![group.name, group.image, group.id],
    )?;
    Ok(())
}

fn get_group_by_id(id: i64) -> Result<Option<Group>> {
    let sql = get_conn()?;
    let group: Option<Group> = sql
        .query_row(
            "SELECT * FROM groups WHERE id = ?",
            params![id],
            row_to_custom_group,
        )
        .optional()?;
    Ok(group)
}

fn row_to_custom_group(row: &Row) -> Result<Group, rusqlite::Error> {
    Ok(Group {
        id: row.get("id")?,
        name: row.get("name")?,
        image: row.get("image")?,
        source_id: row.get("source_id")?,
        hidden: row.get("hidden")?,
    })
}

pub fn get_custom_channel_extra_data(
    id: i64,
    group_id: Option<i64>,
) -> Result<CustomChannelExtraData> {
    Ok(CustomChannelExtraData {
        headers: get_channel_headers_by_id(id)?,
        group: match group_id {
            None => None,
            Some(group) => get_group_by_id(group)?,
        },
    })
}

pub fn delete_custom_group(id: i64, new_id: Option<i64>, do_channels_update: bool) -> Result<()> {
    let sql = get_conn()?;
    if do_channels_update {
        sql.execute(
            r#"
        UPDATE channels
        SET group_id = ?
        WHERE group_id = ?
    "#,
            params![new_id, id],
        )?;
    }
    sql.execute(
        r#"
        DELETE FROM groups
        WHERE id = ?
    "#,
        params![id],
    )?;
    Ok(())
}

pub fn group_not_empty(id: i64) -> Result<bool> {
    let sql = get_conn()?;
    Ok(sql
        .query_row(
            r#"
                SELECT 1
                FROM channels
                WHERE group_id = ?
            "#,
            params![id],
            |row| row.get::<_, u8>(0),
        )
        .optional()?
        .is_some())
}

pub fn get_custom_channels(group_id: Option<i64>, source_id: i64) -> Result<Vec<CustomChannel>> {
    let sql = get_conn()?;
    let mut sql_query = r#"
        SELECT c.name, c.image, c.url, c.media_type, ch.referrer, ch.user_agent, ch.http_origin, ch.ignore_ssl
        FROM channels c
        LEFT JOIN channel_http_headers ch on ch.channel_id = c.id
        WHERE source_id = ?
    "#.to_string();
    let mut params: Vec<i64> = Vec::with_capacity(2);
    params.push(source_id);
    if let Some(id) = group_id {
        sql_query.push_str("\nAND group_id = ?");
        params.push(id);
    } else {
        sql_query.push_str("\nAND group_id IS NULL");
    }
    let result = sql
        .prepare(&sql_query)?
        .query_map(params_from_iter(params), row_to_custom_channel)?
        .filter_map(Result::ok)
        .collect();
    Ok(result)
}

fn row_to_custom_channel(row: &Row) -> Result<CustomChannel, rusqlite::Error> {
    Ok(CustomChannel {
        data: Channel {
            name: row.get("name")?,
            image: row.get("image")?,
            url: row.get("url")?,
            media_type: row.get("media_type")?,
            favorite: false,
            group_id: None,
            group: None,
            id: None,
            series_id: None,
            source_id: None,
            stream_id: None,
            tv_archive: None,
            season_id: None,
            episode_num: None,
            hidden: Some(false),
        },
        headers: Some(ChannelHttpHeaders {
            http_origin: row.get("http_origin")?,
            ignore_ssl: row.get("ignore_ssl")?,
            referrer: row.get("referrer")?,
            user_agent: row.get("user_agent")?,
            channel_id: None,
            id: None,
        }),
    })
}

fn get_groups_by_source_id(id: i64) -> Result<Vec<Group>> {
    let sql = get_conn()?;
    let result = sql
        .prepare(
            r#"
        SELECT *
        FROM groups
        WHERE source_id = ?
    "#,
        )?
        .query_map(params![id], row_to_custom_group)?
        .filter_map(Result::ok)
        .collect();
    Ok(result)
}

pub fn get_custom_groups(source_id: i64) -> Result<Vec<ExportedGroup>> {
    let groups = get_groups_by_source_id(source_id)?;
    let mut export: Vec<ExportedGroup> = Vec::new();
    for group in groups {
        export.push(ExportedGroup {
            group: Group {
                name: group.name,
                image: group.image,
                source_id: None,
                id: None,
                hidden: Some(false),
            },
            channels: get_custom_channels(group.id, source_id)?,
        });
    }
    Ok(export)
}

pub fn do_tx<F, T>(f: F) -> Result<T>
where
    F: FnOnce(&Transaction) -> Result<T>,
{
    let mut sql = get_conn()?;
    let tx = sql.transaction()?;
    let result = f(&tx)?;
    tx.commit()?;
    Ok(result)
}

pub fn update_source(source: Source) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        UPDATE sources
        SET username = ?, password = ?, url = ?, use_tvg_id = ?, user_agent = ?, max_streams = ?, stream_user_agent = ?
        WHERE id = ?"#,
        params![
            source.username,
            source.password,
            source.url,
            source.use_tvg_id,
            source.user_agent,
            source.max_streams,
            source.stream_user_agent,
            source.id
        ],
    )?;
    Ok(())
}

pub fn wipe(tx: &Transaction, id: i64) -> Result<()> {
    // Only wipe top-level catalog channels (Live TV, Movies, TV Show titles).
    // Preserve episodes (series_id IS NOT NULL) and seasons so cached episodes, watch history, and Continue Watching are protected.
    tx.execute(
        "DELETE FROM channels WHERE source_id = ? AND series_id IS NULL",
        params![id],
    )?;
    delete_groups_by_source(tx, id)?;
    Ok(())
}

pub fn get_channel_count_by_media_type(
    tx: &Transaction,
    source_id: i64,
    stream_type: u8,
) -> Result<i64> {
    let count: i64 = match stream_type {
        media_type::LIVESTREAM => tx.query_row(
            "SELECT COUNT(1) FROM channels WHERE source_id = ? AND media_type = 0",
            params![source_id],
            |row| row.get(0),
        )?,
        media_type::MOVIE => tx.query_row(
            "SELECT COUNT(1) FROM channels WHERE source_id = ? AND media_type = 1 AND series_id IS NULL",
            params![source_id],
            |row| row.get(0),
        )?,
        media_type::SERIE => tx.query_row(
            "SELECT COUNT(1) FROM channels WHERE source_id = ? AND media_type = 2",
            params![source_id],
            |row| row.get(0),
        )?,
        _ => 0,
    };
    Ok(count)
}

pub fn wipe_by_media_type(tx: &Transaction, source_id: i64, stream_type: u8) -> Result<()> {
    match stream_type {
        media_type::LIVESTREAM => {
            tx.execute(
                "DELETE FROM channels WHERE source_id = ? AND media_type = 0",
                params![source_id],
            )?;
            tx.execute(
                "DELETE FROM groups WHERE source_id = ? AND media_type = 0",
                params![source_id],
            )?;
        }
        media_type::MOVIE => {
            tx.execute(
                "DELETE FROM channels WHERE source_id = ? AND media_type = 1 AND series_id IS NULL",
                params![source_id],
            )?;
            tx.execute(
                "DELETE FROM groups WHERE source_id = ? AND media_type = 1",
                params![source_id],
            )?;
        }
        media_type::SERIE => {
            tx.execute(
                "DELETE FROM channels WHERE source_id = ? AND media_type = 2",
                params![source_id],
            )?;
            tx.execute(
                "DELETE FROM groups WHERE source_id = ? AND media_type = 2",
                params![source_id],
            )?;
        }
        _ => {}
    }
    Ok(())
}

pub fn clean_epgs() -> Result<()> {
    let sql = get_conn()?;
    sql.execute_batch(
        r#"
          DELETE FROM epg
          WHERE start_timestamp < strftime('%s', 'now')
        "#,
    )?;
    Ok(())
}

pub fn add_epg(epg: EPGNotify) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        "INSERT INTO epg (epg_id, channel_name, title, start_timestamp) VALUES (?,?,?,?)",
        params![epg.epg_id, epg.channel_name, epg.title, epg.start_timestamp],
    )?;
    Ok(())
}

pub fn remove_epg(epg_id: String) -> Result<()> {
    let sql = get_conn()?;
    sql.execute("DELETE FROM epg WHERE epg_id = ?", params![epg_id])?;
    Ok(())
}

pub fn get_epgs() -> Result<Vec<EPGNotify>> {
    let sql = get_conn()?;
    let epgs = sql
        .prepare("SELECT * FROM epg")?
        .query_map(params![], row_to_epg)?
        .filter_map(Result::ok)
        .collect();
    Ok(epgs)
}

pub fn get_epg_ids() -> Result<Vec<String>> {
    let sql = get_conn()?;
    let epgs = sql
        .prepare("SELECT epg_id FROM epg")?
        .query_map(params![], |row| row.get::<_, String>(0))?
        .filter_map(Result::ok)
        .collect();
    Ok(epgs)
}

fn row_to_epg(row: &Row) -> Result<EPGNotify, rusqlite::Error> {
    Ok(EPGNotify {
        epg_id: row.get("epg_id")?,
        channel_name: row.get("channel_name")?,
        start_timestamp: row.get("start_timestamp")?,
        title: row.get("title")?,
    })
}

pub fn get_preserve(tx: &Transaction, source_id: i64) -> Result<Vec<ChannelPreserve>> {
    let mut channels: Vec<ChannelPreserve> = tx
        .prepare(
            r#"
              SELECT name, url, media_type, stream_id, series_id, season_id, episode_num,
                     favorite, favorite_added, last_watched, hidden
              FROM channels
              WHERE (favorite = 1 OR last_watched IS NOT NULL OR hidden = 1)
              AND source_id = ?
            "#,
        )?
        .query_map(params![source_id], row_to_channel_preserve)?
        .filter_map(Result::ok)
        .collect();

    let groups: Vec<ChannelPreserve> = tx
        .prepare(
            r#"
              SELECT name, hidden
              FROM groups
              WHERE hidden = 1
              AND source_id = ?
            "#,
        )?
        .query_map(params![source_id], row_to_group_preserve)?
        .filter_map(Result::ok)
        .collect();

    channels.extend(groups);
    Ok(channels)
}

fn row_to_channel_preserve(row: &Row) -> Result<ChannelPreserve, rusqlite::Error> {
    Ok(ChannelPreserve {
        name: row.get("name")?,
        url: row.get("url")?,
        media_type: row.get("media_type")?,
        stream_id: row.get("stream_id")?,
        series_id: row.get("series_id")?,
        season_id: row.get("season_id")?,
        episode_num: row.get("episode_num")?,
        favorite: row.get("favorite")?,
        favorite_added: row.get("favorite_added")?,
        last_watched: row.get("last_watched")?,
        hidden: row.get("hidden")?,
        is_group: false,
    })
}

fn row_to_group_preserve(row: &Row) -> Result<ChannelPreserve, rusqlite::Error> {
    Ok(ChannelPreserve {
        name: row.get("name")?,
        url: None,
        media_type: 0,
        stream_id: None,
        series_id: None,
        season_id: None,
        episode_num: None,
        hidden: row.get("hidden")?,
        favorite: false,
        favorite_added: None,
        last_watched: None,
        is_group: true,
    })
}

pub fn restore_preserve(
    tx: &Transaction,
    source_id: i64,
    preserve: Vec<ChannelPreserve>,
) -> Result<()> {
    if preserve.is_empty() {
        return Ok(());
    }
    let mut update_group_stmt = tx.prepare_cached(
        "UPDATE groups SET hidden = ? WHERE name = ? AND source_id = ?",
    )?;
    let mut update_by_stream_id_stmt = tx.prepare_cached(
        "UPDATE channels SET favorite = ?, favorite_added = ?, last_watched = ?, hidden = ?
         WHERE source_id = ? AND stream_id = ?",
    )?;
    let mut update_by_url_stmt = tx.prepare_cached(
        "UPDATE channels SET favorite = ?, favorite_added = ?, last_watched = ?, hidden = ?
         WHERE source_id = ? AND url = ?",
    )?;
    let mut update_by_name_stmt = tx.prepare_cached(
        "UPDATE channels SET favorite = ?, favorite_added = ?, last_watched = ?, hidden = ?
         WHERE source_id = ? AND name = ? AND media_type = ?
           AND series_id IS ? AND season_id IS ? AND episode_num IS ?",
    )?;

    for item in preserve {
        if item.is_group {
            let _ = update_group_stmt.execute(params![item.hidden, item.name, source_id]);
        } else if let Some(stream_id) = item.stream_id {
            let rows = update_by_stream_id_stmt.execute(params![
                item.favorite,
                item.favorite_added,
                item.last_watched,
                item.hidden,
                source_id,
                stream_id,
            ])?;
            if rows == 0 {
                if let Some(ref url) = item.url {
                    let _ = update_by_url_stmt.execute(params![
                        item.favorite,
                        item.favorite_added,
                        item.last_watched,
                        item.hidden,
                        source_id,
                        url,
                    ]);
                }
            }
        } else if let Some(ref url) = item.url {
            let _ = update_by_url_stmt.execute(params![
                item.favorite,
                item.favorite_added,
                item.last_watched,
                item.hidden,
                source_id,
                url,
            ]);
        } else {
            let _ = update_by_name_stmt.execute(params![
                item.favorite,
                item.favorite_added,
                item.last_watched,
                item.hidden,
                source_id,
                item.name,
                item.media_type,
                item.series_id,
                item.season_id,
                item.episode_num,
            ]);
        }
    }
    Ok(())
}

/// Returns credential-free favorite mappings for a single source.
pub fn get_favorite_mappings(tx: &Transaction, source_id: i64) -> Result<Vec<FavoriteMapping>> {
    let items: Vec<FavoriteMapping> = tx
        .prepare(
            r#"
              SELECT name, media_type, stream_id, series_id, season_id, episode_num, favorite_added
              FROM channels
              WHERE favorite = 1 AND source_id = ?
            "#,
        )?
        .query_map(params![source_id], |row| {
            Ok(FavoriteMapping {
                name: row.get("name")?,
                media_type: row.get("media_type")?,
                stream_id: row.get("stream_id")?,
                series_id: row.get("series_id")?,
                season_id: row.get("season_id")?,
                episode_num: row.get("episode_num")?,
                favorite_added: row.get("favorite_added")?,
            })
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(items)
}

/// Restores favorite flags additively for matching channels in a source.
pub fn restore_favorite_mappings(
    tx: &Transaction,
    source_id: i64,
    mappings: &[FavoriteMapping],
) -> Result<usize> {
    if mappings.is_empty() {
        return Ok(0);
    }
    let mut update_by_stream_id_stmt = tx.prepare_cached(
        "UPDATE channels SET favorite = 1, favorite_added = COALESCE(favorite_added, ?)
         WHERE source_id = ? AND stream_id = ?",
    )?;
    let mut update_by_name_stmt = tx.prepare_cached(
        "UPDATE channels SET favorite = 1, favorite_added = COALESCE(favorite_added, ?)
         WHERE source_id = ? AND name = ? AND media_type = ?
           AND series_id IS ? AND season_id IS ? AND episode_num IS ?",
    )?;

    let mut restored = 0usize;
    for item in mappings {
        let mut rows = 0usize;
        if let Some(stream_id) = item.stream_id {
            rows = update_by_stream_id_stmt.execute(params![
                item.favorite_added,
                source_id,
                stream_id,
            ])?;
        }
        if rows == 0 {
            rows = update_by_name_stmt.execute(params![
                item.favorite_added,
                source_id,
                item.name,
                item.media_type,
                item.series_id,
                item.season_id,
                item.episode_num,
            ])?;
        }
        if rows > 0 {
            restored += rows;
        }
    }
    Ok(restored)
}

pub fn analyze(tx: &Transaction) -> Result<()> {
    tx.execute("ANALYZE;", params![])?;
    Ok(())
}

const WATCH_HISTORY_BACKFILL_KEY: &str = "watch_history_backfill_v1";

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceIdentity {
    source_fingerprint: String,
    source_host: Option<String>,
    source_username: Option<String>,
    source_name: String,
}

struct WatchHistorySourceChannelRow {
    channel_id: i64,
    channel_name: String,
    url: Option<String>,
    media_type: u8,
    source_id: i64,
    series_id: Option<i64>,
    season_id: Option<i64>,
    stream_id: Option<i64>,
    episode_num: Option<i64>,
    last_watched: Option<i64>,
    season_number: Option<i64>,
    show_title: Option<String>,
    source_name: String,
    source_type: u8,
    source_url: Option<String>,
    source_username: Option<String>,
}

fn is_sensitive_query_param(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "password"
            | "pass"
            | "pwd"
            | "token"
            | "auth"
            | "key"
            | "secret"
            | "sig"
            | "signature"
            | "expires"
            | "exp"
    )
}

fn parse_url_with_default_scheme(raw: &str) -> Option<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Url::parse(trimmed)
        .ok()
        .or_else(|| Url::parse(&format!("http://{trimmed}")).ok())
}

fn format_normalized_origin(parsed: &Url) -> Option<(String, String)> {
    let host = parsed.host_str()?.to_ascii_lowercase();
    let scheme = parsed.scheme().to_ascii_lowercase();
    let port_suffix = match parsed.port() {
        Some(port) => format!(":{port}"),
        None => String::new(),
    };
    let origin = format!("{scheme}://{host}{port_suffix}");
    let host_key = format!("{host}{port_suffix}");
    Some((origin, host_key))
}

fn normalize_text_key(input: &str) -> String {
    input
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn extract_release_year(name: &str) -> Option<i64> {
    let bytes = name.as_bytes();
    let mut last_year: Option<i64> = None;
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let prev_ok = i == 0 || !bytes[i - 1].is_ascii_digit();
        let next_ok = i + 4 == bytes.len() || !bytes[i + 4].is_ascii_digit();
        if prev_ok && next_ok && bytes[i..i + 4].iter().all(|b| b.is_ascii_digit()) {
            if let Ok(s) = std::str::from_utf8(&bytes[i..i + 4]) {
                if let Ok(year) = s.parse::<i64>() {
                    if (1920..=2035).contains(&year) {
                        last_year = Some(year);
                    }
                }
            }
            i += 4;
        } else {
            i += 1;
        }
    }
    last_year
}

fn fnv1a_64(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in input.as_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn compute_source_identity(source: &Source) -> SourceIdentity {
    let source_name = source.name.trim().to_string();
    let raw_url = source.url.as_deref().unwrap_or("").trim();

    match source.source_type {
        source_type::XTREAM => {
            let parsed = parse_url_with_default_scheme(raw_url);
            let (origin, host_key) = parsed
                .as_ref()
                .and_then(format_normalized_origin)
                .unwrap_or_else(|| {
                    let fallback = raw_url.to_ascii_lowercase();
                    (fallback.clone(), fallback)
                });
            let username = source
                .username
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_ascii_lowercase())
                .or_else(|| {
                    parsed.as_ref().and_then(|u| {
                        u.query_pairs()
                            .find(|(k, _)| {
                                k.eq_ignore_ascii_case("username") || k.eq_ignore_ascii_case("user")
                            })
                            .map(|(_, v)| v.trim().to_ascii_lowercase())
                            .filter(|s| !s.is_empty())
                    })
                });
            let user_part = username.as_deref().unwrap_or("");
            SourceIdentity {
                source_fingerprint: format!("xtream:{origin}|{user_part}"),
                source_host: (!host_key.is_empty()).then_some(host_key),
                source_username: username,
                source_name,
            }
        }
        source_type::M3U_LINK => {
            if let Some(mut parsed) = parse_url_with_default_scheme(raw_url) {
                let host_key = format_normalized_origin(&parsed).map(|(_, h)| h);
                let username = parsed
                    .query_pairs()
                    .find(|(k, _)| {
                        k.eq_ignore_ascii_case("username") || k.eq_ignore_ascii_case("user")
                    })
                    .map(|(_, v)| v.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty());
                let kept_pairs: Vec<(String, String)> = parsed
                    .query_pairs()
                    .filter(|(k, _)| !is_sensitive_query_param(k.as_ref()))
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect();
                parsed.set_query(None);
                if !kept_pairs.is_empty() {
                    let mut pairs = parsed.query_pairs_mut();
                    for (k, v) in kept_pairs {
                        pairs.append_pair(&k, &v);
                    }
                }
                let origin = format_normalized_origin(&parsed)
                    .map(|(o, _)| o)
                    .unwrap_or_default();
                let query_suffix = parsed
                    .query()
                    .map(|q| format!("?{q}"))
                    .unwrap_or_default();
                let normalized_url = format!("{origin}{}{query_suffix}", parsed.path());
                SourceIdentity {
                    source_fingerprint: format!("m3u_link:{normalized_url}"),
                    source_host: host_key,
                    source_username: username,
                    source_name,
                }
            } else {
                SourceIdentity {
                    source_fingerprint: format!("m3u_link:{}", raw_url.to_ascii_lowercase()),
                    source_host: None,
                    source_username: None,
                    source_name,
                }
            }
        }
        source_type::M3U => {
            let file_key = raw_url
                .rsplit(['/', '\\'])
                .find(|s| !s.is_empty())
                .unwrap_or(raw_url)
                .to_ascii_lowercase();
            SourceIdentity {
                source_fingerprint: format!("m3u_file:{file_key}"),
                source_host: None,
                source_username: None,
                source_name,
            }
        }
        _ => SourceIdentity {
            source_fingerprint: format!("custom:{}", normalize_text_key(&source_name)),
            source_host: None,
            source_username: None,
            source_name,
        },
    }
}

fn normalize_stream_url_path(raw_url: Option<&str>) -> Option<String> {
    let trimmed = raw_url?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(parsed) = parse_url_with_default_scheme(trimmed) {
        let kept_pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .filter(|(k, _)| !is_sensitive_query_param(k.as_ref()))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let path = parsed.path().trim();
        if kept_pairs.is_empty() {
            Some(path.to_string())
        } else {
            let mut tmp = Url::parse("http://localhost").ok()?;
            {
                let mut pairs = tmp.query_pairs_mut();
                for (k, v) in kept_pairs {
                    pairs.append_pair(&k, &v);
                }
            }
            let query = tmp.query().unwrap_or("");
            Some(format!("{path}?{query}"))
        }
    } else {
        Some(trimmed.to_string())
    }
}

fn build_watch_history_identity_key(
    source_fingerprint: &str,
    is_episode: bool,
    stream_id: Option<i64>,
    series_id: Option<i64>,
    season_number: Option<i64>,
    episode_num: Option<i64>,
    stream_url_path: Option<&str>,
    fallback_name: &str,
) -> String {
    if !is_episode {
        if let Some(sid) = stream_id {
            return format!("wh:v1:{source_fingerprint}:m:sid:{sid}");
        }
    } else {
        if let Some(ser_id) = series_id {
            if season_number.is_some() || episode_num.is_some() {
                let sn = season_number.unwrap_or(-1);
                let ep = episode_num.unwrap_or(-1);
                return format!("wh:v1:{source_fingerprint}:ep:s{ser_id}:sn{sn}:e{ep}");
            }
        }
        if let Some(sid) = stream_id {
            return format!("wh:v1:{source_fingerprint}:ep:sid:{sid}");
        }
    }
    let path_input = stream_url_path
        .filter(|p| !p.is_empty())
        .unwrap_or(fallback_name);
    let kind = if is_episode { "ep" } else { "m" };
    format!(
        "wh:v1:{source_fingerprint}:{kind}:url:{:016x}",
        fnv1a_64(path_input)
    )
}

fn map_watch_history_source_channel_row(
    row: &Row,
) -> std::result::Result<WatchHistorySourceChannelRow, rusqlite::Error> {
    Ok(WatchHistorySourceChannelRow {
        channel_id: row.get("channel_id")?,
        channel_name: row.get::<_, Option<String>>("channel_name")?.unwrap_or_default(),
        url: row.get("channel_url")?,
        media_type: row.get("media_type")?,
        source_id: row.get("source_id")?,
        series_id: row.get("series_id")?,
        season_id: row.get("season_id")?,
        stream_id: row.get("stream_id")?,
        episode_num: row.get("episode_num")?,
        last_watched: row.get("last_watched")?,
        season_number: row.get("season_number")?,
        show_title: row.get("show_title")?,
        source_name: row.get::<_, Option<String>>("source_name")?.unwrap_or_default(),
        source_type: row.get("source_type")?,
        source_url: row.get("source_url")?,
        source_username: row.get("source_username")?,
    })
}

fn write_watch_history_row(
    stmt: &mut rusqlite::Statement,
    row: &WatchHistorySourceChannelRow,
    fallback_timestamp: i64,
) -> Result<()> {
    if row.media_type == media_type::LIVESTREAM {
        return Ok(());
    }
    let src = Source {
        id: Some(row.source_id),
        name: row.source_name.clone(),
        url: row.source_url.clone(),
        url_origin: None,
        username: row.source_username.clone(),
        password: None,
        source_type: row.source_type,
        use_tvg_id: None,
        enabled: true,
        user_agent: None,
        max_streams: None,
        stream_user_agent: None,
        last_updated: None,
    };
    let identity = compute_source_identity(&src);
    let is_episode =
        row.series_id.is_some() || row.season_id.is_some() || row.episode_num.is_some();
    let is_episode_flag: i64 = if is_episode { 1 } else { 0 };
    let normalized_title = normalize_text_key(&row.channel_name);
    let normalized_show_title = row.show_title.as_deref().map(normalize_text_key);
    let release_year = row
        .show_title
        .as_deref()
        .and_then(extract_release_year)
        .or_else(|| extract_release_year(&row.channel_name));
    let stream_url_path = normalize_stream_url_path(row.url.as_deref());
    let identity_key = build_watch_history_identity_key(
        &identity.source_fingerprint,
        is_episode,
        row.stream_id,
        row.series_id,
        row.season_number,
        row.episode_num,
        stream_url_path.as_deref(),
        &normalized_title,
    );
    let last_watched = row.last_watched.unwrap_or(fallback_timestamp);
    let updated_at = fallback_timestamp;

    let args: Vec<&dyn rusqlite::ToSql> = vec![
        &identity_key,
        &row.channel_id,
        &row.source_id,
        &row.source_type,
        &identity.source_fingerprint,
        &identity.source_host,
        &identity.source_username,
        &identity.source_name,
        &row.media_type,
        &is_episode_flag,
        &row.stream_id,
        &row.series_id,
        &row.season_number,
        &row.episode_num,
        &stream_url_path,
        &row.url,
        &row.channel_name,
        &normalized_title,
        &row.show_title,
        &normalized_show_title,
        &release_year,
        &last_watched,
        &updated_at,
    ];
    stmt.execute(params_from_iter(args))?;
    Ok(())
}

const WATCH_HISTORY_SELECT_BASE: &str = r#"
SELECT
  c.id AS channel_id,
  c.name AS channel_name,
  c.url AS channel_url,
  c.media_type AS media_type,
  c.source_id AS source_id,
  c.series_id AS series_id,
  c.season_id AS season_id,
  c.stream_id AS stream_id,
  c.episode_num AS episode_num,
  c.last_watched AS last_watched,
  sn.season_number AS season_number,
  CASE
    WHEN c.series_id IS NOT NULL THEN (
      SELECT p.name
      FROM channels p
      WHERE p.source_id = c.source_id
        AND p.media_type = 2
        AND p.series_id IS NULL
        AND (p.stream_id = c.series_id OR p.url = CAST(c.series_id AS TEXT))
      LIMIT 1
    )
    ELSE NULL
  END AS show_title,
  s.name AS source_name,
  s.source_type AS source_type,
  s.url AS source_url,
  s.username AS source_username
FROM channels c
INNER JOIN sources s ON s.id = c.source_id
LEFT JOIN seasons sn ON sn.id = c.season_id
"#;

fn backfill_watch_history_on_conn(conn: &mut rusqlite::Connection) -> Result<()> {
    let already_done: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![WATCH_HISTORY_BACKFILL_KEY],
            |row| row.get(0),
        )
        .optional()?;
    if already_done.is_some() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    backfill_watch_history_tx(&tx)?;
    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')",
        params![WATCH_HISTORY_BACKFILL_KEY],
    )?;
    tx.commit()?;
    Ok(())
}

fn backfill_watch_history_tx(tx: &Transaction) -> Result<()> {
    let select_sql = format!(
        "{WATCH_HISTORY_SELECT_BASE}\nWHERE c.last_watched IS NOT NULL AND c.media_type != 0"
    );
    let rows: Vec<WatchHistorySourceChannelRow> = {
        let mut stmt = tx.prepare(&select_sql)?;
        let mapped = stmt.query_map([], map_watch_history_source_channel_row)?;
        mapped.filter_map(Result::ok).collect()
    };

    if rows.is_empty() {
        return Ok(());
    }

    let now = chrono::Utc::now().timestamp();
    let mut insert_stmt = tx.prepare(
        r#"
INSERT OR IGNORE INTO watch_history (
  identity_key, channel_id, source_id, source_missing,
  source_type, source_fingerprint, source_host, source_username, source_name,
  media_type, is_episode, provider_stream_id, provider_series_id,
  season_number, episode_number, stream_url_path, stream_url,
  channel_name, normalized_title, show_title, normalized_show_title,
  release_year, last_watched, updated_at
)
VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
"#,
    )?;
    for row in &rows {
        write_watch_history_row(&mut insert_stmt, row, now)?;
    }
    Ok(())
}

fn dual_write_watch_history(conn: &rusqlite::Connection, channel_id: i64) -> Result<()> {
    let select_sql = format!("{WATCH_HISTORY_SELECT_BASE}\nWHERE c.id = ?1");
    let row = conn
        .query_row(
            &select_sql,
            params![channel_id],
            map_watch_history_source_channel_row,
        )
        .optional()?;
    let Some(row) = row else {
        return Ok(());
    };
    if row.media_type == media_type::LIVESTREAM {
        return Ok(());
    }

    let now = chrono::Utc::now().timestamp();
    let mut upsert_stmt = conn.prepare_cached(
        r#"
INSERT INTO watch_history (
  identity_key, channel_id, source_id, source_missing,
  source_type, source_fingerprint, source_host, source_username, source_name,
  media_type, is_episode, provider_stream_id, provider_series_id,
  season_number, episode_number, stream_url_path, stream_url,
  channel_name, normalized_title, show_title, normalized_show_title,
  release_year, last_watched, updated_at
)
VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
ON CONFLICT(identity_key) DO UPDATE SET
  channel_id = excluded.channel_id,
  source_id = excluded.source_id,
  source_missing = 0,
  source_type = excluded.source_type,
  source_fingerprint = excluded.source_fingerprint,
  source_host = excluded.source_host,
  source_username = excluded.source_username,
  source_name = excluded.source_name,
  media_type = excluded.media_type,
  is_episode = excluded.is_episode,
  provider_stream_id = COALESCE(excluded.provider_stream_id, watch_history.provider_stream_id),
  provider_series_id = COALESCE(excluded.provider_series_id, watch_history.provider_series_id),
  season_number = COALESCE(excluded.season_number, watch_history.season_number),
  episode_number = COALESCE(excluded.episode_number, watch_history.episode_number),
  stream_url_path = COALESCE(excluded.stream_url_path, watch_history.stream_url_path),
  stream_url = COALESCE(excluded.stream_url, watch_history.stream_url),
  channel_name = excluded.channel_name,
  normalized_title = excluded.normalized_title,
  show_title = COALESCE(excluded.show_title, watch_history.show_title),
  normalized_show_title = COALESCE(excluded.normalized_show_title, watch_history.normalized_show_title),
  release_year = COALESCE(excluded.release_year, watch_history.release_year),
  last_watched = excluded.last_watched,
  updated_at = excluded.updated_at
"#,
    )?;
    write_watch_history_row(&mut upsert_stmt, &row, now)
}

pub fn add_last_watched(id: i64) -> Result<()> {
    let sql = get_conn()?;
    add_last_watched_on_conn(&sql, id)
}

fn add_last_watched_on_conn(sql: &rusqlite::Connection, id: i64) -> Result<()> {
    sql.execute(
        r#"
          UPDATE channels
          SET last_watched = strftime('%s', 'now')
          WHERE id = ?
        "#,
        params![id],
    )?;
    sql.execute(
        r#"
		  UPDATE channels
          SET last_watched = NULL
          WHERE last_watched IS NOT NULL
		  AND id NOT IN (
				SELECT id
				FROM channels
				WHERE last_watched IS NOT NULL
				ORDER BY last_watched DESC
				LIMIT 36
		  )
        "#,
        params![],
    )?;
    if let Err(e) = dual_write_watch_history(sql, id) {
        log(format!(
            "Failed to dual-write watch_history for channel {id}: {:?}",
            e
        ));
    }
    Ok(())
}

struct DetachedWatchHistoryRow {
    id: i64,
    source_fingerprint: String,
    source_host: Option<String>,
    source_username: Option<String>,
    media_type: u8,
    is_episode: bool,
    provider_stream_id: Option<i64>,
    provider_series_id: Option<i64>,
    season_number: Option<i64>,
    episode_number: Option<i64>,
    stream_url_path: Option<String>,
    stream_url: Option<String>,
    channel_name: String,
    normalized_title: String,
    show_title: Option<String>,
    normalized_show_title: Option<String>,
    release_year: Option<i64>,
    last_watched: i64,
}

#[derive(Clone)]
struct RelinkCandidate {
    id: i64,
    name: String,
    url: Option<String>,
    stream_id: Option<i64>,
}

fn pick_unique_relink_candidate(
    candidates: Vec<RelinkCandidate>,
    exact_name: &str,
) -> Option<i64> {
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return Some(candidates[0].id);
    }
    let exact: Vec<&RelinkCandidate> = candidates
        .iter()
        .filter(|c| c.name == exact_name)
        .collect();
    if exact.len() == 1 {
        Some(exact[0].id)
    } else {
        None
    }
}

fn filter_candidates_by_year(
    candidates: Vec<RelinkCandidate>,
    expected_year: Option<i64>,
) -> Vec<RelinkCandidate> {
    if candidates.is_empty() {
        return candidates;
    }
    if candidates.len() > 1
        && (expected_year.is_none()
            || candidates
                .iter()
                .any(|c| extract_release_year(&c.name).is_none()))
    {
        return Vec::new();
    }
    candidates
        .into_iter()
        .filter(|c| match (expected_year, extract_release_year(&c.name)) {
            (Some(y1), Some(y2)) => y1 == y2,
            _ => true,
        })
        .collect()
}

fn query_relink_candidates(
    conn: &rusqlite::Connection,
    sql: &str,
    params: Vec<&dyn rusqlite::ToSql>,
) -> Result<Vec<RelinkCandidate>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params_from_iter(params), |row| {
        Ok(RelinkCandidate {
            id: row.get("id")?,
            name: row.get::<_, Option<String>>("name")?.unwrap_or_default(),
            url: row.get("url")?,
            stream_id: row.get("stream_id")?,
        })
    })?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn find_relink_channel_id(
    conn: &rusqlite::Connection,
    source_id: i64,
    wh: &DetachedWatchHistoryRow,
    same_fingerprint: bool,
) -> Result<Option<i64>> {
    // Tier 1: provider stream_id (movies) or (series_id, season_number, episode_number) (episodes)
    if !wh.is_episode {
        if let Some(sid) = wh.provider_stream_id {
            let mut cands = query_relink_candidates(
                conn,
                "SELECT id, name, url, stream_id FROM channels WHERE source_id = ?1 AND media_type = ?2 AND series_id IS NULL AND stream_id = ?3",
                vec![&source_id, &wh.media_type, &sid],
            )?;
            if !same_fingerprint {
                cands.retain(|c| normalize_text_key(&c.name) == wh.normalized_title);
            }
            if let Some(matched) = pick_unique_relink_candidate(cands, &wh.channel_name) {
                return Ok(Some(matched));
            }
        }
    } else {
        if let Some(ser_id) = wh.provider_series_id {
            if wh.season_number.is_some() || wh.episode_number.is_some() {
                let mut cands = query_relink_candidates(
                    conn,
                    "SELECT c.id, c.name, c.url, c.stream_id FROM channels c LEFT JOIN seasons sn ON sn.id = c.season_id WHERE c.source_id = ?1 AND c.series_id = ?2 AND sn.season_number IS ?3 AND c.episode_num IS ?4",
                    vec![&source_id, &ser_id, &wh.season_number, &wh.episode_number],
                )?;
                if !same_fingerprint {
                    cands.retain(|c| normalize_text_key(&c.name) == wh.normalized_title);
                }
                if let Some(matched) = pick_unique_relink_candidate(cands, &wh.channel_name) {
                    return Ok(Some(matched));
                }
            }
        }
        if let Some(sid) = wh.provider_stream_id {
            let mut cands = query_relink_candidates(
                conn,
                "SELECT id, name, url, stream_id FROM channels WHERE source_id = ?1 AND stream_id = ?2 AND (series_id IS NOT NULL OR season_id IS NOT NULL OR episode_num IS NOT NULL)",
                vec![&source_id, &sid],
            )?;
            if !same_fingerprint {
                cands.retain(|c| normalize_text_key(&c.name) == wh.normalized_title);
            }
            if let Some(matched) = pick_unique_relink_candidate(cands, &wh.channel_name) {
                return Ok(Some(matched));
            }
        }
    }

    // Tier 2: exact stream_url or normalized stream_url_path within source
    if let Some(ref raw_url) = wh.stream_url {
        let cands = query_relink_candidates(
            conn,
            "SELECT id, name, url, stream_id FROM channels WHERE source_id = ?1 AND media_type = ?2 AND url = ?3",
            vec![&source_id, &wh.media_type, raw_url],
        )?;
        if let Some(matched) = pick_unique_relink_candidate(cands, &wh.channel_name) {
            return Ok(Some(matched));
        }
    }
    if let Some(ref norm_path) = wh.stream_url_path {
        let base_path = norm_path.split('?').next().unwrap_or(norm_path);
        if !base_path.is_empty() && base_path != "/" {
            let mut cands = query_relink_candidates(
                conn,
                "SELECT id, name, url, stream_id FROM channels WHERE source_id = ?1 AND media_type = ?2 AND instr(url, ?3) > 0",
                vec![&source_id, &wh.media_type, &base_path],
            )?;
            cands.retain(|c| {
                normalize_stream_url_path(c.url.as_deref()).as_deref() == Some(norm_path.as_str())
            });
            if let Some(matched) = pick_unique_relink_candidate(cands, &wh.channel_name) {
                return Ok(Some(matched));
            }
        }
    }

    // Tier 4: normalized_title + release_year (or show_title + season + episode for TV)
    if !wh.is_episode {
        let cands = query_relink_candidates(
            conn,
            "SELECT id, name, url, stream_id FROM channels WHERE source_id = ?1 AND media_type = ?2 AND series_id IS NULL AND LOWER(TRIM(name)) = ?3",
            vec![&source_id, &wh.media_type, &wh.normalized_title],
        )?;
        let year_filtered = filter_candidates_by_year(cands, wh.release_year);
        if let Some(matched) = pick_unique_relink_candidate(year_filtered, &wh.channel_name) {
            return Ok(Some(matched));
        }
    } else if let Some(ref norm_show) = wh.normalized_show_title {
        if wh.season_number.is_some() || wh.episode_number.is_some() {
            let series_cands = query_relink_candidates(
                conn,
                "SELECT id, name, url, stream_id FROM channels WHERE source_id = ?1 AND media_type = 2 AND series_id IS NULL AND LOWER(TRIM(name)) = ?2",
                vec![&source_id, norm_show],
            )?;
            let year_filtered_series = filter_candidates_by_year(series_cands, wh.release_year);
            let show_exact_name = wh.show_title.as_deref().unwrap_or("");
            let matched_series_id = if year_filtered_series.len() == 1 {
                Some(&year_filtered_series[0])
            } else if year_filtered_series.len() > 1 && !show_exact_name.is_empty() {
                let exact: Vec<&RelinkCandidate> = year_filtered_series
                    .iter()
                    .filter(|s| s.name == show_exact_name)
                    .collect();
                (exact.len() == 1).then_some(exact[0])
            } else {
                None
            };
            if let Some(parent) = matched_series_id {
                let series_id_val = parent.stream_id.or_else(|| {
                    parent
                        .url
                        .as_deref()
                        .and_then(|u| u.trim().parse::<i64>().ok())
                });
                if let Some(ser_id) = series_id_val {
                    let ep_cands = query_relink_candidates(
                        conn,
                        "SELECT c.id, c.name, c.url, c.stream_id FROM channels c LEFT JOIN seasons sn ON sn.id = c.season_id WHERE c.source_id = ?1 AND c.series_id = ?2 AND sn.season_number IS ?3 AND c.episode_num IS ?4",
                        vec![&source_id, &ser_id, &wh.season_number, &wh.episode_number],
                    )?;
                    if let Some(matched) = pick_unique_relink_candidate(ep_cands, &wh.channel_name) {
                        return Ok(Some(matched));
                    }
                }
            }
        }
    }

    Ok(None)
}

pub fn relink_watch_history_for_source(source_id: i64) -> Result<usize> {
    let mut sql = get_conn()?;
    relink_watch_history_on_conn(&mut sql, source_id)
}

fn relink_watch_history_on_conn(
    conn: &mut rusqlite::Connection,
    source_id: i64,
) -> Result<usize> {
    // Detach any watch_history entries for this source whose channel_id was wiped (e.g. M3U wipe refresh)
    conn.execute(
        r#"
        UPDATE watch_history
        SET channel_id = NULL,
            source_missing = 1
        WHERE source_id = ?1
          AND (
            channel_id IS NULL
            OR NOT EXISTS (SELECT 1 FROM channels c WHERE c.id = watch_history.channel_id)
          )
        "#,
        params![source_id],
    )?;

    let source: Option<Source> = conn
        .query_row(
            "SELECT * FROM sources WHERE id = ?1",
            params![source_id],
            row_to_source,
        )
        .optional()?;
    let Some(source) = source else {
        return Ok(0);
    };
    let new_identity = compute_source_identity(&source);

    let detached_rows: Vec<DetachedWatchHistoryRow> = {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, source_fingerprint, source_host, source_username,
                   media_type, is_episode, provider_stream_id, provider_series_id,
                   season_number, episode_number, stream_url_path, stream_url,
                   channel_name, normalized_title, show_title, normalized_show_title,
                   release_year, last_watched
            FROM watch_history
            WHERE (source_missing = 1 OR channel_id IS NULL)
              AND media_type != 0
            ORDER BY last_watched DESC
            "#,
        )?;
        let mapped = stmt.query_map([], |row| {
            Ok(DetachedWatchHistoryRow {
                id: row.get("id")?,
                source_fingerprint: row.get("source_fingerprint")?,
                source_host: row.get("source_host")?,
                source_username: row.get("source_username")?,
                media_type: row.get("media_type")?,
                is_episode: row.get::<_, i64>("is_episode")? != 0,
                provider_stream_id: row.get("provider_stream_id")?,
                provider_series_id: row.get("provider_series_id")?,
                season_number: row.get("season_number")?,
                episode_number: row.get("episode_number")?,
                stream_url_path: row.get("stream_url_path")?,
                stream_url: row.get("stream_url")?,
                channel_name: row.get("channel_name")?,
                normalized_title: row.get("normalized_title")?,
                show_title: row.get("show_title")?,
                normalized_show_title: row.get("normalized_show_title")?,
                release_year: row.get("release_year")?,
                last_watched: row.get("last_watched")?,
            })
        })?;
        mapped.filter_map(Result::ok).collect()
    };

    if detached_rows.is_empty() {
        return Ok(0);
    }

    let mut matches: Vec<(i64, i64, i64)> = Vec::new();
    for wh in &detached_rows {
        let same_fingerprint = wh.source_fingerprint == new_identity.source_fingerprint;
        let same_host = new_identity.source_host.is_some()
            && wh.source_host == new_identity.source_host;
        let same_user = new_identity.source_username.is_some()
            && wh.source_username == new_identity.source_username;
        if !same_fingerprint && !same_host && !same_user {
            continue;
        }
        if let Some(ch_id) = find_relink_channel_id(conn, source_id, wh, same_fingerprint)? {
            matches.push((wh.id, ch_id, wh.last_watched));
        }
    }

    if matches.is_empty() {
        return Ok(0);
    }

    let now = chrono::Utc::now().timestamp();
    let tx = conn.transaction()?;
    {
        let mut update_wh = tx.prepare(
            r#"
            UPDATE watch_history
            SET channel_id = ?1,
                source_id = ?2,
                source_missing = 0,
                source_fingerprint = ?3,
                source_host = ?4,
                source_username = ?5,
                source_name = ?6,
                updated_at = ?7
            WHERE id = ?8
            "#,
        )?;
        let mut restamp_ch = tx.prepare(
            r#"
            UPDATE channels
            SET last_watched = CASE
              WHEN last_watched IS NULL OR last_watched < ?1 THEN ?1
              ELSE last_watched
            END
            WHERE id = ?2
            "#,
        )?;
        for &(wh_id, ch_id, wh_last_watched) in &matches {
            update_wh.execute(params![
                ch_id,
                source_id,
                new_identity.source_fingerprint,
                new_identity.source_host,
                new_identity.source_username,
                new_identity.source_name,
                now,
                wh_id,
            ])?;
            restamp_ch.execute(params![wh_last_watched, ch_id])?;
        }
    }

    tx.execute(
        r#"
        UPDATE channels
        SET last_watched = NULL
        WHERE last_watched IS NOT NULL
          AND id NOT IN (
            SELECT id
            FROM channels
            WHERE last_watched IS NOT NULL
            ORDER BY last_watched DESC
            LIMIT 36
          )
        "#,
        params![],
    )?;

    tx.commit()?;
    Ok(matches.len())
}

pub fn clear_history() -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
          UPDATE channels
          SET last_watched = NULL
          WHERE last_watched IS NOT NULL
        "#,
        params![],
    )?;
    Ok(())
}

pub fn find_all_episodes_after(channel: &Channel) -> Result<Vec<String>> {
    let sql = get_conn()?;
    Ok(sql
        .prepare(
            r#"
        SELECT url FROM channels
        WHERE season_id = ?
        AND episode_num > ?
        ORDER BY episode_num
      "#,
        )?
        .query_map(params![channel.season_id, channel.episode_num], |row| {
            row.get::<_, String>(0)
        })?
        .filter_map(Result::ok)
        .collect())
}

pub fn update_source_last_updated(source_id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        "UPDATE sources SET last_updated = ? WHERE id = ?",
        params![chrono::Utc::now().timestamp(), source_id],
    )?;
    Ok(())
}

#[derive(Clone, Debug, Default)]
pub struct SourceRefreshDbState {
    pub source_id: i64,
    pub last_successful_refresh: Option<i64>,
    pub last_refresh_attempt: Option<i64>,
    pub last_error: Option<String>,
}

pub fn get_source_refresh_state(source_id: i64) -> Result<Option<SourceRefreshDbState>> {
    let sql = get_conn()?;
    let mut stmt = sql.prepare(
        "SELECT source_id, last_successful_refresh, last_refresh_attempt, last_error FROM source_refresh_state WHERE source_id = ?",
    )?;
    let mut rows = stmt.query(params![source_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(SourceRefreshDbState {
            source_id: row.get(0)?,
            last_successful_refresh: row.get(1)?,
            last_refresh_attempt: row.get(2)?,
            last_error: row.get(3)?,
        }))
    } else {
        Ok(None)
    }
}

pub fn get_all_source_refresh_states() -> Result<HashMap<i64, SourceRefreshDbState>> {
    let sql = get_conn()?;
    let mut stmt = sql.prepare(
        "SELECT source_id, last_successful_refresh, last_refresh_attempt, last_error FROM source_refresh_state",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SourceRefreshDbState {
            source_id: row.get(0)?,
            last_successful_refresh: row.get(1)?,
            last_refresh_attempt: row.get(2)?,
            last_error: row.get(3)?,
        })
    })?;
    let mut map = HashMap::new();
    for item in rows {
        if let Ok(state) = item {
            map.insert(state.source_id, state);
        }
    }
    Ok(map)
}

pub fn record_source_refresh_success(source_id: i64, timestamp: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        INSERT INTO source_refresh_state (source_id, last_successful_refresh, last_refresh_attempt, last_error)
        VALUES (?1, ?2, ?2, NULL)
        ON CONFLICT(source_id) DO UPDATE SET
            last_successful_refresh = ?2,
            last_refresh_attempt = ?2,
            last_error = NULL
        "#,
        params![source_id, timestamp],
    )?;
    Ok(())
}

pub fn record_source_refresh_error(source_id: i64, timestamp: i64, error: &str) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        INSERT INTO source_refresh_state (source_id, last_successful_refresh, last_refresh_attempt, last_error)
        VALUES (?1, NULL, ?2, ?3)
        ON CONFLICT(source_id) DO UPDATE SET
            last_refresh_attempt = ?2,
            last_error = ?3
        "#,
        params![source_id, timestamp, error],
    )?;
    Ok(())
}

fn build_live_scope_clause(source_count: usize, has_group: bool) -> String {
    let mut clause = format!(
        "media_type = 0 AND source_id IN ({}) AND url IS NOT NULL AND hidden = 0 AND series_id IS NULL AND season_id IS NULL AND episode_num IS NULL",
        generate_placeholders(source_count)
    );
    if has_group {
        clause.push_str(" AND group_id = ?");
    }
    clause
}

fn build_live_scope_params<'a>(
    source_ids: &'a [i64],
    group_id: Option<&'a i64>,
    extra_id: Option<&'a i64>,
) -> Vec<&'a dyn rusqlite::ToSql> {
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(source_ids.len() + 2);
    params.extend(to_to_sql(source_ids));
    if let Some(gid) = group_id {
        params.push(gid);
    }
    if let Some(eid) = extra_id {
        params.push(eid);
    }
    params
}

/// Returns the 1-based page number containing `channel_id` within the active live scope.
pub fn get_live_channel_page(
    source_ids: Vec<i64>,
    group_id: Option<i64>,
    channel_id: i64,
) -> Result<Option<u16>> {
    if source_ids.is_empty() {
        return Ok(None);
    }
    let sql = get_conn()?;
    let scope = build_live_scope_clause(source_ids.len(), group_id.is_some());
    let exists_sql = format!("SELECT 1 FROM channels WHERE {scope} AND id = ? LIMIT 1");
    let exists_params = build_live_scope_params(&source_ids, group_id.as_ref(), Some(&channel_id));
    let exists: Option<i64> = sql
        .query_row(&exists_sql, params_from_iter(exists_params), |row| row.get(0))
        .optional()?;
    if exists.is_none() {
        return Ok(None);
    }

    let count_sql = format!("SELECT COUNT(1) FROM channels WHERE {scope} AND id < ?");
    let count_params = build_live_scope_params(&source_ids, group_id.as_ref(), Some(&channel_id));
    let before_count: i64 =
        sql.query_row(&count_sql, params_from_iter(count_params), |row| row.get(0))?;
    let page = ((before_count.max(0) / PAGE_SIZE as i64) + 1).clamp(1, u16::MAX as i64) as u16;
    Ok(Some(page))
}

/// Returns the next (`delta >= 0`) or previous (`delta < 0`) live channel in provider order,
/// wrapping around at the boundaries of the active source/group scope.
pub fn get_adjacent_live_channel(
    source_ids: Vec<i64>,
    group_id: Option<i64>,
    current_channel_id: Option<i64>,
    delta: i8,
) -> Result<Option<Channel>> {
    if source_ids.is_empty() {
        return Ok(None);
    }
    let sql = get_conn()?;
    let scope = build_live_scope_clause(source_ids.len(), group_id.is_some());
    let is_next = delta >= 0;
    let order = if is_next { "ASC" } else { "DESC" };

    if let Some(cur_id) = current_channel_id {
        let cmp = if is_next { ">" } else { "<" };
        let step_sql = format!(
            "SELECT * FROM channels WHERE {scope} AND id {cmp} ? ORDER BY id {order} LIMIT 1"
        );
        let step_params = build_live_scope_params(&source_ids, group_id.as_ref(), Some(&cur_id));
        if let Some(ch) = sql
            .query_row(&step_sql, params_from_iter(step_params), row_to_channel)
            .optional()?
        {
            return Ok(Some(ch));
        }
    }

    let wrap_sql = format!("SELECT * FROM channels WHERE {scope} ORDER BY id {order} LIMIT 1");
    let wrap_params = build_live_scope_params(&source_ids, group_id.as_ref(), None);
    let wrapped = sql
        .query_row(&wrap_sql, params_from_iter(wrap_params), row_to_channel)
        .optional()?;
    Ok(wrapped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn make_source(
        source_type: u8,
        name: &str,
        url: Option<&str>,
        username: Option<&str>,
        password: Option<&str>,
    ) -> Source {
        Source {
            id: Some(1),
            name: name.to_string(),
            url: url.map(ToString::to_string),
            url_origin: None,
            username: username.map(ToString::to_string),
            password: password.map(ToString::to_string),
            source_type,
            use_tvg_id: Some(true),
            enabled: true,
            user_agent: None,
            max_streams: None,
            stream_user_agent: None,
            last_updated: None,
        }
    }

    fn setup_test_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        create_structure_on_conn(&conn).unwrap();
        apply_migrations_on_conn(&mut conn).unwrap();
        conn
    }

    #[test]
    fn test_xtream_fingerprint_ignores_password_and_distinguishes_username() {
        let s1 = make_source(
            source_type::XTREAM,
            "Provider A",
            Some("HTTP://Stream.Example.com:8080/player_api.php"),
            Some("Alice"),
            Some("secret1"),
        );
        let s2 = make_source(
            source_type::XTREAM,
            "Provider A Readded",
            Some("http://stream.example.com:8080"),
            Some("alice"),
            Some("rotated_password"),
        );
        let s3 = make_source(
            source_type::XTREAM,
            "Provider A Other User",
            Some("http://stream.example.com:8080"),
            Some("bob"),
            Some("secret1"),
        );

        let id1 = compute_source_identity(&s1);
        let id2 = compute_source_identity(&s2);
        let id3 = compute_source_identity(&s3);

        assert_eq!(id1.source_fingerprint, "xtream:http://stream.example.com:8080|alice");
        assert_eq!(id1.source_fingerprint, id2.source_fingerprint);
        assert_ne!(id1.source_fingerprint, id3.source_fingerprint);
        assert_eq!(id1.source_host.as_deref(), Some("stream.example.com:8080"));
        assert_eq!(id1.source_username.as_deref(), Some("alice"));
    }

    #[test]
    fn test_m3u_and_custom_fingerprints_strip_secrets() {
        let m3u_link_1 = make_source(
            source_type::M3U_LINK,
            "My M3U",
            Some("https://CDN.Test.com/get.php?username=u1&password=p1&type=m3u_plus&token=abc"),
            None,
            None,
        );
        let m3u_link_2 = make_source(
            source_type::M3U_LINK,
            "My M3U",
            Some("https://cdn.test.com/get.php?username=u1&password=p2&type=m3u_plus&token=xyz"),
            None,
            None,
        );
        assert_eq!(
            compute_source_identity(&m3u_link_1).source_fingerprint,
            compute_source_identity(&m3u_link_2).source_fingerprint
        );

        let m3u_file = make_source(
            source_type::M3U,
            "Local",
            Some(r"C:\Users\Memory\Downloads\MyPlaylist.M3U"),
            None,
            None,
        );
        assert_eq!(
            compute_source_identity(&m3u_file).source_fingerprint,
            "m3u_file:myplaylist.m3u"
        );

        let custom = make_source(source_type::CUSTOM, "  Custom   List ", None, None, None);
        assert_eq!(
            compute_source_identity(&custom).source_fingerprint,
            "custom:custom list"
        );
    }

    #[test]
    fn test_backfill_is_idempotent_and_skips_live_tv() {
        let mut conn = setup_test_db();

        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, username, password, enabled) VALUES (1, 'XtreamOne', 2, 'http://tv.example.com:8080', 'user1', 'pass1', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, enabled) VALUES (2, 'M3UOne', 1, 'https://list.example.com/list.m3u?token=t1', 1)",
            [],
        )
        .unwrap();

        // Live channel with last_watched -> must be skipped by backfill
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id, last_watched) VALUES (10, 'CNN Live', 'http://tv.example.com:8080/live/10.ts', 0, 1, 10, 1000)",
            [],
        )
        .unwrap();
        // Movie with stream_id -> priority 1 identity_key
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id, last_watched) VALUES (11, 'Inception (2010)', 'http://tv.example.com:8080/movie/u/p/501.mp4', 1, 1, 501, 2000)",
            [],
        )
        .unwrap();
        // Series parent + season + episode -> priority 2 identity_key
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (12, 'Dark (2017)', '700', 2, 1, 700)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO seasons (id, name, season_number, series_id, source_id) VALUES (100, 'Season 2', 2, 700, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, series_id, season_id, episode_num, stream_id, last_watched) VALUES (13, 'Beginnings and Endings', 'http://tv.example.com:8080/series/u/p/9001.mp4', 1, 1, 700, 100, 4, 9001, 3000)",
            [],
        )
        .unwrap();
        // M3U movie without stream_id -> priority 3 URL-path hash
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, last_watched) VALUES (14, 'Arrival 2016', 'https://cdn.example.com/vod/arrival.mkv?token=abc', 1, 2, 4000)",
            [],
        )
        .unwrap();

        {
            let tx = conn.transaction().unwrap();
            backfill_watch_history_tx(&tx).unwrap();
            backfill_watch_history_tx(&tx).unwrap();
            tx.commit().unwrap();
        }
        backfill_watch_history_on_conn(&mut conn).unwrap();
        backfill_watch_history_on_conn(&mut conn).unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM watch_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 3);

        let movie_key: String = conn
            .query_row(
                "SELECT identity_key FROM watch_history WHERE channel_id = 11",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(movie_key, "wh:v1:xtream:http://tv.example.com:8080|user1:m:sid:501");

        let (ep_key, season_num, show_title): (String, i64, String) = conn
            .query_row(
                "SELECT identity_key, season_number, show_title FROM watch_history WHERE channel_id = 13",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            ep_key,
            "wh:v1:xtream:http://tv.example.com:8080|user1:ep:s700:sn2:e4"
        );
        assert_eq!(season_num, 2);
        assert_eq!(show_title, "Dark (2017)");
    }

    #[test]
    fn test_add_last_watched_dual_write_and_upsert() {
        let conn = setup_test_db();
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, username, enabled) VALUES (1, 'XtreamOne', 2, 'http://tv.example.com:8080', 'user1', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (1, 'Live 1', 'http://tv.example.com:8080/live/1.ts', 0, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (2, 'Dune (2021)', 'http://tv.example.com:8080/movie/u/p/222.mp4', 1, 1, 222)",
            [],
        )
        .unwrap();

        add_last_watched_on_conn(&conn, 1).unwrap();
        add_last_watched_on_conn(&conn, 2).unwrap();
        add_last_watched_on_conn(&conn, 2).unwrap();

        let wh_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM watch_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(wh_count, 1);

        let live_last_watched: Option<i64> = conn
            .query_row("SELECT last_watched FROM channels WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(live_last_watched.is_some());

        let movie_year: Option<i64> = conn
            .query_row(
                "SELECT release_year FROM watch_history WHERE channel_id = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(movie_year, Some(2021));
    }

    #[test]
    fn test_delete_source_detaches_watch_history() {
        let mut conn = setup_test_db();
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, username, password, enabled) VALUES (1, 'XtreamOne', 2, 'http://tv.example.com:8080', 'user1', 'pass1', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (11, 'Inception (2010)', 'http://tv.example.com:8080/movie/u/p/501.mp4', 1, 1, 501)",
            [],
        )
        .unwrap();

        add_last_watched_on_conn(&conn, 11).unwrap();
        delete_source_on_conn(&mut conn, 1).unwrap();

        let source_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sources WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source_count, 0);

        let (ch_id, src_id, missing, fp, host, user): (
            Option<i64>,
            Option<i64>,
            i64,
            String,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT channel_id, source_id, source_missing, source_fingerprint, source_host, source_username FROM watch_history",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();
        assert_eq!(ch_id, None);
        assert_eq!(src_id, None);
        assert_eq!(missing, 1);
        assert_eq!(fp, "xtream:http://tv.example.com:8080|user1");
        assert_eq!(host.as_deref(), Some("tv.example.com:8080"));
        assert_eq!(user.as_deref(), Some("user1"));
    }

    #[test]
    fn test_relink_same_source_with_rotated_password_and_idempotency() {
        let mut conn = setup_test_db();
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, username, password, enabled) VALUES (1, 'XtreamOne', 2, 'http://tv.example.com:8080', 'user1', 'old_pass', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (11, 'Inception (2010)', 'http://tv.example.com:8080/movie/u/old_pass/501.mp4', 1, 1, 501)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (12, 'Dark (2017)', '700', 2, 1, 700)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO seasons (id, name, season_number, series_id, source_id) VALUES (100, 'Season 1', 1, 700, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, series_id, season_id, episode_num, stream_id) VALUES (13, 'Secrets', 'http://tv.example.com:8080/series/u/old_pass/901.mp4', 1, 1, 700, 100, 1, 901)",
            [],
        )
        .unwrap();

        add_last_watched_on_conn(&conn, 11).unwrap();
        add_last_watched_on_conn(&conn, 13).unwrap();
        let orig_movie_lw: i64 = conn
            .query_row("SELECT last_watched FROM watch_history WHERE channel_id = 11", [], |r| r.get(0))
            .unwrap();

        delete_source_on_conn(&mut conn, 1).unwrap();

        // Re-add same Xtream source under new source id=2 with rotated password and different channel ids
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, username, password, enabled) VALUES (2, 'XtreamOne', 2, 'http://tv.example.com:8080', 'user1', 'new_pass', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (211, 'Inception (2010)', 'http://tv.example.com:8080/movie/u/new_pass/501.mp4', 1, 2, 501)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (212, 'Dark (2017)', '700', 2, 2, 700)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO seasons (id, name, season_number, series_id, source_id) VALUES (200, 'Season 1', 1, 700, 2)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, series_id, season_id, episode_num, stream_id) VALUES (213, 'Secrets', 'http://tv.example.com:8080/series/u/new_pass/901.mp4', 1, 2, 700, 200, 1, 901)",
            [],
        )
        .unwrap();

        let relinked = relink_watch_history_on_conn(&mut conn, 2).unwrap();
        assert_eq!(relinked, 2);
        // Running relink twice is idempotent
        assert_eq!(relink_watch_history_on_conn(&mut conn, 2).unwrap(), 0);

        let (m_ch, m_src, m_missing): (Option<i64>, Option<i64>, i64) = conn
            .query_row(
                "SELECT channel_id, source_id, source_missing FROM watch_history WHERE provider_stream_id = 501",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(m_ch, Some(211));
        assert_eq!(m_src, Some(2));
        assert_eq!(m_missing, 0);

        let restamped_lw: Option<i64> = conn
            .query_row("SELECT last_watched FROM channels WHERE id = 211", [], |r| r.get(0))
            .unwrap();
        assert_eq!(restamped_lw, Some(orig_movie_lw));

        let ep_ch: Option<i64> = conn
            .query_row(
                "SELECT channel_id FROM watch_history WHERE provider_series_id = 700",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ep_ch, Some(213));
    }

    #[test]
    fn test_relink_skips_ambiguous_duplicates_and_different_providers() {
        let mut conn = setup_test_db();
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, username, enabled) VALUES (1, 'ProvA', 2, 'http://a.example.com:8080', 'alice', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (10, 'Dune', 'http://a.example.com:8080/movie/alice/p/10.mp4', 1, 1, 10)",
            [],
        )
        .unwrap();
        add_last_watched_on_conn(&conn, 10).unwrap();
        delete_source_on_conn(&mut conn, 1).unwrap();

        // Different provider (different host AND username) with identical stream_id and title must NOT link
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, username, enabled) VALUES (2, 'ProvB', 2, 'http://b.example.com:8080', 'bob', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id, stream_id) VALUES (20, 'Dune', 'http://b.example.com:8080/movie/bob/p/10.mp4', 1, 2, 10)",
            [],
        )
        .unwrap();
        assert_eq!(relink_watch_history_on_conn(&mut conn, 2).unwrap(), 0);

        // Same provider host/user re-added without stream_id, but TWO identical 'Dune' candidates without year -> ambiguous, must stay unlinked
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, username, enabled) VALUES (3, 'ProvA_Readded', 2, 'http://a.example.com:8080', 'alice', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id) VALUES (30, 'Dune', 'http://a.example.com:8080/movie/alice/p/new1.mp4', 1, 3)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id) VALUES (31, 'Dune', 'http://a.example.com:8080/movie/alice/p/new2.mp4', 1, 3)",
            [],
        )
        .unwrap();
        assert_eq!(relink_watch_history_on_conn(&mut conn, 3).unwrap(), 0);

        let (ch_id, missing): (Option<i64>, i64) = conn
            .query_row(
                "SELECT channel_id, source_missing FROM watch_history",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(ch_id, None);
        assert_eq!(missing, 1);
    }

    #[test]
    fn test_relink_after_m3u_wipe_refresh_updates_channel_id() {
        let mut conn = setup_test_db();
        conn.execute(
            "INSERT INTO sources (id, name, source_type, url, enabled) VALUES (1, 'M3USrc', 1, 'https://list.example.com/vod.m3u?token=old', 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (id, name, url, media_type, source_id) VALUES (50, 'Arrival (2016)', 'https://cdn.example.com/vod/arrival.mkv?token=old', 1, 1)",
            [],
        )
        .unwrap();
        add_last_watched_on_conn(&conn, 50).unwrap();

        // Simulate M3U wipe refresh deleting channels and inserting with a brand-new channel id
        {
            let tx = conn.transaction().unwrap();
            wipe(&tx, 1).unwrap();
            tx.execute(
                "INSERT INTO channels (id, name, url, media_type, source_id) VALUES (950, 'Arrival (2016)', 'https://cdn.example.com/vod/arrival.mkv?token=new', 1, 1)",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
        }

        let relinked = relink_watch_history_on_conn(&mut conn, 1).unwrap();
        assert_eq!(relinked, 1);

        let (ch_id, missing): (Option<i64>, i64) = conn
            .query_row(
                "SELECT channel_id, source_missing FROM watch_history",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(ch_id, Some(950));
        assert_eq!(missing, 0);

        let lw: Option<i64> = conn
            .query_row("SELECT last_watched FROM channels WHERE id = 950", [], |r| r.get(0))
            .unwrap();
        assert!(lw.is_some());
    }
}

