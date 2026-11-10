use std::vec;
use std::{collections::HashMap, sync::LazyLock};

use crate::log::log;
use crate::sort_type;
use crate::types::{
    ChannelPreserve, CustomChannel, CustomChannelExtraData, EPGNotify, ExportedGroup, Group,
    IdName, Season,
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

fn create_structure() -> Result<()> {
    let sql = get_conn()?;
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
    let sql = get_conn()?;
    sql.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;",
    )?;
    if !structure_exists()? {
        create_structure()?;
    }
    apply_migrations()?;
    Ok(())
}

fn apply_migrations() -> Result<()> {
    let mut sql = get_conn()?;
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
    ]);
    migrations.to_latest(&mut sql)?;
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
    let offset: u16 = filters.page as u16 * PAGE_SIZE as u16 - PAGE_SIZE as u16;
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
    let offset: u16 = filters.page as u16 * PAGE_SIZE as u16 - PAGE_SIZE as u16;
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
    let offset: u16 = filters.page as u16 * PAGE_SIZE as u16 - PAGE_SIZE as u16;

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
    let offset: u16 = filters.page as u16 * PAGE_SIZE as u16 - PAGE_SIZE as u16;
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

pub fn delete_source(id: i64) -> Result<()> {
    let sql = get_conn()?;
    sql.execute(
        r#"
        DELETE FROM channels
        WHERE source_id = ?;
    "#,
        params![id],
    )?;
    sql.execute(
        r#"
        DELETE FROM groups
        WHERE source_id = ?;
    "#,
        params![id],
    )?;
    sql.execute(
        r#"
        DELETE FROM seasons
        WHERE source_id = ?;
    "#,
        params![id],
    )?;
    let _ = sql.execute(
        r#"
        DELETE FROM source_refresh_state
        WHERE source_id = ?;
    "#,
        params![id],
    );
    let count = sql.execute(
        r#"
        DELETE FROM sources
        WHERE id = ?;
    "#,
        params![id],
    )?;
    if count != 1 {
        return Err(anyhow!("No sources were deleted"));
    }
    sql.execute("ANALYZE;", params![])?;
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

pub fn analyze(tx: &Transaction) -> Result<()> {
    tx.execute("ANALYZE;", params![])?;
    Ok(())
}

pub fn add_last_watched(id: i64) -> Result<()> {
    let sql = get_conn()?;
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
    Ok(())
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

