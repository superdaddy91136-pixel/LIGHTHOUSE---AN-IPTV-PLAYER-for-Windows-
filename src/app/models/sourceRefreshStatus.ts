export interface SourceDeviceRefreshStatus {
  source_id: number;
  last_successful_refresh?: number;
  next_eligible_refresh?: number;
  current_status: string;
  is_deferred_playback: boolean;
  is_deferred_metered: boolean;
  last_error?: string;
}
