export class Settings {
  use_stream_caching?: boolean;
  mpv_params?: string;
  volume?: number;
  remember_volume?: boolean;
  refresh_on_start?: boolean;
  restream_port?: number;
  zoom?: number;
  default_sort?: number;
  enable_hwdec?: boolean;
  enable_gpu?: boolean;
  screenshot_path?: string;
  auto_reconnect?: boolean;
  reconnect_attempts?: number;
  default_audio_lang?: string;
  default_subtitle_lang?: string;
  enable_deinterlace?: boolean;
  buffer_preset?: string;
  live_start_last_channel?: boolean;
  default_live_folder?: string;
  auto_refresh_hours?: number;
  epg_refresh_hours?: number;
  remember_window_state?: boolean;
  clear_history_on_exit?: boolean;
  pin_lock_enabled?: boolean;
  app_pin_hash?: string;
  http_proxy?: string;
  overlay_glass_blur?: number;
  overlay_glass_opacity?: number;
  accent_color?: string;
  keybindings?: string;
}

export interface StorageStats {
  sqlite_bytes: number;
  history_count: number;
  hidden_count: number;
  favorites_count: number;
}
