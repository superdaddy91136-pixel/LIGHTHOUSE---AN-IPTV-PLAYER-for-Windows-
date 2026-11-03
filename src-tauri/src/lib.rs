use std::collections::HashMap;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use anyhow::Context;
use anyhow::Error;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use types::{
    AppState, Channel, CustomChannel, CustomChannelExtraData, EPG, EPGNotify, Filters, Group,
    IdName, NetworkInfo, Settings, Source, SourceContentCounts,
};

pub mod bulk_action_type;
pub mod embedded_poc;
pub mod epg;
pub mod log;
pub mod m3u;
pub mod media_type;
pub mod mpv;
pub mod restream;
pub mod settings;
pub mod share;
pub mod sort_type;
pub mod source_type;
pub mod sql;
pub mod types;
pub mod utils;
pub mod view_type;
pub mod window_state;
pub mod xtream;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let window = app.get_webview_window("main").expect("no main window");
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_m3u8,
            get_m3u8_from_link,
            play,
            get_settings,
            update_settings,
            search,
            bulk_update,
            get_xtream,
            refresh_source,
            get_episodes,
            favorite_channel,
            unfavorite_channel,
            source_name_exists,
            get_sources,
            delete_source,
            refresh_all,
            get_enabled_sources,
            toggle_source,
            delete_database,
            add_custom_channel,
            get_custom_channel_extra_data,
            edit_custom_channel,
            delete_custom_channel,
            add_custom_source,
            share_custom_channel,
            group_auto_complete,
            edit_custom_channel,
            edit_custom_group,
            add_custom_group,
            delete_custom_group,
            group_not_empty,
            group_exists,
            share_custom_group,
            share_custom_source,
            import,
            channel_exists,
            update_source,
            get_epg,
            download,
            add_epg,
            remove_epg,
            get_epg_ids,
            on_start_check_epg,
            start_restream,
            stop_restream,
            watch_self,
            get_network_info,
            share_restream,
            add_last_watched,
            backup_favs,
            restore_favs,
            abort_download,
            clear_history,
            is_container,
            cancel_play,
            hide_channel,
            hide_group,
            remove_from_history,
            get_all_expiries,
            get_source_content_counts,
            get_all_source_content_counts,
            embedded_poc::start_embedded_player,
            embedded_poc::switch_embedded_channel,
            embedded_poc::open_in_external_mpv,
            embedded_poc::send_embedded_poc_ipc,
            embedded_poc::stop_embedded_poc,
            embedded_poc::resize_embedded_poc,
            embedded_poc::get_embedded_player_info,
            embedded_poc::toggle_player_fullscreen,
            embedded_poc::set_main_window_fullscreen,
            embedded_poc::get_overlay_top_crop,
            embedded_poc::save_external_subtitle,
            embedded_poc::get_saved_external_subtitles,
            embedded_poc::remove_external_subtitle,
            embedded_poc::fetch_playback_segments
        ])
        .setup(|app| {
            app.manage(Mutex::new(AppState {
                ..Default::default()
            }));
            app.manage(embedded_poc::EmbeddedPocState::new());
            if let Some(window) = app.get_webview_window("main") {
                window_state::restore_main_window(&window);
                window_state::save_main_window_state(&window);
                let _ = window.show();
            }
            embedded_poc::init_overlay_window(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "player-overlay" {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }

                if let Some(main_window) = window.app_handle().get_webview_window("main") {
                    window_state::save_main_window_state(&main_window);
                }

                if let Some(state) = window.try_state::<embedded_poc::EmbeddedPocState>() {
                    state.stop_sync();
                }

                if let Some(overlay) = window.app_handle().get_webview_window("player-overlay") {
                    let _ = overlay.destroy();
                }

                window.app_handle().exit(0);
            }
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::Focused(_) => {
                if window.label() == "player-overlay" {
                    embedded_poc::ensure_overlay_borderless_by_window(window);
                    if let Ok(raw) = window.hwnd() {
                        let h = raw.0 as usize;
                        embedded_poc::apply_overlay_client_region(h, None);
                    }
                }
            }
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::Moved(_) => {
                if window.label() == "player-overlay" {
                    embedded_poc::ensure_overlay_borderless_by_window(window);
                    if let Ok(raw) = window.hwnd() {
                        let h = raw.0 as usize;
                        embedded_poc::apply_overlay_client_region(h, None);
                    }
                } else if window.label() == "main" {
                    if let Some(main_window) = window.app_handle().get_webview_window("main") {
                        window_state::save_main_window_state(&main_window);
                    }
                    if let Some(state) = window.try_state::<embedded_poc::EmbeddedPocState>() {
                        state.sync_overlay_position_to_main_window();
                    }
                }
            }
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::Resized(_) => {
                if window.label() == "player-overlay" {
                    embedded_poc::ensure_overlay_borderless_by_window(window);
                    if let Ok(raw) = window.hwnd() {
                        let h = raw.0 as usize;
                        embedded_poc::apply_overlay_client_region(h, None);
                    }
                } else if window.label() == "main" {
                    if let Some(main_window) = window.app_handle().get_webview_window("main") {
                        window_state::save_main_window_state(&main_window);
                    }
                    if let Some(state) = window.try_state::<embedded_poc::EmbeddedPocState>() {
                        if window.is_minimized().unwrap_or(false) {
                            state.hide_overlay();
                        } else {
                            state.handle_main_window_resized(window);
                        }
                    }
                }
            }
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::ScaleFactorChanged { .. } => {
                if window.label() == "player-overlay" {
                    embedded_poc::ensure_overlay_borderless_by_window(window);
                    if let Ok(raw) = window.hwnd() {
                        let h = raw.0 as usize;
                        embedded_poc::apply_overlay_client_region(h, None);
                    }
                } else if window.label() == "main" {
                    if let Some(state) = window.try_state::<embedded_poc::EmbeddedPocState>() {
                        state.handle_main_window_resized(window);
                    }
                }
            }
            tauri::WindowEvent::Destroyed => {
                if window.label() == "player-overlay" {
                    #[cfg(target_os = "windows")]
                    if let Ok(raw) = window.hwnd() {
                        embedded_poc::remove_overlay_subclass(raw.0 as usize);
                    }
                } else if window.label() == "main" {
                    if let Some(state) = window.try_state::<embedded_poc::EmbeddedPocState>() {
                        state.stop_sync();
                    }
                    if let Some(overlay) = window.app_handle().get_webview_window("player-overlay") {
                        let _ = overlay.destroy();
                    }
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let window = app.get_webview_window("main").expect("no main window");
                let _ = window.show();
                let _ = window.set_focus();
            }
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                if let Some(window) = app.get_webview_window("main") {
                    window_state::save_main_window_state(&window);
                }
                if let Some(state) = app.try_state::<embedded_poc::EmbeddedPocState>() {
                    state.stop_sync();
                }
                if let Some(overlay) = app.get_webview_window("player-overlay") {
                    let _ = overlay.destroy();
                }
            }
            _ => {}
        });
}

fn map_err_frontend(e: Error) -> String {
    return format!("{:?}", e);
}

#[tauri::command(async)]
fn get_m3u8(source: Source) -> Result<(), String> {
    m3u::read_m3u8(None, source, false).map_err(map_err_frontend)
}

#[tauri::command]
async fn get_m3u8_from_link(source: Source) -> Result<(), String> {
    m3u::get_m3u8_from_link(None, source, false)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn play(
    channel: Channel,
    record: bool,
    record_path: Option<String>,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    mpv::play(channel, record, record_path, state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_settings() -> Result<Settings, String> {
    settings::get_settings().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn update_settings(settings: Settings) -> Result<(), String> {
    settings::update_settings(settings).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn search(filters: Filters) -> Result<Vec<Channel>, String> {
    sql::search(filters).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn bulk_update(filters: Filters, action: u8) -> Result<(), String> {
    sql::bulk_update(filters, action).map_err(map_err_frontend)
}

#[tauri::command]
async fn get_xtream(source: Source) -> Result<(), String> {
    xtream::get_xtream(None, source, false)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn refresh_source(app: AppHandle, source: Source) -> Result<(), String> {
    utils::refresh_source(&app, source)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn refresh_all(app: AppHandle) -> Result<(), String> {
    utils::refresh_all(&app).await.map_err(map_err_frontend)
}

#[tauri::command]
async fn get_episodes(channel: Channel) -> Result<(), String> {
    xtream::get_episodes(channel)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn favorite_channel(channel_id: i64) -> Result<(), String> {
    sql::favorite_channel(channel_id, true).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn unfavorite_channel(channel_id: i64) -> Result<(), String> {
    sql::favorite_channel(channel_id, false).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn hide_channel(id: i64, hidden: bool) -> Result<(), String> {
    sql::hide_channel(id, hidden).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn hide_group(id: i64, hidden: bool) -> Result<(), String> {
    sql::hide_group(id, hidden).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn remove_from_history(id: i64) -> Result<(), String> {
    sql::remove_last_watched(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn source_name_exists(name: String) -> Result<bool, String> {
    sql::source_name_exists(&name).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_sources() -> Result<Vec<Source>, String> {
    sql::get_sources().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_enabled_sources() -> Result<Vec<Source>, String> {
    sql::get_enabled_sources().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_source(id: i64) -> Result<(), String> {
    sql::delete_source(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn toggle_source(value: bool, source_id: i64) -> Result<(), String> {
    sql::set_source_enabled(value, source_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_database() -> Result<(), String> {
    utils::create_nuke_request().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn add_custom_channel(channel: CustomChannel) -> Result<(), String> {
    sql::do_tx(|tx| sql::add_custom_channel(tx, channel)).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn edit_custom_channel(channel: CustomChannel) -> Result<(), String> {
    sql::edit_custom_channel(channel).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_custom_channel(id: i64) -> Result<(), String> {
    sql::delete_custom_channel(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_custom_channel_extra_data(
    id: i64,
    group_id: Option<i64>,
) -> Result<CustomChannelExtraData, String> {
    sql::get_custom_channel_extra_data(id, group_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn add_custom_source(name: String) -> Result<(), String> {
    sql::do_tx(|tx| sql::create_or_find_source_by_name(tx, &mut sql::get_custom_source(name)))
        .map_err(map_err_frontend)?;
    Ok(())
}

#[tauri::command(async)]
fn share_custom_channel(channel: Channel, path: String) -> Result<(), String> {
    share::share_custom_channel(channel, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn group_auto_complete(query: Option<String>, source_id: i64) -> Result<Vec<IdName>, String> {
    sql::group_auto_complete(query, source_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn edit_custom_group(group: Group) -> Result<(), String> {
    sql::edit_custom_group(group).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn add_custom_group(group: Group) -> Result<(), String> {
    sql::do_tx(|tx| {
        sql::add_custom_group(tx, group)?;
        Ok(())
    })
    .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn delete_custom_group(
    id: i64,
    new_id: Option<i64>,
    do_channels_update: bool,
) -> Result<(), String> {
    sql::delete_custom_group(id, new_id, do_channels_update).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn group_not_empty(id: i64) -> Result<bool, String> {
    sql::group_not_empty(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn group_exists(name: String, source_id: i64) -> Result<bool, String> {
    sql::group_exists(&name, source_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn share_custom_group(group: Channel, path: String) -> Result<(), String> {
    share::share_custom_group(group, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn share_custom_source(source: Source, path: String) -> Result<(), String> {
    share::share_custom_source(source, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn import(
    path: String,
    source_id: Option<i64>,
    name_override: Option<String>,
) -> Result<(), String> {
    share::import(path, source_id, name_override).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn channel_exists(name: String, url: String, source_id: i64) -> Result<bool, String> {
    sql::channel_exists(&name, &url, source_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn update_source(source: Source) -> Result<(), String> {
    sql::update_source(source).map_err(map_err_frontend)
}

#[tauri::command]
async fn get_epg(channel: Channel) -> Result<Vec<EPG>, String> {
    xtream::get_epg(channel).await.map_err(map_err_frontend)
}

#[tauri::command]
async fn download(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    channel: Channel,
    download_id: String,
    path: Option<String>,
) -> Result<(), String> {
    utils::download(state.clone(), app, channel, &download_id, path)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn abort_download(
    state: State<'_, Mutex<AppState>>,
    source_id: i64,
    download_id: String,
) -> Result<(), String> {
    mpv::cancel_play(source_id, download_id, state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn add_epg(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    epg: EPGNotify,
) -> Result<(), String> {
    epg::add_epg(state, app, epg)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
async fn remove_epg(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    epg_id: String,
) -> Result<(), String> {
    epg::remove_epg(state, app, epg_id)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_epg_ids() -> Result<Vec<String>, String> {
    sql::get_epg_ids().map_err(map_err_frontend)
}

#[tauri::command]
async fn on_start_check_epg(
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
) -> Result<(), String> {
    epg::on_start_check_epg(state, app)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn start_restream(
    port: u16,
    state: State<'_, Mutex<AppState>>,
    app: AppHandle,
    channel: Channel,
) -> Result<(), String> {
    crate::restream::start_restream(port, state, app, channel)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn stop_restream(state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    crate::restream::stop_restream(state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn watch_self(port: u16, state: State<'_, Mutex<AppState>>) -> Result<(), String> {
    restream::watch_self(port, state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn get_network_info() -> Result<NetworkInfo, String> {
    restream::get_network_info().await.map_err(map_err_frontend)
}

#[tauri::command(async)]
fn share_restream(address: String, channel: Channel, path: String) -> Result<(), String> {
    restream::share_restream(address, channel, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn add_last_watched(id: i64) -> Result<(), String> {
    sql::add_last_watched(id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn backup_favs(id: i64, path: String) -> Result<(), String> {
    utils::backup_favs(id, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn restore_favs(id: i64, path: String) -> Result<(), String> {
    utils::restore_favs(id, path).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn clear_history() -> Result<(), String> {
    sql::clear_history().map_err(map_err_frontend)
}

#[tauri::command(async)]
fn is_container() -> bool {
    utils::is_container()
}

#[tauri::command]
async fn cancel_play(
    source_id: i64,
    channel_id: i64,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    mpv::cancel_play(source_id, channel_id.to_string(), state)
        .await
        .map_err(map_err_frontend)
}

#[tauri::command]
async fn get_all_expiries() -> Result<HashMap<i64, i64>, String> {
    xtream::get_all_expiries().await.map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_source_content_counts(source_id: i64) -> Result<SourceContentCounts, String> {
    sql::get_source_content_counts(source_id).map_err(map_err_frontend)
}

#[tauri::command(async)]
fn get_all_source_content_counts() -> Result<HashMap<i64, SourceContentCounts>, String> {
    sql::get_all_source_content_counts().map_err(map_err_frontend)
}
