import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Router, NavigationStart } from '@angular/router';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, UnlistenFn } from '@tauri-apps/api/event';
import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { ViewMode } from '../models/viewMode';
import { SortType } from '../models/sortType';
import { Filters } from '../models/filters';
import { fromMediaType } from '../models/nodeType';
import { MemoryService } from '../memory.service';
import {
  cleanMediaTitle,
  sanitizeShowTitle,
  sanitizeEpisodeTitle,
  formatPlayerEpisodeLabel,
  extractYear,
} from '../utils/media-presentation';
import { isInputFocused } from '../utils';
import { VersionMatchingService } from './version-matching.service';
import { MediaVersion } from '../models/version';
import { MovieDetailService } from './movie-detail.service';
import { TvDetailService } from './tv-detail.service';
import { HomeDiscoveryStateService } from './home-discovery-state.service';
import { TmdbEnrichmentService } from './tmdb-enrichment.service';
import { PlaybackSegmentService, ResolveSegmentOptions } from './playback-segment.service';
import { AppPreferencesService } from './app-preferences.service';
import { Settings } from '../models/settings';

export type ContentMode = 'movie' | 'episode' | 'live';

export interface SwitcherEpisodeData {
  id: number;
  channel: Channel;
  episodeNum: number;
  seasonNum: number;
  title: string;
  stillUrl?: string;
  isWatched?: boolean;
  isCurrent?: boolean;
}

export interface SwitcherSeasonData {
  id: number;
  seasonNum: number;
  name: string;
}

export interface SwitcherChannelData {
  id: number;
  name: string;
  logo?: string;
  group?: string;
  group_id?: number;
  isCurrent?: boolean;
  channel?: Channel;
}

export interface WatchProgressRecord {
  identity_key: string;
  channel_id?: number | null;
  position_sec: number;
  duration_sec: number;
  progress_percent: number;
  completed: boolean;
  updated_at: number;
  last_watched: number;
  tmdb_id?: number | null;
}

export interface ResolvedPlaybackState {
  positionSec: number;
  durationSec: number;
  completed: boolean;
  source: 'watch_history' | 'legacy' | 'none';
}

export function clearLegacyWatchProgressStorage(channelIds?: number[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (channelIds && channelIds.length > 0) {
      const idSet = new Set(channelIds.map((id) => String(id)));
      const storeRaw = localStorage.getItem('fred_tv_watch_progress');
      if (storeRaw) {
        try {
          const store = JSON.parse(storeRaw);
          if (store && typeof store === 'object') {
            let changed = false;
            for (const key of idSet) {
              if (key in store) {
                delete store[key];
                changed = true;
              }
            }
            if (changed) {
              localStorage.setItem('fred_tv_watch_progress', JSON.stringify(store));
            }
          }
        } catch {}
      }
      for (const id of idSet) {
        localStorage.removeItem(`playback_pos_${id}`);
        localStorage.removeItem(`playback_dur_${id}`);
        localStorage.removeItem(`watch_progress_${id}`);
      }
      return;
    }

    localStorage.removeItem('fred_tv_watch_progress');
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k &&
        (k.startsWith('playback_pos_') ||
          k.startsWith('playback_dur_') ||
          k.startsWith('watch_progress_') ||
          k.startsWith('fred_tv_series_next_ep_'))
      ) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
  } catch {}
}

export interface EmbeddedPlayerOptions {
  title?: string;
  mode?: ContentMode;
  startTime?: number;
  duration?: number;
  // TV Episode switcher options
  seriesChannel?: Channel;
  seriesTitle?: string;
  seasons?: SwitcherSeasonData[];
  currentSeasonNum?: number;
  currentEpisodeNum?: number;
  episodes?: SwitcherEpisodeData[];
  onSwitchEpisode?: (channel: Channel) => void | Promise<void>;
  // Live TV channel switcher options
  channels?: (Channel | SwitcherChannelData)[];
  currentGroupId?: number;
  onSwitchChannel?: (channel: Channel) => void | Promise<void>;
  skipHistory?: boolean;
  isReconnect?: boolean;
}

export interface SwitchChannelOptions {
  isReconnect?: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class EmbeddedPlayerService implements OnDestroy {
  private isPlayingEmbeddedSubject = new BehaviorSubject<boolean>(false);
  public isPlayingEmbedded$: Observable<boolean> = this.isPlayingEmbeddedSubject.asObservable();

  private isFullscreenSubject = new BehaviorSubject<boolean>(false);
  public isFullscreen$: Observable<boolean> = this.isFullscreenSubject.asObservable();
  public lastWatchedUpdated$ = new Subject<number>();

  public playbackProgress$ = new BehaviorSubject<{
    channelId?: number;
    time: number;
    duration: number;
    percent: number;
  }>({ time: 0, duration: 0, percent: 0 });

  public get isPlayingEmbedded(): boolean {
    return this.isPlayingEmbeddedSubject.value;
  }

  public get isFullscreen(): boolean {
    return this.isFullscreenSubject.value;
  }

  private currentMode: ContentMode = 'movie';
  private authoritativeProgressCache = new Map<number, WatchProgressRecord>();
  private lastDbProgressSync = new Map<
    number,
    { time: number; duration: number; completed: boolean; syncedAt: number }
  >();
  private dbProgressErrorLogged = new Set<number>();
  private legacyMigrationPromise: Promise<void> | null = null;
  private legacyMigrationTimer: ReturnType<typeof setTimeout> | null = null;

  protected invokeIpc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(cmd, args);
  }
  public get mode(): ContentMode {
    return this.currentMode;
  }

  private hostTarget: HTMLElement | string | null = null;
  private currentChannel?: Channel;
  private activeFallbackChannel?: Channel;
  private videoResizeObserver: ResizeObserver | null = null;
  private syncScheduled: boolean = false;
  private boundScrollHandler = () => this.syncBounds();
  private boundKeyDownHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
  private keyHandlerAttached: boolean = false;
  private isRestartingPlayer: boolean = false;
  private screenshotInFlight: boolean = false;

  // TV Episode switcher state
  private seriesChannel?: Channel;
  private seriesTitle?: string;
  private seasons: SwitcherSeasonData[] = [];
  private currentSeasonNum: number = 1;
  private currentEpisodeNum?: number;
  private episodes: SwitcherEpisodeData[] = [];
  private onSwitchEpisodeCallback?: (channel: Channel) => void | Promise<void>;
  private lastPlayerOptions?: EmbeddedPlayerOptions;

  // Live TV switcher state
  private liveChannels: SwitcherChannelData[] = [];
  private currentGroupId?: number;
  private onSwitchChannelCallback?: (channel: Channel) => void | Promise<void>;

  private unlistenStopped?: UnlistenFn;
  private unlistenFullscreen?: UnlistenFn;
  private unlistenSyncBounds?: UnlistenFn;
  private unlistenAspect?: UnlistenFn;
  private unlistenPlayerStarted?: UnlistenFn;
  private unlistenRequestMode?: UnlistenFn;
  private unlistenRequestCrop?: UnlistenFn;
  private unlistenGlobalStopped?: UnlistenFn;

  private unlistenRequestEpisodes?: UnlistenFn;
  private unlistenChangeSeason?: UnlistenFn;
  private unlistenSelectEpisode?: UnlistenFn;
  private unlistenRequestChannels?: UnlistenFn;
  private unlistenSelectChannel?: UnlistenFn;
  private unlistenSaveProgress?: UnlistenFn;
  private unlistenSaveVolume?: UnlistenFn;
  private unlistenSettingsUpdated?: UnlistenFn;
  private unlistenRequestRecommendations?: UnlistenFn;
  private unlistenPlayRecommendedMovie?: UnlistenFn;
  private unlistenRequestSegments?: UnlistenFn;
  private unlistenContextualAction?: UnlistenFn;
  private unlistenPocEvent?: UnlistenFn;

  private autoReconnectEnabled: boolean = true;
  private reconnectMaxAttempts: number = 3;
  private isStoppingPlayer: boolean = false;
  private isReconnectingLive: boolean = false;
  private isLiveStreamFailedIdle: boolean = false;
  private reconnectAttemptCount: number = 0;
  private reconnectGeneration: number = 0;
  private pendingReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthyPlaybackTimer: ReturnType<typeof setTimeout> | null = null;
  private hasHandledLiveFailureStop: boolean = false;

  private hasContextualAction: boolean = false;
  private currentContextualAction: string | null = null;

  private routerSubscription?: Subscription;

  private savedScrollTop: number = 0;
  private savedMainScrollTop: number = 0;

  constructor(
    private ngZone: NgZone,
    private router: Router,
    private memory: MemoryService,
    private versionMatching: VersionMatchingService,
    private movieDetailService: MovieDetailService,
    private tvDetailService: TvDetailService,
    private homeDiscoveryState: HomeDiscoveryStateService,
    private tmdbEnrichment: TmdbEnrichmentService,
    private playbackSegmentService: PlaybackSegmentService,
    private appPreferences: AppPreferencesService,
  ) {
    this.initGlobalListeners();
    this.routerSubscription = this.router.events
      .pipe(filter((event) => event instanceof NavigationStart))
      .subscribe(() => {
        if (this.isPlayingEmbedded) {
          this.stopPlayer().catch(console.warn);
        }
      });
  }

  private async markLastWatched(channelId: number): Promise<void> {
    try {
      await invoke('add_last_watched', { id: channelId });
      this.lastWatchedUpdated$.next(channelId);
    } catch (err) {
      console.warn('Failed to record playback history:', err);
    }
  }

  private applyReconnectSettings(settings?: Settings | null): void {
    this.autoReconnectEnabled = settings?.auto_reconnect !== false;
    const raw = settings?.reconnect_attempts;
    this.reconnectMaxAttempts = raw === 1 || raw === 3 || raw === 5 ? raw : 3;
  }

  private async loadReconnectSettings(): Promise<void> {
    try {
      const settings = await invoke<Settings>('get_settings');
      this.applyReconnectSettings(settings);
    } catch (err) {
      console.warn('Failed to load reconnect settings:', err);
    }
  }

  private clearPendingReconnectTimers(): void {
    if (this.pendingReconnectTimer !== null) {
      clearTimeout(this.pendingReconnectTimer);
      this.pendingReconnectTimer = null;
    }
    if (this.healthyPlaybackTimer !== null) {
      clearTimeout(this.healthyPlaybackTimer);
      this.healthyPlaybackTimer = null;
    }
  }

  private cancelPendingReconnect(emitOverlayReset: boolean = true): void {
    this.reconnectGeneration += 1;
    this.clearPendingReconnectTimers();
    this.isReconnectingLive = false;
    this.isLiveStreamFailedIdle = false;
    this.reconnectAttemptCount = 0;
    if (emitOverlayReset) {
      emit('live-reconnect-state', { reconnecting: false, failedIdle: false }).catch(console.warn);
    }
  }

  private scheduleHealthyPlaybackReset(): void {
    if (this.healthyPlaybackTimer !== null) {
      clearTimeout(this.healthyPlaybackTimer);
      this.healthyPlaybackTimer = null;
    }
    const gen = this.reconnectGeneration;
    const channelId = this.currentChannel?.id;
    this.healthyPlaybackTimer = setTimeout(() => {
      this.healthyPlaybackTimer = null;
      if (
        gen === this.reconnectGeneration &&
        this.isPlayingEmbedded &&
        this.currentMode === 'live' &&
        this.currentChannel?.id === channelId
      ) {
        this.reconnectAttemptCount = 0;
        this.isReconnectingLive = false;
        this.isLiveStreamFailedIdle = false;
      }
    }, 10000);
  }

  private failLiveStreamIdle(message: string): void {
    this.reconnectGeneration += 1;
    this.clearPendingReconnectTimers();
    this.isReconnectingLive = false;
    this.reconnectAttemptCount = 0;
    this.isLiveStreamFailedIdle = true;
    this.hasHandledLiveFailureStop = true;
    emit('live-reconnect-state', { reconnecting: false, failedIdle: true }).catch(console.warn);
    emit('screenshot-feedback', {
      message,
      isError: true,
      isReconnect: false,
    }).catch(console.warn);
  }

  private handleLiveStreamError(): void {
    if (
      !this.isPlayingEmbedded ||
      this.currentMode !== 'live' ||
      this.isStoppingPlayer ||
      this.hasHandledLiveFailureStop ||
      this.isLiveStreamFailedIdle
    ) {
      return;
    }
    if (this.pendingReconnectTimer !== null) {
      return;
    }
    const targetChannel = this.currentChannel;
    if (!targetChannel || targetChannel.id == null) {
      return;
    }

    if (!this.autoReconnectEnabled) {
      this.failLiveStreamIdle('Channel stream failed to load');
      return;
    }

    if (this.reconnectAttemptCount >= this.reconnectMaxAttempts) {
      this.failLiveStreamIdle('Channel stream failed to load');
      return;
    }

    this.reconnectAttemptCount += 1;
    const attempt = this.reconnectAttemptCount;
    const maxAttempts = this.reconnectMaxAttempts;
    const delayMs = Math.min(8000, 2000 * Math.pow(2, attempt - 1));
    this.isReconnectingLive = true;
    this.isLiveStreamFailedIdle = false;
    if (this.healthyPlaybackTimer !== null) {
      clearTimeout(this.healthyPlaybackTimer);
      this.healthyPlaybackTimer = null;
    }

    const gen = this.reconnectGeneration;
    const retryChannel = targetChannel;

    emit('live-reconnect-state', { reconnecting: true, failedIdle: false, attempt, maxAttempts }).catch(console.warn);
    emit('screenshot-feedback', {
      message: `Reconnecting (${attempt}/${maxAttempts})...`,
      isError: false,
      isReconnect: true,
    }).catch(console.warn);

    this.pendingReconnectTimer = setTimeout(() => {
      this.pendingReconnectTimer = null;
      if (
        gen !== this.reconnectGeneration ||
        !this.isPlayingEmbedded ||
        this.currentMode !== 'live' ||
        this.isStoppingPlayer ||
        this.currentChannel?.id !== retryChannel.id
      ) {
        return;
      }
      void this.executeReconnectAttempt(retryChannel, gen);
    }, delayMs);
  }

  private async executeReconnectAttempt(channel: Channel, gen: number): Promise<void> {
    if (
      gen !== this.reconnectGeneration ||
      !this.isPlayingEmbedded ||
      this.currentMode !== 'live' ||
      this.isStoppingPlayer
    ) {
      return;
    }
    try {
      await this.switchChannel(channel, undefined, { isReconnect: true });
    } catch (err) {
      console.warn('Live stream reconnect attempt failed:', err);
      if (
        gen === this.reconnectGeneration &&
        !this.isStoppingPlayer &&
        this.pendingReconnectTimer === null &&
        this.isPlayingEmbedded &&
        this.currentMode === 'live'
      ) {
        this.handleLiveStreamError();
      }
    }
  }

  private async initGlobalListeners(): Promise<void> {
    this.loadReconnectSettings().catch(console.warn);
    this.unlistenSettingsUpdated = await listen<Settings>('settings-updated', (event) => {
      this.applyReconnectSettings(event?.payload);
    });
    // Listen for stream started (captures stream info only if started outside service, e.g. movie screen)
    this.unlistenPlayerStarted = await listen('embedded-player-started', (event: any) => {
      this.ngZone.run(() => {
        const stream = event?.payload;
        if (!this.isPlayingEmbedded && stream?.channel_id && stream?.url) {
          this.activeFallbackChannel = {
            id: stream.channel_id,
            name: stream.name,
            url: stream.url,
            source_id: stream.source_id,
            media_type: MediaType.movie,
          };
          this.currentChannel = this.activeFallbackChannel;
          this.currentMode = 'movie';
          emit('embedded-player-mode', { mode: 'movie', channelId: stream.channel_id }).catch(console.warn);
          this.emitPlaybackSegments(this.activeFallbackChannel, this.lastPlayerOptions).catch(console.warn);
        }
      });
    });

    // Listen for mode request from overlay (on late-load or restart)
    this.unlistenRequestMode = await listen('request-player-mode', () => {
      emit('embedded-player-mode', { mode: this.currentMode, channelId: this.currentChannel?.id }).catch(console.warn);
    });

    // Listen for top-crop request from overlay
    this.unlistenRequestCrop = await listen('request-overlay-top-crop', () => {
      const crop = 32;
      emit('overlay-top-crop', { crop }).catch(console.warn);
    });

    // Global listener for player stopped (catches exits/crashes cleanly without black screen)
    this.unlistenGlobalStopped = await listen('embedded-poc-stopped', () => {
      this.ngZone.run(() => {
        if (this.isPlayingEmbedded) {
          this.handlePlayerStopped();
        }
      });
    });

    // Listen for episodes request from overlay
    this.unlistenRequestEpisodes = await listen('request-player-episodes', async () => {
      if (this.currentMode === 'episode') {
        if (this.episodes.length === 0) {
          if (this.seasons.length === 0 && this.currentChannel) {
            await this.loadSeriesAndSeasons(this.currentChannel, this.currentSeasonNum);
          } else if (this.seasons.length > 0) {
            const targetSeason = this.seasons.find((s) => s.seasonNum === this.currentSeasonNum) || this.seasons[0];
            if (targetSeason) {
              await this.loadEpisodesForSeason(targetSeason.id, targetSeason.seasonNum);
            }
          }
        }
      }
      this.emitEpisodesData();
    });

    // Listen for season change request from overlay
    this.unlistenChangeSeason = await listen('request-change-season', (event: any) => {
      const payload = event?.payload;
      if (payload?.seasonId) {
        this.loadEpisodesForSeason(payload.seasonId, payload.seasonNum || 1);
      }
    });

    // Listen for episode selection from overlay
    this.unlistenSelectEpisode = await listen('select-player-episode', async (event: any) => {
      const episodeId = event?.payload?.episodeId ?? event?.payload?.id;
      let targetEp = this.episodes.find((e) => e.id === episodeId);
      const targetChannel: Channel | undefined = targetEp?.channel || event?.payload?.channel;
      const chId = targetChannel?.id || episodeId;

      if (chId) {
        this.markLastWatched(chId).catch(console.warn);
      }

      if (!targetEp && targetChannel) {
        const epNum = targetChannel.episode_num || this.extractEpisodeNumber(targetChannel.name);
        const sNum = (targetChannel as any).seasonNum || this.extractSeasonNumber(targetChannel);
        targetEp = {
          id: targetChannel.id!,
          channel: targetChannel,
          episodeNum: epNum,
          seasonNum: sNum,
          title: cleanMediaTitle(targetChannel.name || `Episode ${epNum}`),
          stillUrl: targetChannel.image,
          isWatched: true,
          isCurrent: true,
        };
      }

      if (targetEp) {
        targetEp.isWatched = true;
        (targetEp.channel as any).last_watched = Date.now();
        const prevSeasonNum = this.currentSeasonNum;
        this.currentSeasonNum = targetEp.seasonNum;

        // If target episode is from a different season and we don't have onSwitchEpisodeCallback, load that season's episodes
        if (!this.onSwitchEpisodeCallback && targetChannel?.season_id && targetEp.seasonNum !== prevSeasonNum) {
          await this.loadEpisodesForSeason(targetChannel.season_id, targetEp.seasonNum);
        } else {
          this.emitEpisodesData();
        }

        this.ngZone.run(() => {
          if (this.onSwitchEpisodeCallback) {
            this.onSwitchEpisodeCallback(targetEp!.channel);
          } else {
            const seriesName = this.seriesTitle || this.extractSeriesTitle(targetEp!.channel) || '';
            const sNum = String(targetEp!.seasonNum).padStart(2, '0');
            const eNum = String(targetEp!.episodeNum).padStart(2, '0');
            const overlayTitle = seriesName
              ? `${seriesName} - S${sNum}E${eNum}: ${targetEp!.title}`.trim()
              : `S${sNum}E${eNum}: ${targetEp!.title}`.trim();
            this.startPlayer(targetEp!.channel, this.hostTarget || this.resolveVideoCanvasId(), {
              mode: 'episode',
              title: overlayTitle,
              seriesChannel: this.seriesChannel,
              seriesTitle: this.seriesTitle || seriesName,
              seasons: this.seasons,
              currentSeasonNum: targetEp!.seasonNum,
              episodes: this.episodes,
            });
          }
        });
      }
    });

    // Listen for live channels request from overlay
    this.unlistenRequestChannels = await listen('request-player-channels', async () => {
      if (this.liveChannels.length === 0) {
        await this.loadLiveChannels();
      } else {
        this.emitChannelsData();
      }
    });

    // Listen for channel selection from overlay
    this.unlistenSelectChannel = await listen('select-player-channel', (event: any) => {
      const channelId = event?.payload?.channelId ?? event?.payload?.id;
      let targetCh: Channel | undefined = event?.payload?.channel;
      if (!targetCh || !targetCh.url) {
        const found = this.liveChannels.find((c) => c.id === channelId);
        targetCh = found?.channel;
      }
      if (!targetCh && channelId != null) {
        targetCh = { id: channelId, name: event?.payload?.name || 'Live Channel' } as Channel;
      }
      if (targetCh) {
        if (event?.payload?.channel?.group_id != null) {
          targetCh.group_id = event.payload.channel.group_id;
          this.currentGroupId = event.payload.channel.group_id;
        }
        this.ngZone.run(() => {
          this.switchChannel(targetCh!);
        });
      }
    });

    // Listen for playback progress save requests from overlay
    this.unlistenSaveProgress = await listen('save-playback-progress', (event: any) => {
      const payload = event?.payload;
      if (payload?.channelId != null && payload?.time > 0) {
        this.saveWatchProgress(payload.channelId, payload.time, payload.duration || 0, payload.completed);
      }
    });

    // Listen for debounced volume updates from overlay (persisted only if remember_volume is enabled)
    this.unlistenSaveVolume = await listen('save-player-volume', async (event: any) => {
      const raw = event?.payload?.volume;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
      const clamped = Math.min(100, Math.max(0, Math.round(raw)));
      try {
        await invoke('set_remembered_volume', { volume: clamped });
      } catch (err) {
        console.warn('Failed to persist remembered volume:', err);
      }
    });

    // Listen for movie recommendations request from overlay
    this.unlistenRequestRecommendations = await listen('request-movie-recommendations', () => {
      if (this.currentMode === 'movie' && this.currentChannel) {
        this.emitMovieRecommendations(this.currentChannel).catch(console.warn);
      }
    });

    // Listen for recommended movie play request from overlay
    this.unlistenPlayRecommendedMovie = await listen('play-recommended-movie', async (event: any) => {
      const payload = event?.payload;
      const targetChannel: Channel | undefined = payload?.channel;
      if (targetChannel) {
        this.ngZone.run(async () => {
          this.movieDetailService.setSelectedMovie(targetChannel);
          const canvas = typeof this.hostTarget === 'string' ? this.hostTarget : this.resolveVideoCanvasId();
          await this.playMediaDirectly(targetChannel, canvas);
        });
      }
    });

    // Listen for playback segments request from overlay
    this.unlistenRequestSegments = await listen('request-player-segments', () => {
      const target = this.currentChannel || this.activeFallbackChannel;
      if (target) {
        this.emitPlaybackSegments(target, this.lastPlayerOptions).catch(console.warn);
      }
    });

    // Listen for contextual action selection state from overlay (Spacebar priority)
    this.unlistenContextualAction = await listen('overlay-contextual-action', (event: any) => {
      this.hasContextualAction = !!event?.payload?.active;
      this.currentContextualAction = event?.payload?.action || null;
    });

    // Listen for raw MPV IPC events to track playback progress outside Angular zone
    // to prevent high-frequency IPC events from triggering application-wide change detection.
    let lastProgressEmitTime = 0;
    let lastReportedPercent = -1;

    this.unlistenPocEvent = await this.ngZone.runOutsideAngular(async () => {
      return await listen('embedded-poc-event', (event: any) => {
        if (typeof event?.payload === 'string') {
          try {
            const parsed = JSON.parse(event.payload);
            if (parsed.event === 'end-file' && parsed.reason === 'error') {
              if (this.currentMode === 'live' && this.isPlayingEmbedded) {
                this.ngZone.run(() => {
                  this.handleLiveStreamError();
                });
              }
              return;
            }
            if (parsed.event === 'file-loaded' || parsed.event === 'playback-restart') {
              if (
                this.currentMode === 'live' &&
                this.isPlayingEmbedded &&
                (this.isReconnectingLive || this.isLiveStreamFailedIdle || this.reconnectAttemptCount > 0)
              ) {
                this.ngZone.run(() => {
                  this.isReconnectingLive = false;
                  this.isLiveStreamFailedIdle = false;
                  emit('live-reconnect-state', { reconnecting: false, failedIdle: false }).catch(console.warn);
                  this.scheduleHealthyPlaybackReset();
                });
              }
            }
            if (parsed.event === 'property-change') {
              if (parsed.name === 'time-pos' && typeof parsed.data === 'number') {
                const now = Date.now();
                const curTime = parsed.data;
                const curState = this.playbackProgress$.value;
                const dur = curState.duration;
                const pct = dur > 0 ? Math.min(100, Math.max(0, (curTime / dur) * 100)) : 0;
                const intPct = Math.floor(pct);

                // Throttle progress emissions: notify subscribers at most once per second or when whole % advances
                if (now - lastProgressEmitTime >= 1000 || intPct !== lastReportedPercent) {
                  lastProgressEmitTime = now;
                  lastReportedPercent = intPct;
                  this.ngZone.run(() => {
                    this.playbackProgress$.next({
                      channelId: this.currentChannel?.id,
                      time: curTime,
                      duration: dur,
                      percent: pct,
                    });
                  });
                }
              } else if (parsed.name === 'duration' && typeof parsed.data === 'number' && parsed.data > 0) {
                const dur = parsed.data;
                const curState = this.playbackProgress$.value;
                const curTime = curState.time;
                const pct = dur > 0 ? Math.min(100, Math.max(0, (curTime / dur) * 100)) : 0;
                this.ngZone.run(() => {
                  this.playbackProgress$.next({
                    channelId: this.currentChannel?.id,
                    time: curTime,
                    duration: dur,
                    percent: pct,
                  });
                });
              }
            }
          } catch {}
        }
      });
    });
  }

  private getHostElement(): HTMLElement | null {
    if (!this.hostTarget) {
      const fallbackId = this.resolveVideoCanvasId();
      return document.getElementById(fallbackId);
    }
    if (typeof this.hostTarget === 'string') {
      const el = document.getElementById(this.hostTarget);
      if (el) return el;
      // Fallback: in case hostTarget ID doesn't exist on current route, resolve dynamically
      const dynamicId = this.resolveVideoCanvasId();
      if (dynamicId !== this.hostTarget) {
        return document.getElementById(dynamicId);
      }
      return null;
    }
    return this.hostTarget;
  }

  private saveScrollPosition(): void {
    try {
      this.savedScrollTop =
        window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    } catch {
      this.savedScrollTop = 0;
    }
    const main = document.querySelector('.app-main');
    this.savedMainScrollTop = main ? main.scrollTop : 0;
  }

  private restoreScrollPosition(): void {
    setTimeout(() => {
      try {
        window.scrollTo({ top: this.savedScrollTop, behavior: 'instant' as ScrollBehavior });
      } catch {
        window.scrollTo(0, this.savedScrollTop);
      }
      const main = document.querySelector('.app-main');
      if (main) {
        main.scrollTop = this.savedMainScrollTop;
      }
    }, 20);
  }

  private async setupTauriListeners(): Promise<void> {
    this.cleanupTauriListeners();

    this.unlistenStopped = await listen('embedded-poc-stopped', () => {
      this.ngZone.run(() => {
        this.handlePlayerStopped();
      });
    });

    this.unlistenFullscreen = await listen('player-fullscreen-changed', (event: any) => {
      this.ngZone.run(() => {
        this.applyFullscreenState(!!event.payload);
      });
    });

    this.unlistenSyncBounds = await listen('sync-video-bounds', () => {
      this.ngZone.run(() => {
        this.syncBounds();
      });
    });

    this.unlistenAspect = await listen('video-aspect-changed', (_event: any) => {
      // Theater mode fills the whole content area; MPV letterboxes automatically.
    });
  }

  private cleanupTauriListeners(): void {
    if (this.unlistenStopped) {
      this.unlistenStopped();
      this.unlistenStopped = undefined;
    }
    if (this.unlistenFullscreen) {
      this.unlistenFullscreen();
      this.unlistenFullscreen = undefined;
    }
    if (this.unlistenSyncBounds) {
      this.unlistenSyncBounds();
      this.unlistenSyncBounds = undefined;
    }
    if (this.unlistenAspect) {
      this.unlistenAspect();
      this.unlistenAspect = undefined;
    }
  }

  private attachKeyHandler(): void {
    if (!this.keyHandlerAttached) {
      window.addEventListener('keydown', this.boundKeyDownHandler, true);
      this.keyHandlerAttached = true;
    }
  }

  private removeKeyHandler(): void {
    if (this.keyHandlerAttached) {
      window.removeEventListener('keydown', this.boundKeyDownHandler, true);
      this.keyHandlerAttached = false;
    }
  }

  private async captureScreenshot(): Promise<void> {
    if (this.screenshotInFlight || !this.isPlayingEmbedded) return;
    this.screenshotInFlight = true;
    try {
      const res = await invoke<{ path: string; filename: string }>('take_embedded_screenshot');
      const filename = res?.filename || 'screenshot.png';
      emit('screenshot-feedback', {
        message: `Saved screenshot: ${filename}`,
        isError: false,
      }).catch(console.warn);
    } catch (err: any) {
      const message =
        typeof err === 'string'
          ? err
          : err?.message || 'Failed to capture screenshot';
      emit('screenshot-feedback', {
        message,
        isError: true,
      }).catch(console.warn);
    } finally {
      this.screenshotInFlight = false;
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.isPlayingEmbedded) return;

    if (
      event.key === 'Escape' ||
      event.key === 'BrowserBack' ||
      (event.key === 'Backspace' && !isInputFocused())
    ) {
      if (this.isFullscreen) {
        invoke('toggle_player_fullscreen').catch(console.error);
      } else {
        this.stopPlayer();
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.appPreferences.matchesAction(event, 'screenshot')) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && !this.screenshotInFlight) {
        void this.captureScreenshot();
      }
      return;
    }

    if (isInputFocused()) return;

    if (this.appPreferences.matchesAction(event, 'togglePlay')) {
      event.preventDefault();
      event.stopPropagation();
      if (this.hasContextualAction) {
        if (event.repeat) return;
        emit('execute-contextual-action').catch(console.warn);
      } else {
        invoke('send_embedded_poc_ipc', {
          command: JSON.stringify({ command: ['cycle', 'pause'] }),
        }).catch(console.warn);
      }
      return;
    }

    if (this.appPreferences.matchesAction(event, 'seekBack')) {
      if (this.currentMode !== 'live') {
        emit('player-seek-left').catch(console.warn);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.appPreferences.matchesAction(event, 'seekForward')) {
      if (this.currentMode !== 'live') {
        emit('player-seek-right').catch(console.warn);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.appPreferences.matchesAction(event, 'volumeUp') || event.key === 'AudioVolumeUp') {
      emit('player-volume-up').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.appPreferences.matchesAction(event, 'volumeDown') || event.key === 'AudioVolumeDown') {
      emit('player-volume-down').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.appPreferences.matchesAction(event, 'toggleFullscreen')) {
      invoke('toggle_player_fullscreen').catch(console.error);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.appPreferences.matchesAction(event, 'toggleMute') || event.key === 'AudioVolumeMute') {
      emit('player-volume-mute').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.appPreferences.matchesAction(event, 'toggleNerdStats')) {
      emit('toggle-nerd-stats').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.appPreferences.matchesAction(event, 'speedUp')) {
      if (this.currentMode !== 'live') {
        emit('player-speed-up').catch(console.warn);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.appPreferences.matchesAction(event, 'speedDown')) {
      if (this.currentMode !== 'live') {
        emit('player-speed-down').catch(console.warn);
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (
      (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      emit('player-sub-delay-up').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (
      (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      emit('player-sub-delay-down').catch(console.warn);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (this.currentMode === 'live') {
      if (this.appPreferences.matchesAction(event, 'nextChannel') || event.key === 'ChannelUp') {
        emit('player-channel-next').catch(console.warn);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.appPreferences.matchesAction(event, 'prevChannel') || event.key === 'ChannelDown') {
        emit('player-channel-prev').catch(console.warn);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.appPreferences.matchesAction(event, 'recallChannel')) {
        emit('player-channel-recall').catch(console.warn);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.appPreferences.matchesAction(event, 'toggleChannelsDrawer')) {
        emit('toggle-channels-drawer').catch(console.warn);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  }

  public syncBounds(immediate: boolean = false): void {
    if (!this.isPlayingEmbedded || this.isFullscreen) return;

    const doSync = () => {
      this.syncScheduled = false;
      if (!this.isPlayingEmbedded || this.isFullscreen) return;

      const el = this.getHostElement();
      const dpr = window.devicePixelRatio || 1;
      let x = 0;
      let y = 0;
      let width = Math.round(window.innerWidth * dpr);
      let height = Math.round(window.innerHeight * dpr);

      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          x = Math.round(rect.x * dpr);
          y = Math.round(rect.y * dpr);
          width = Math.round(rect.width * dpr);
          height = Math.round(rect.height * dpr);
        }
      }

      if (width <= 0 || height <= 0) return;

      invoke('resize_embedded_poc', { x, y, width, height }).catch((err) => {
        console.warn('resize_embedded_poc error', err);
      });
    };

    if (immediate) {
      doSync();
      return;
    }

    if (this.syncScheduled) return;
    this.syncScheduled = true;
    requestAnimationFrame(doSync);
  }

  private setupVideoResizeObserver(): void {
    this.cleanupVideoResizeObserver();
    const el = this.getHostElement();
    if (!el) return;

    if (typeof ResizeObserver !== 'undefined') {
      this.videoResizeObserver = new ResizeObserver(() => {
        this.syncBounds();
      });
      this.videoResizeObserver.observe(el);
      const parent = el.parentElement;
      if (parent) {
        this.videoResizeObserver.observe(parent);
      }
    }

    const appMain = document.querySelector('.app-main');
    if (appMain) {
      appMain.addEventListener('scroll', this.boundScrollHandler, { passive: true });
    }
    window.addEventListener('scroll', this.boundScrollHandler, { passive: true });
    window.addEventListener('resize', this.boundScrollHandler, { passive: true });
  }

  private cleanupVideoResizeObserver(): void {
    if (this.videoResizeObserver) {
      this.videoResizeObserver.disconnect();
      this.videoResizeObserver = null;
    }
    const appMain = document.querySelector('.app-main');
    if (appMain) {
      appMain.removeEventListener('scroll', this.boundScrollHandler);
    }
    window.removeEventListener('scroll', this.boundScrollHandler);
    window.removeEventListener('resize', this.boundScrollHandler);
  }

  private applyFullscreenState(isFs: boolean): void {
    this.isFullscreenSubject.next(isFs);
    emit('overlay-top-crop', { crop: 32 }).catch(console.warn);
    if (isFs) {
      document.body.classList.add('fullscreen-player-active');
    } else {
      document.body.classList.remove('fullscreen-player-active');
      setTimeout(() => this.syncBounds(true), 50);
    }
  }

  public async toggleFullscreen(): Promise<void> {
    if (!this.isPlayingEmbedded) return;
    try {
      await invoke('toggle_player_fullscreen');
    } catch (e) {
      console.warn('Failed to toggle fullscreen:', e);
    }
  }

  private handlePlayerStopped(): void {
    if (this.isRestartingPlayer || this.isReconnectingLive || this.isLiveStreamFailedIdle) {
      return;
    }
    this.cancelPendingReconnect(false);
    this.hasHandledLiveFailureStop = false;
    this.cleanupVideoResizeObserver();
    this.removeKeyHandler();
    this.cleanupTauriListeners();

    this.currentMode = 'movie';
    emit('embedded-player-mode', { mode: 'movie' }).catch(console.warn);
    emit('overlay-top-crop', { crop: 32 }).catch(console.warn);
    this.playbackProgress$.next({ channelId: undefined, time: 0, duration: 0, percent: 0 });
    this.hasContextualAction = false;
    this.currentContextualAction = null;

    this.currentChannel = undefined;
    this.activeFallbackChannel = undefined;
    this.seriesChannel = undefined;
    this.seriesTitle = undefined;
    this.lastPlayerOptions = undefined;
    this.seasons = [];
    this.episodes = [];
    this.onSwitchEpisodeCallback = undefined;
    this.liveChannels = [];
    this.onSwitchChannelCallback = undefined;

    if (this.isFullscreen) {
      this.isFullscreenSubject.next(false);
    }
    document.body.classList.remove('theater-mode-active');
    document.body.classList.remove('fullscreen-player-active');

    this.isPlayingEmbeddedSubject.next(false);
    this.tmdbEnrichment.setPlaybackActive(false);
    this.restoreScrollPosition();
  }

  public async stopPlayer(): Promise<void> {
    this.isStoppingPlayer = true;
    this.cancelPendingReconnect(true);
    try {
      this.cleanupVideoResizeObserver();
      this.removeKeyHandler();
      this.cleanupTauriListeners();

      this.currentMode = 'movie';
      emit('embedded-player-mode', { mode: 'movie' }).catch(console.warn);
      emit('overlay-top-crop', { crop: 32 }).catch(console.warn);
      this.appPreferences.emitOverlayPreferences();
      this.playbackProgress$.next({ channelId: undefined, time: 0, duration: 0, percent: 0 });
      this.hasContextualAction = false;
      this.currentContextualAction = null;

      if (this.isFullscreen) {
        this.isFullscreenSubject.next(false);
        document.body.classList.remove('fullscreen-player-active');
        try {
          await invoke('set_main_window_fullscreen', { fullscreen: false });
        } catch {}
      }

      document.body.classList.remove('theater-mode-active');
      document.body.classList.remove('fullscreen-player-active');

      try {
        await invoke('stop_embedded_poc');
      } catch (e) {
        console.warn('stop_embedded_poc error', e);
      }

      this.currentChannel = undefined;
      this.activeFallbackChannel = undefined;
      this.seriesChannel = undefined;
      this.seriesTitle = undefined;
      this.lastPlayerOptions = undefined;
      this.seasons = [];
      this.episodes = [];
      this.onSwitchEpisodeCallback = undefined;
      this.liveChannels = [];
      this.onSwitchChannelCallback = undefined;

      this.isPlayingEmbeddedSubject.next(false);
      this.tmdbEnrichment.setPlaybackActive(false);
      this.restoreScrollPosition();
    } finally {
      this.isStoppingPlayer = false;
      this.hasHandledLiveFailureStop = false;
    }
  }

  public async startPlayer(
    channel: Channel,
    hostElementOrId: HTMLElement | string,
    options?: EmbeddedPlayerOptions,
  ): Promise<void> {
    if (!options?.isReconnect) {
      this.cancelPendingReconnect(true);
      this.hasHandledLiveFailureStop = false;
      if ((options?.mode || this.currentMode) === 'live') {
        this.loadReconnectSettings().catch(console.warn);
      }
    }
    const wasAlreadyPlaying = this.isPlayingEmbedded;
    const resolvedMode: ContentMode =
      options?.mode || (wasAlreadyPlaying ? this.currentMode : 'movie');
    const isLive = this.isLiveContent(channel, resolvedMode);

    let resolvedPlayback: ResolvedPlaybackState | undefined;
    if (
      !isLive &&
      channel?.id &&
      (options?.startTime === undefined || options?.duration === undefined)
    ) {
      resolvedPlayback = await this.resolveAuthoritativeProgress(
        channel.id,
        channel,
        resolvedMode,
      );
    }

    if (channel?.id && !options?.skipHistory && !options?.isReconnect) {
      await this.markLastWatched(channel.id);
    }

    if (wasAlreadyPlaying) {
      this.isRestartingPlayer = true;
      try {
        await invoke('stop_embedded_poc');
      } catch (e) {
        console.warn('stop_embedded_poc error', e);
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    } else {
      this.saveScrollPosition();
      this.hostTarget = hostElementOrId;
      this.isPlayingEmbeddedSubject.next(true);
      this.tmdbEnrichment.setPlaybackActive(true);
      document.body.classList.add('theater-mode-active');
      await this.setupTauriListeners();
    }

    this.currentChannel = channel;
    this.currentMode = resolvedMode;

    // TV episode switcher options
    if (options?.seriesChannel) this.seriesChannel = options.seriesChannel;
    if (options?.seriesTitle) {
      this.seriesTitle = sanitizeShowTitle(options.seriesTitle);
    } else if (this.currentMode === 'episode' && !this.seriesTitle) {
      this.seriesTitle = this.extractSeriesTitle(channel);
    }
    if (options?.seasons) this.seasons = options.seasons;
    if (options?.currentSeasonNum) {
      this.currentSeasonNum = options.currentSeasonNum;
    } else if (this.currentMode === 'episode') {
      this.currentSeasonNum = this.extractSeasonNumber(channel);
    }
    if (options?.currentEpisodeNum) {
      this.currentEpisodeNum = options.currentEpisodeNum;
    } else if (this.currentMode === 'episode') {
      this.currentEpisodeNum = channel.episode_num || this.extractEpisodeNumber(channel.name, 0);
    }
    if (options?.episodes && options.episodes.length > 0) {
      this.episodes = options.episodes;
    } else if (this.currentMode === 'episode') {
      if (this.seasons.length > 0) {
        const targetSeason = this.seasons.find((s) => s.seasonNum === this.currentSeasonNum) || this.seasons[0];
        if (targetSeason) {
          this.loadEpisodesForSeason(targetSeason.id, targetSeason.seasonNum).catch(console.warn);
        }
      } else if (channel.series_id || (channel.url && /^\d+$/.test(channel.url.trim()))) {
        this.loadSeriesAndSeasons(channel, this.currentSeasonNum).catch(console.warn);
      }
    }
    if (options?.onSwitchEpisode) this.onSwitchEpisodeCallback = options.onSwitchEpisode;

    // Live TV channel switcher options
    this.currentGroupId = options?.currentGroupId ?? channel.group_id;
    if (options?.channels && options.channels.length > 0) {
      this.liveChannels = options.channels.map((c: any) => ({
        id: c.id,
        name: cleanMediaTitle(c.name || 'Channel'),
        logo: c.logo || c.image,
        group: c.group,
        group_id: c.group_id || c.channel?.group_id,
        isCurrent: c.id === channel.id,
        channel: c.channel || c,
      }));
    } else if (this.currentMode === 'live' && this.liveChannels.length === 0) {
      this.loadLiveChannels().catch(console.warn);
    } else {
      this.liveChannels = this.liveChannels.map((c) => ({
        ...c,
        isCurrent: c.id === channel.id,
      }));
    }
    if (options?.onSwitchChannel) this.onSwitchChannelCallback = options.onSwitchChannel;
    this.lastPlayerOptions = options;

    const startPos = isLive
      ? 0
      : (options?.startTime ??
          resolvedPlayback?.positionSec ??
          (channel.id ? this.getSavedPosition(channel.id, channel) : 0));

    const savedDuration = isLive
      ? 0
      : (options?.duration ??
          resolvedPlayback?.durationSec ??
          (channel.id ? this.getSavedDuration(channel.id, channel) : 0));

    const displayTitle = options?.title || cleanMediaTitle(channel.name);
    const playChannel: Channel = {
      ...channel,
      name: displayTitle,
    };

    emit('embedded-player-mode', { mode: this.currentMode, channelId: channel.id }).catch(console.warn);

    try {
      // Wait a frame so layout/bounding rect computes
      await new Promise((resolve) => requestAnimationFrame(resolve));

      let el = this.getHostElement();
      if (!el) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        el = this.getHostElement();
      }

      const dpr = window.devicePixelRatio || 1;
      let x = 0;
      let y = 0;
      let width = Math.round(window.innerWidth * dpr);
      let height = Math.round(window.innerHeight * dpr);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          x = Math.round(rect.x * dpr);
          y = Math.round(rect.y * dpr);
          width = Math.round(rect.width * dpr);
          height = Math.round(rect.height * dpr);
        }
      }

      await invoke('start_embedded_player', {
        channel: playChannel,
        x,
        y,
        width,
        height,
        zOrder: 'top',
        skipHistory: !!(options?.skipHistory || options?.isReconnect),
      });

      const stableMediaKey = this.computeStableMediaKey(playChannel, options);
      emit('embedded-player-started', {
        name: displayTitle,
        channel_id: channel.id,
        channelId: channel.id,
        startTime: startPos,
        duration: savedDuration,
        mode: this.currentMode,
        stableMediaKey: stableMediaKey,
      }).catch(console.warn);
      emit('embedded-player-mode', { mode: this.currentMode, channelId: channel.id }).catch(console.warn);
      emit('overlay-top-crop', { crop: 32 }).catch(console.warn);
      this.appPreferences.emitOverlayPreferences();

      // Safe fallback seek only if overlay hasn't already resumed after file-loaded
      if (startPos > 5 && this.currentMode !== 'live') {
        setTimeout(() => {
          if (this.isPlayingEmbedded && this.currentMode !== 'live' && !this.playbackProgress$.value?.time) {
            invoke('send_embedded_poc_ipc', {
              command: JSON.stringify({ command: ['seek', startPos, 'absolute'] }),
            }).catch(console.warn);
          }
        }, 1500);
      }

      if (this.currentMode === 'episode') {
        this.emitEpisodesData();
      } else if (this.currentMode === 'live') {
        this.emitChannelsData();
      } else if (this.currentMode === 'movie') {
        this.emitMovieRecommendations(playChannel).catch(console.warn);
      }

      this.emitPlaybackSegments(playChannel, options).catch(console.warn);

      if (!wasAlreadyPlaying) {
        this.attachKeyHandler();
        this.setupVideoResizeObserver();
      }
      setTimeout(() => this.syncBounds(), 50);
      setTimeout(() => this.syncBounds(), 150);
    } catch (err) {
      console.error('start_embedded_player failed:', err);
      if (!wasAlreadyPlaying) {
        await this.stopPlayer();
      }
      throw err;
    } finally {
      if (wasAlreadyPlaying) {
        setTimeout(() => {
          this.isRestartingPlayer = false;
        }, 200);
      }
    }
  }

  public findEpisodeIndexInList(
    episodes: SwitcherEpisodeData[],
    targetChannel?: Channel,
    targetEpNum?: number,
    targetSeasonNum?: number
  ): number {
    if (!episodes || episodes.length === 0) return -1;
    const targetId = targetChannel?.id;

    // 1. Exact ID match (loose and strict string/number comparison)
    if (targetId != null) {
      const idx = episodes.findIndex(
        (e) => (e.id != null && (e.id === targetId || String(e.id) === String(targetId))) ||
               (e.channel?.id != null && (e.channel.id === targetId || String(e.channel.id) === String(targetId)))
      );
      if (idx !== -1) return idx;
    }

    // 2. Explicit episode number match ONLY if targetEpNum is a known valid positive number
    const epNum = (targetEpNum != null && targetEpNum > 0)
      ? targetEpNum
      : (targetChannel?.episode_num != null && targetChannel.episode_num > 0)
        ? targetChannel.episode_num
        : this.extractEpisodeNumber(targetChannel?.name, 0);

    if (epNum > 0) {
      const sNum = (targetSeasonNum != null && targetSeasonNum > 0)
        ? targetSeasonNum
        : this.extractSeasonNumber(targetChannel);

      const idx = episodes.findIndex((e) => {
        const itemEpNum = e.episodeNum ?? e.channel?.episode_num ?? this.extractEpisodeNumber(e.channel?.name, 0);
        if (itemEpNum !== epNum) return false;
        if (sNum > 0 && e.seasonNum != null && e.seasonNum > 0 && e.seasonNum !== sNum) return false;
        return true;
      });
      if (idx !== -1) return idx;
    }

    return -1;
  }

  public async emitEpisodesData(): Promise<void> {
    let nextEp: any = null;
    if (this.currentChannel && this.currentChannel.id != null) {
      try {
        const channelId = this.currentChannel.id;
        const seriesKey = this.getSeriesKey(this.currentChannel);

        // 1. Check if next episode is immediately available in active season episodes list
        if (this.episodes && this.episodes.length > 0) {
          const curEpNum = (this.currentEpisodeNum != null && this.currentEpisodeNum > 0)
            ? this.currentEpisodeNum
            : (this.currentChannel.episode_num != null && this.currentChannel.episode_num > 0)
              ? this.currentChannel.episode_num
              : this.extractEpisodeNumber(this.currentChannel.name, 0);
          const curIdx = this.findEpisodeIndexInList(
            this.episodes,
            this.currentChannel,
            curEpNum,
            this.currentSeasonNum
          );
          if (curIdx !== -1 && curIdx + 1 < this.episodes.length) {
            const nextItem = this.episodes[curIdx + 1];
            if (nextItem && nextItem.channel) {
              const epNum = nextItem.episodeNum ?? this.extractEpisodeNumber(nextItem.channel.name, curIdx + 2);
              const sNum = nextItem.seasonNum ?? this.extractSeasonNumber(nextItem.channel);
              const cleanShow = sanitizeShowTitle(this.seriesTitle || this.extractSeriesTitle(nextItem.channel));
              const cleanEpTitle = nextItem.title || sanitizeEpisodeTitle(nextItem.channel.name, cleanShow, epNum, sNum);

              nextEp = {
                id: nextItem.id,
                title: cleanEpTitle || `Episode ${epNum}`,
                rawTitle: nextItem.channel.name,
                episodeNum: epNum,
                seasonNum: sNum,
                seriesTitle: cleanShow,
                stillUrl: nextItem.stillUrl || nextItem.channel.image,
                posterUrl: this.seriesChannel?.image || this.currentChannel?.image,
                channel: nextItem.channel,
              };
            }
          }
        }

        // 2. If not found in current season list (e.g. season finale or cross-season), resolve via watch_history / database / cache
        if (!nextEp) {
          let found: Channel | null | undefined;
          try {
            const dbNext = await this.invokeIpc<Channel | null>(
              'get_next_episode_from_history',
              { channelId },
            );
            if (dbNext?.id != null) {
              found = dbNext;
            }
          } catch {}
          if (found === undefined) {
            found = this.getPersistedNextEpisode(seriesKey, channelId);
          }
          if (found === undefined || (found === null && this.seasons.length > 1)) {
            found = await this.findNextEpisode(this.currentChannel);
            if (seriesKey) {
              this.setPersistedNextEpisode(seriesKey, channelId, found);
            }
          }
          if (found) {
            const epNum = found.episode_num ?? this.extractEpisodeNumber(found.name, 0) ?? 1;
            const sNum = (found as any).seasonNum || (found.season_id != null
              ? (this.seasons.find((s) => s.id === found.season_id)?.seasonNum || this.extractSeasonNumber(found))
              : this.extractSeasonNumber(found));
            (found as any).seasonNum = sNum;
            if (found.episode_num == null) (found as any).episode_num = epNum;
            const cleanShow = sanitizeShowTitle(this.seriesTitle || this.extractSeriesTitle(found));
            const cleanEpTitle = sanitizeEpisodeTitle(found.name, cleanShow, epNum, sNum);
            const refSeries = this.seriesChannel || this.currentChannel;
            let stillUrl = found.image;
            const cachedEnrichment = refSeries ? this.tmdbEnrichment.getEnrichmentSync(refSeries) : undefined;
            const tmdbId = cachedEnrichment?.tmdbId;
            if (!stillUrl && tmdbId && sNum > 0 && epNum > 0) {
              stillUrl = this.tmdbEnrichment.getEpisodeStillSync(tmdbId, sNum, epNum);
            }
            const posterUrl = this.seriesChannel?.image || this.currentChannel?.image;

            nextEp = {
              id: found.id!,
              title: cleanEpTitle || `Episode ${epNum}`,
              rawTitle: found.name,
              episodeNum: epNum,
              seasonNum: sNum,
              seriesTitle: cleanShow,
              stillUrl: stillUrl || found.image,
              posterUrl: posterUrl,
              channel: found,
            };

            // If stillUrl is missing, try async fetch from TMDB without blocking
            if (!nextEp.stillUrl && tmdbId && sNum > 0 && epNum > 0) {
              this.tmdbEnrichment.getEpisodeStill(tmdbId, sNum, epNum).then((asyncStill) => {
                if (asyncStill && nextEp && nextEp.id === found!.id) {
                  nextEp.stillUrl = asyncStill;
                  emit('embedded-player-episodes-data', {
                    seriesTitle: sanitizeShowTitle(this.seriesTitle),
                    seriesPoster: this.seriesChannel?.image || this.currentChannel?.image,
                    seasons: this.seasons,
                    currentSeasonNum: this.currentSeasonNum,
                    currentEpisodeId: this.currentChannel?.id,
                    episodes: this.episodes.map((e) => ({
                      ...e,
                      isCurrent: e.id === this.currentChannel?.id,
                    })),
                    nextEpisode: nextEp,
                  }).catch(console.warn);
                }
              }).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.warn('Failed to resolve next episode in emitEpisodesData:', err);
      }
    }

    emit('embedded-player-episodes-data', {
      seriesTitle: sanitizeShowTitle(this.seriesTitle),
      seriesPoster: this.seriesChannel?.image || this.currentChannel?.image,
      seasons: this.seasons,
      currentSeasonNum: this.currentSeasonNum,
      currentEpisodeId: this.currentChannel?.id,
      episodes: this.episodes.map((e) => ({
        ...e,
        isCurrent: e.id === this.currentChannel?.id,
      })),
      nextEpisode: nextEp,
    }).catch(console.warn);
  }

  public async emitPlaybackSegments(channel?: Channel, options?: EmbeddedPlayerOptions): Promise<void> {
    const opts = options || this.lastPlayerOptions;
    const target = channel || this.currentChannel || this.activeFallbackChannel;
    if (!target || !target.id || this.currentMode === 'live') {
      emit('embedded-player-segments-data', { channelId: target?.id, segments: [] }).catch(console.warn);
      return;
    }

    if (opts?.mode) {
      this.currentMode = opts.mode;
    }
    const isMovie = this.currentMode === 'movie' || opts?.mode === 'movie';
    const seasonNum = opts?.currentSeasonNum || this.currentSeasonNum;
    const episodeNum = opts?.currentEpisodeNum || this.currentEpisodeNum || this.extractEpisodeNumber(target.name);
    const seriesRef = opts?.seriesChannel || this.seriesChannel;
    const seriesTitle = opts?.seriesTitle || this.seriesTitle;
    const duration = opts?.duration || (target.id ? this.getSavedDuration(target.id, target) : undefined);

    const resolveOpts: ResolveSegmentOptions = {
      isMovie,
      seasonNum,
      episodeNum,
      seriesChannel: seriesRef,
      seriesTitle,
      duration: duration && duration > 60 ? Math.round(duration) : undefined,
    };

    // 1. Immediately emit memory-cached segments if available
    const syncSegments = this.playbackSegmentService.getSegmentsSync(target, resolveOpts);

    if (syncSegments && syncSegments.length > 0) {
      emit('embedded-player-segments-data', {
        channelId: target.id,
        segments: syncSegments,
      }).catch(console.warn);
    }

    // 2. Fetch asynchronously in background without blocking playback
    try {
      const segments = await this.playbackSegmentService.getSegments(target, resolveOpts);
      const activeId = this.currentChannel?.id || this.activeFallbackChannel?.id;

      if (activeId === target.id) {
        emit('embedded-player-segments-data', {
          channelId: target.id,
          segments: segments || [],
        }).catch(console.warn);
      }
    } catch (err) {
      console.warn('Failed to emit playback segments:', err);
    }
  }

  public async emitMovieRecommendations(movieChannel?: Channel): Promise<void> {
    const target = movieChannel || this.currentChannel;
    if (!target) return;
    try {
      const recs = await this.getMovieRecommendations(target);
      emit('embedded-player-movie-recommendations', {
        channelId: target.id,
        recommendations: recs,
      }).catch(console.warn);
    } catch (e) {
      console.warn('Failed to emit movie recommendations:', e);
    }
  }

  public async getMovieRecommendations(movieChannel: Channel): Promise<any[]> {
    try {
      const currentId = movieChannel.id;
      const recs: Channel[] = [];
      const seenIds = new Set<number>();
      if (currentId) seenIds.add(currentId);

      // 1. Check HomeDiscoveryStateService.getAllRecommended()
      const allRecs = this.homeDiscoveryState.getAllRecommended();
      for (const c of allRecs) {
        if (
          c.id &&
          !seenIds.has(c.id) &&
          c.season_id == null &&
          c.series_id == null &&
          c.media_type !== MediaType.serie &&
          c.media_type !== MediaType.livestream
        ) {
          seenIds.add(c.id);
          recs.push(c);
          if (recs.length >= 6) break;
        }
      }

      // 2. Check cached TMDB rows in HomeDiscoveryStateService
      if (recs.length < 6) {
        const rows = this.homeDiscoveryState.getCachedTmdbRows();
        for (const row of rows) {
          if (
            row.id === 'row-recommended' ||
            row.id === 'row-popular-movies' ||
            row.id === 'row-trending-movies'
          ) {
            for (const c of row.items) {
              if (
                c.id &&
                !seenIds.has(c.id) &&
                c.season_id == null &&
                c.series_id == null &&
                c.media_type !== MediaType.serie
              ) {
                seenIds.add(c.id);
                recs.push(c);
                if (recs.length >= 6) break;
              }
            }
          }
          if (recs.length >= 6) break;
        }
      }

      // 3. Fallback: Search provider catalog for movies in the same group or general movies
      if (recs.length < 4) {
        const sourceIds = movieChannel.source_id
          ? [movieChannel.source_id]
          : Array.from(this.memory.Sources.keys());
        if (sourceIds.length > 0) {
          const results = (await invoke('search', {
            filters: {
              source_ids: sourceIds,
              group_id: movieChannel.group_id,
              media_types: [MediaType.movie],
              view_type: ViewMode.All,
              use_keywords: false,
              page: 1,
              sort: SortType.alphabeticalAscending,
            },
          })) as Channel[];
          for (const c of results || []) {
            if (c.id && !seenIds.has(c.id)) {
              seenIds.add(c.id);
              recs.push(c);
              if (recs.length >= 6) break;
            }
          }
        }
      }

      return recs.slice(0, 6).map((c) => ({
        id: c.id!,
        title: cleanMediaTitle(c.name || 'Movie'),
        poster: c.image || (c as any).poster || '',
        channel: c,
      }));
    } catch (e) {
      console.warn('Failed to load movie recommendations:', e);
      return [];
    }
  }

  public emitChannelsData(): void {
    const sourceIds = Array.from(this.memory.Sources.keys());
    emit('embedded-player-channels-data', {
      currentChannelId: this.currentChannel?.id,
      currentGroupId: this.currentGroupId ?? this.currentChannel?.group_id,
      currentChannel: this.currentChannel,
      sourceIds: sourceIds,
      channels: this.liveChannels.map((c) => ({
        ...c,
        isCurrent: c.id === this.currentChannel?.id,
      })),
    }).catch(console.warn);
  }

  public async switchChannel(
    channel: Channel,
    title?: string,
    options?: SwitchChannelOptions,
  ): Promise<void> {
    if (!channel || channel.id == null) return;
    const isReconnect = !!options?.isReconnect;
    if (!isReconnect) {
      this.cancelPendingReconnect(true);
      this.hasHandledLiveFailureStop = false;
    }
    this.currentChannel = channel;
    if (!isReconnect) {
      await this.markLastWatched(channel.id);
    }
    if (channel.group_id != null) {
      this.currentGroupId = channel.group_id;
    }
    const channelTitle = title || cleanMediaTitle(channel.name || 'Live TV');
    const playChannel = { ...channel, name: channelTitle };

    if (!isReconnect && this.onSwitchChannelCallback) {
      try {
        await this.onSwitchChannelCallback(playChannel);
      } catch (e) {
        console.warn('onSwitchChannelCallback error:', e);
      }
    }

    try {
      await invoke('switch_embedded_channel', { channel: playChannel });
    } catch (err) {
      console.warn('switch_embedded_channel error, falling back to startPlayer:', err);
      await this.startPlayer(playChannel, this.hostTarget || this.resolveVideoCanvasId(), {
        mode: 'live',
        title: channelTitle,
        currentGroupId: this.currentGroupId ?? channel.group_id,
        skipHistory: true,
        isReconnect,
      });
    }

    this.emitChannelsData();
  }

  public async loadEpisodesForSeason(seasonId: number, seasonNum: number): Promise<void> {
    const seriesChannel = this.seriesChannel || this.currentChannel;
    if (!seriesChannel) return;
    try {
      const seriesId =
        seriesChannel.series_id ||
        (seriesChannel.url && /^\d+$/.test(seriesChannel.url.trim())
          ? parseInt(seriesChannel.url.trim(), 10)
          : seriesChannel.id);
      const sourceIds = seriesChannel.source_id
        ? [seriesChannel.source_id]
        : Array.from(this.memory.Sources.keys());

      const filters = {
        source_ids: sourceIds,
        series_id: seriesId,
        season: seasonId,
        media_types: [MediaType.movie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };

      const episodeChannels = (await invoke('search', { filters })) as Channel[];
      if (episodeChannels && episodeChannels.length > 0) {
        const epIds = episodeChannels.map((c) => c.id).filter((id): id is number => id != null);
        const dbByChId = new Map<number, WatchProgressRecord>();
        if (epIds.length > 0) {
          try {
            const batch = await this.invokeIpc<WatchProgressRecord[]>(
              'get_watch_progress_batch',
              { channelIds: epIds },
            );
            if (Array.isArray(batch) && batch.length > 0) {
              this.seedCachedProgressRecords(batch);
              for (const rec of batch) {
                if (rec.channel_id != null) {
                  dbByChId.set(rec.channel_id, rec);
                }
              }
            }
          } catch {}
        }

        this.currentSeasonNum = seasonNum;
        this.episodes = episodeChannels.map((ch, idx) => {
          const epNum = ch.episode_num ?? (idx + 1);
          const dbRec = ch.id != null ? dbByChId.get(ch.id) : undefined;
          const isWatchedFromDb = Boolean(
            dbRec &&
              (dbRec.completed ||
                dbRec.position_sec > 0 ||
                dbRec.progress_percent > 0 ||
                dbRec.last_watched > 0),
          );
          return {
            id: ch.id!,
            channel: ch,
            episodeNum: epNum,
            seasonNum: seasonNum,
            title: sanitizeEpisodeTitle(ch.name, this.seriesTitle, epNum, seasonNum) || `Episode ${epNum}`,
            stillUrl: ch.image,
            isWatched: isWatchedFromDb || (ch as any).last_watched != null,
            isCurrent: ch.id === this.currentChannel?.id,
          };
        });
        this.emitEpisodesData();
      } else if (this.episodes.length > 0) {
        this.emitEpisodesData();
      }
    } catch (e) {
      console.warn('Failed to load episodes for season in embedded player:', e);
    }
  }

  public computeStableMediaKey(channel?: Channel, options?: any): string {
    if (!channel) return '';
    if (this.currentMode === 'movie' || channel.media_type === MediaType.movie) {
      const raw = options?.title || channel.name || '';
      const clean = cleanMediaTitle(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const year = extractYear(raw) || '';
      return `movie_${clean}${year ? '_' + year : ''}`;
    }
    if (this.currentMode === 'episode' || channel.season_id != null || channel.episode_num != null) {
      const sTitle = options?.seriesTitle || this.seriesTitle || this.extractSeriesTitle(channel) || '';
      const clean = cleanMediaTitle(sTitle).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      const sNum = options?.currentSeasonNum || this.currentSeasonNum || this.extractSeasonNumber(channel);
      const eNum = channel.episode_num ?? this.extractEpisodeNumber(channel.name);
      return `episode_${clean}_s${sNum}_e${eNum}`;
    }
    return `channel_${channel.id}`;
  }

  public extractSeasonNumber(channel?: Channel): number {
    if (!channel) return 1;
    const rawName = channel.name || '';
    const chAny = channel as any;

    // Check if seasons list is already loaded in embedded player
    if (channel.season_id != null && this.seasons && this.seasons.length > 0) {
      const foundSeason = this.seasons.find((s) => s.id === channel.season_id);
      if (foundSeason && foundSeason.seasonNum > 0) {
        return foundSeason.seasonNum;
      }
    }

    // Extract from title (e.g. S01E05, Season 1, Series 1, 1x05)
    const sMatch =
      rawName.match(/\b(?:s|season\s*|series\s*)(\d{1,2})[\s._-]*(?:e|ep|episode|\b)/i) ||
      rawName.match(/\b(\d{1,2})x\d{1,2}\b/i) ||
      rawName.match(/\b(?:season|series)\s*(\d{1,2})\b/i);
    if (sMatch) {
      const parsed = parseInt(sMatch[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }

    // Metadata fallback, validating it isn't an internal SQLite relational season_id
    if (chAny.seasonNum != null && chAny.seasonNum > 0 && chAny.seasonNum !== channel.season_id) {
      return Number(chAny.seasonNum);
    }
    if (chAny.season_number != null && chAny.season_number > 0 && chAny.season_number !== channel.season_id) {
      return Number(chAny.season_number);
    }
    if (chAny.season != null && typeof chAny.season === 'number' && chAny.season > 0 && chAny.season !== channel.season_id) {
      return chAny.season;
    }

    return 1;
  }

  public extractEpisodeNumber(name?: string, fallback: number = 1): number {
    if (!name) return fallback;
    const match =
      name.match(/\b(?:e|ep|episode)[\s._-]*(\d{1,3})\b/i) ||
      name.match(/\b\d{1,2}x(\d{1,3})\b/i);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return fallback;
  }

  public extractSeriesTitle(channel?: Channel): string {
    if (!channel || !channel.name) return '';
    if (this.seriesTitle) return sanitizeShowTitle(this.seriesTitle);
    if (this.seriesChannel?.name) return sanitizeShowTitle(this.seriesChannel.name);
    const name = channel.name;
    const match = name.match(/^(.*?)(?:[\s._-]+(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|season\s*\d+|ep(?:isode)?\s*\d+))/i);
    if (match && match[1].trim()) {
      return sanitizeShowTitle(match[1].trim());
    }
    return sanitizeShowTitle(name);
  }

  public async loadSeriesAndSeasons(channel: Channel, targetSeasonNum: number): Promise<void> {
    try {
      const seriesId = channel.series_id || (channel.url && /^\d+$/.test(channel.url.trim()) ? parseInt(channel.url.trim(), 10) : undefined);
      if (!seriesId) return;

      if (!this.seriesTitle || !this.seriesChannel) {
        if (!this.seriesTitle) {
          this.seriesTitle = this.extractSeriesTitle(channel);
        }
        try {
          const sourceIds = channel.source_id
            ? [channel.source_id]
            : Array.from(this.memory.Sources.keys());
          const seriesList = (await invoke('search', {
            filters: {
              source_ids: sourceIds,
              series_id: undefined,
              media_types: [MediaType.serie],
              view_type: ViewMode.All,
              use_keywords: false,
              query: String(seriesId),
              page: 1,
              sort: SortType.alphabeticalAscending,
            },
          })) as Channel[];
          const matchedSeries = seriesList.find((s) => s.url === String(seriesId) || s.id === seriesId);
          if (matchedSeries) {
            this.seriesChannel = matchedSeries;
            this.seriesTitle = sanitizeShowTitle(matchedSeries.name || '') || this.seriesTitle;
          }
        } catch {}
      }

      const sourceIds = channel.source_id
        ? [channel.source_id]
        : Array.from(this.memory.Sources.keys());
      const filters = {
        source_ids: sourceIds,
        series_id: seriesId,
        media_types: [MediaType.serie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };
      const seasonChannels = (await invoke('search', { filters })) as Channel[];
      if (seasonChannels && seasonChannels.length > 0) {
        this.seasons = seasonChannels.map((s, idx) => {
          const sMatch = s.name?.match(/(\d+)/);
          return {
            id: s.id!,
            seasonNum: sMatch ? parseInt(sMatch[1], 10) : idx + 1,
            name: s.name || `Season ${idx + 1}`,
          };
        });
        const targetSeason = this.seasons.find((s) => s.seasonNum === targetSeasonNum) || this.seasons[0];
        if (targetSeason) {
          await this.loadEpisodesForSeason(targetSeason.id, targetSeason.seasonNum);
        }
      }
    } catch (e) {
      console.warn('Failed to load series and seasons in embedded player:', e);
    }
  }

  public async loadLiveChannels(): Promise<void> {
    try {
      const sourceIds = Array.from(this.memory.Sources.keys());
      const filters = {
        source_ids: sourceIds,
        media_types: [MediaType.livestream],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.provider,
      };
      const channels = (await invoke('search', { filters })) as Channel[];
      this.liveChannels = (channels || [])
        .filter((c) => (c.media_type === MediaType.livestream || c.media_type == null) && c.id != null)
        .map((c) => ({
          id: c.id!,
          name: cleanMediaTitle(c.name || 'Live Channel'),
          logo: c.image,
          isCurrent: c.id === this.currentChannel?.id,
          channel: c,
        }));

      this.emitChannelsData();
    } catch (e) {
      console.warn('Failed to load live channels in embedded player:', e);
    }
  }

  private isLiveContent(channel?: Channel, modeHint?: ContentMode): boolean {
    if (modeHint) return modeHint === 'live';
    return channel?.media_type === MediaType.livestream;
  }

  private isEpisodeChannel(channel?: Channel, modeHint?: ContentMode): boolean {
    if (modeHint === 'episode') return true;
    if (modeHint === 'movie' && !channel) return false;
    return Boolean(
      channel &&
        (channel.season_id != null ||
          channel.series_id != null ||
          channel.episode_num != null ||
          (channel as any).media_type === MediaType.serie ||
          this.extractSeasonNumber(channel) > 0),
    );
  }

  private computeSafeResumeState(
    rawPos: number,
    rawDur: number,
    rawPct: number | undefined,
    rawCompleted: boolean | undefined,
    isEpisode: boolean,
  ): { positionSec: number; durationSec: number; completed: boolean } {
    const pos = Number.isFinite(rawPos) && rawPos > 0 ? rawPos : 0;
    const dur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0;
    const thresholdPct = isEpisode ? 90 : 95;
    const thresholdRatio = isEpisode ? 0.9 : 0.95;

    const computedPct =
      rawPct != null && Number.isFinite(rawPct) && rawPct >= 0
        ? Math.min(100, rawPct)
        : dur > 0
          ? Math.min(100, (pos / dur) * 100)
          : 0;

    const completed =
      rawCompleted === true ||
      computedPct >= thresholdPct ||
      (dur > 0 && ((dur > 30 && pos >= dur - 30) || pos / dur >= thresholdRatio));

    let positionSec = 0;
    if (!completed && pos > 5 && !(dur > 0 && pos >= dur)) {
      positionSec = Math.round(pos);
    }

    return {
      positionSec,
      durationSec: dur > 0 ? Math.round(dur) : 0,
      completed,
    };
  }

  private parseLegacyUpdatedAtSec(raw: unknown): number | undefined {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
  }

  private readLegacyProgressForChannel(
    id: number,
    channel?: Channel,
    modeHint?: ContentMode,
  ): {
    pos: number;
    dur: number;
    pct?: number;
    completed: boolean;
    updatedAtSec?: number;
  } | null {
    if (!id || id <= 0 || this.isLiveContent(channel, modeHint)) return null;
    if (typeof localStorage === 'undefined') return null;

    let pos = 0;
    let dur = 0;
    let pct: number | undefined;
    let completed = false;
    let updatedAtSec: number | undefined;
    let found = false;

    const storeRaw = localStorage.getItem('fred_tv_watch_progress');
    if (storeRaw) {
      const store = JSON.parse(storeRaw);
      if (store && typeof store === 'object' && store[id] != null) {
        const entry = store[id];
        if (typeof entry === 'number') {
          if (Number.isFinite(entry) && entry > 0) {
            pos = entry;
            found = true;
          }
        } else if (entry && typeof entry === 'object') {
          const t = Number(entry.time);
          const d = Number(entry.duration);
          const p = Number(entry.percent);
          if (Number.isFinite(t) && t > 0) {
            pos = t;
            found = true;
          }
          if (Number.isFinite(d) && d > 0) {
            dur = d;
            found = true;
          }
          if (Number.isFinite(p) && p >= 0) {
            pct = p;
            found = true;
          }
          if (entry.completed === true) {
            completed = true;
            found = true;
          }
          updatedAtSec = this.parseLegacyUpdatedAtSec(entry.updatedAt);
        }
      }
    }

    const pctRaw = localStorage.getItem(`watch_progress_${id}`);
    if (pctRaw != null) {
      const parsedPct = parseFloat(pctRaw);
      if (Number.isFinite(parsedPct) && parsedPct >= 0) {
        pct = pct != null ? Math.max(pct, parsedPct) : parsedPct;
        found = true;
      }
    }

    const durRaw = localStorage.getItem(`playback_dur_${id}`);
    if (durRaw != null) {
      const parsedDur = parseFloat(durRaw);
      if (Number.isFinite(parsedDur) && parsedDur > 0) {
        dur = Math.max(dur, parsedDur);
        found = true;
      }
    }

    const posRaw = localStorage.getItem(`playback_pos_${id}`);
    if (posRaw != null) {
      const parsedPos = parseFloat(posRaw);
      if (Number.isFinite(parsedPos) && parsedPos > 0) {
        pos = Math.max(pos, parsedPos);
        found = true;
      }
    }

    const chAny = (channel || (this.currentChannel?.id === id ? this.currentChannel : undefined)) as any;
    if (chAny?.duration && Number.isFinite(Number(chAny.duration)) && Number(chAny.duration) > 0 && dur <= 0) {
      dur = Number(chAny.duration);
      found = true;
    }
    if (chAny?.progress && Number.isFinite(Number(chAny.progress)) && Number(chAny.progress) > 0 && pos <= 0) {
      pos = Number(chAny.progress);
      found = true;
    }

    if (!found) return null;
    if (dur > 0 && pos > dur * 1.05) {
      // Guard against stale position from unrelated content with a much shorter duration
      return null;
    }
    return { pos, dur, pct, completed, updatedAtSec };
  }

  public async resolveAuthoritativeProgress(
    channelId?: number,
    channel?: Channel,
    modeHint?: ContentMode,
  ): Promise<ResolvedPlaybackState> {
    const id = channelId || channel?.id;
    const targetChannel = channel || (id && this.currentChannel?.id === id ? this.currentChannel : undefined);
    const effectiveMode = modeHint ?? (this.currentChannel?.id === id ? this.currentMode : undefined);

    if (!id || id <= 0 || this.isLiveContent(targetChannel, effectiveMode)) {
      return { positionSec: 0, durationSec: 0, completed: false, source: 'none' };
    }

    if (this.legacyMigrationPromise) {
      try {
        await this.legacyMigrationPromise;
      } catch {}
    }

    const isEpisode = this.isEpisodeChannel(targetChannel, effectiveMode);
    const chDuration = Number((targetChannel as any)?.duration);

    let dbRecord: WatchProgressRecord | null | undefined;
    let dbLookupSucceeded = false;
    try {
      dbRecord = await this.invokeIpc<WatchProgressRecord | null>('get_watch_progress', {
        channelId: id,
      });
      dbLookupSucceeded = true;
    } catch (err) {
      if (!this.dbProgressErrorLogged.has(id)) {
        this.dbProgressErrorLogged.add(id);
        console.warn('get_watch_progress failed, using fallback:', err);
      }
    }

    const hasMeaningfulDbProgress =
      dbRecord != null &&
      (dbRecord.completed ||
        dbRecord.position_sec > 0 ||
        dbRecord.duration_sec > 0 ||
        dbRecord.progress_percent > 0);

    if (dbRecord && hasMeaningfulDbProgress) {
      this.authoritativeProgressCache.set(id, dbRecord);
      const effectiveDur =
        dbRecord.duration_sec > 0
          ? dbRecord.duration_sec
          : Number.isFinite(chDuration) && chDuration > 0
            ? chDuration
            : 0;
      const state = this.computeSafeResumeState(
        dbRecord.position_sec,
        effectiveDur,
        dbRecord.progress_percent,
        dbRecord.completed,
        isEpisode,
      );
      return { ...state, source: 'watch_history' };
    }

    try {
      const legacy = this.readLegacyProgressForChannel(id, targetChannel, effectiveMode);
      if (legacy) {
        const state = this.computeSafeResumeState(
          legacy.pos,
          legacy.dur,
          legacy.pct,
          legacy.completed,
          isEpisode,
        );
        if (dbLookupSucceeded && (legacy.pos > 5 || legacy.dur > 0 || state.completed)) {
          const tmdbId = targetChannel
            ? this.tmdbEnrichment.getEnrichmentSync(targetChannel)?.tmdbId
            : undefined;
          const pctToSync =
            legacy.pct != null
              ? legacy.pct
              : legacy.dur > 0
                ? Math.min(100, Math.round((legacy.pos / legacy.dur) * 100))
                : 0;
          const updatedAt = legacy.updatedAtSec ?? Math.floor(Date.now() / 1000);
          void this.invokeIpc('upsert_watch_progress', {
            payload: {
              channel_id: id,
              position_sec: legacy.pos,
              duration_sec: legacy.dur,
              progress_percent: pctToSync,
              completed: state.completed,
              tmdb_id: tmdbId ?? null,
              updated_at: legacy.updatedAtSec ?? null,
            },
          }).catch(() => {});
          this.authoritativeProgressCache.set(id, {
            identity_key: dbRecord?.identity_key ?? '',
            channel_id: id,
            position_sec: legacy.pos,
            duration_sec: legacy.dur,
            progress_percent: pctToSync,
            completed: state.completed,
            updated_at: updatedAt,
            last_watched: Math.floor(Date.now() / 1000),
            tmdb_id: tmdbId ?? null,
          });
        }
        return { ...state, source: 'legacy' };
      }
    } catch (e) {
      console.warn('Error reading legacy fallback progress:', e);
    }

    if (dbRecord) {
      this.authoritativeProgressCache.set(id, dbRecord);
    }

    return {
      positionSec: 0,
      durationSec: Number.isFinite(chDuration) && chDuration > 0 ? Math.round(chDuration) : 0,
      completed: false,
      source: dbRecord ? 'watch_history' : 'none',
    };
  }

  public getSavedPosition(channelId?: number, channel?: Channel): number {
    if (!channelId && !channel?.id) return 0;
    const id = channelId || channel?.id;
    if (!id) return 0;
    try {
      const targetChannel = channel || (this.currentChannel?.id === id ? this.currentChannel : undefined);
      const effectiveMode = this.currentChannel?.id === id ? this.currentMode : undefined;
      if (this.isLiveContent(targetChannel, effectiveMode)) return 0;

      const isEpisode = this.isEpisodeChannel(targetChannel, effectiveMode);
      const cached = this.authoritativeProgressCache.get(id);
      if (
        cached &&
        (cached.completed ||
          cached.position_sec > 0 ||
          cached.duration_sec > 0 ||
          cached.progress_percent > 0)
      ) {
        const chDuration = Number((targetChannel as any)?.duration);
        const effDur =
          cached.duration_sec > 0
            ? cached.duration_sec
            : Number.isFinite(chDuration) && chDuration > 0
              ? chDuration
              : 0;
        return this.computeSafeResumeState(
          cached.position_sec,
          effDur,
          cached.progress_percent,
          cached.completed,
          isEpisode,
        ).positionSec;
      }

      const legacy = this.readLegacyProgressForChannel(id, targetChannel, effectiveMode);
      if (!legacy) return 0;
      return this.computeSafeResumeState(
        legacy.pos,
        legacy.dur,
        legacy.pct,
        legacy.completed,
        isEpisode,
      ).positionSec;
    } catch (e) {
      console.warn('Error reading saved position:', e);
    }
    return 0;
  }

  public getSavedDuration(channelId?: number, channel?: Channel): number {
    if (!channelId && !channel?.id) return 0;
    const id = channelId || channel?.id;
    if (!id) return 0;
    try {
      const targetChannel = channel || (this.currentChannel?.id === id ? this.currentChannel : undefined);
      const effectiveMode = this.currentChannel?.id === id ? this.currentMode : undefined;
      if (this.isLiveContent(targetChannel, effectiveMode)) return 0;

      const cached = this.authoritativeProgressCache.get(id);
      if (cached && cached.duration_sec > 0) {
        return Math.round(cached.duration_sec);
      }

      const legacy = this.readLegacyProgressForChannel(id, targetChannel, effectiveMode);
      if (legacy && legacy.dur > 0) {
        return Math.round(legacy.dur);
      }
    } catch (e) {
      console.warn('Error reading saved duration:', e);
    }
    return 0;
  }

  public getCachedProgressRecord(channelId?: number): WatchProgressRecord | undefined {
    if (!channelId) return undefined;
    return this.authoritativeProgressCache.get(channelId);
  }

  public seedCachedProgressRecords(records: WatchProgressRecord[]): void {
    if (!Array.isArray(records)) return;
    for (const rec of records) {
      if (!rec?.channel_id) continue;
      const existing = this.authoritativeProgressCache.get(rec.channel_id);
      if (!existing || rec.updated_at >= existing.updated_at) {
        this.authoritativeProgressCache.set(rec.channel_id, rec);
      }
    }
  }

  public clearWatchHistoryCaches(channelIds?: number[]): void {
    if (channelIds && channelIds.length > 0) {
      for (const id of channelIds) {
        this.authoritativeProgressCache.delete(id);
        this.lastDbProgressSync.delete(id);
      }
    } else {
      this.authoritativeProgressCache.clear();
      this.lastDbProgressSync.clear();
    }
    clearLegacyWatchProgressStorage(channelIds);
  }

  public isEpisodeCompleted(channelOrId?: Channel | number, channel?: Channel): boolean {
    if (!channelOrId && !channel) return false;
    const id = typeof channelOrId === 'number' ? channelOrId : (channelOrId?.id || channel?.id);
    if (!id) return false;
    const targetChannel = typeof channelOrId === 'object' ? channelOrId : channel;

    const chAny = targetChannel as any;
    if (chAny?.completed === true) return true;
    if (chAny?.progress_percent != null && chAny.progress_percent >= 90) return true;
    if (chAny?.duration > 0 && chAny?.progress != null) {
      if (chAny.progress >= chAny.duration - 30 || (chAny.progress / chAny.duration) >= 0.90) return true;
    }

    try {
      const storeRaw = localStorage.getItem('fred_tv_watch_progress');
      if (storeRaw) {
        const store = JSON.parse(storeRaw);
        if (store && store[id]) {
          const entry = store[id];
          if (entry.completed === true) return true;
          const t = typeof entry === 'number' ? entry : (entry.time || 0);
          const dur = entry.duration || 0;
          const pct = entry.percent != null ? entry.percent : (dur > 0 ? (t / dur) * 100 : 0);
          if (pct >= 90) return true;
          if (dur > 30 && t >= dur - 30) return true;
          if (dur > 0 && (t / dur) >= 0.90) return true;
        }
      }
      const pctRaw = localStorage.getItem(`watch_progress_${id}`);
      if (pctRaw) {
        const pct = parseFloat(pctRaw);
        if (!isNaN(pct) && pct >= 90) return true;
      }
      const posRaw = localStorage.getItem(`playback_pos_${id}`);
      const durRaw = localStorage.getItem(`playback_dur_${id}`);
      if (posRaw && durRaw) {
        const pos = parseFloat(posRaw);
        const dur = parseFloat(durRaw);
        if (dur > 30 && pos >= dur - 30) return true;
        if (dur > 0 && (pos / dur) >= 0.90) return true;
      }
    } catch {}
    return false;
  }

  public isMovieCompleted(channelOrId?: Channel | number, channel?: Channel, alternateIds?: number[]): boolean {
    if (!channelOrId && !channel && (!alternateIds || alternateIds.length === 0)) return false;
    const primaryId = typeof channelOrId === 'number' ? channelOrId : (channelOrId?.id || channel?.id);
    const targetChannel = typeof channelOrId === 'object' ? channelOrId : channel;

    const chAny = targetChannel as any;
    if (chAny?.completed === true) return true;
    if (chAny?.progress_percent != null && chAny.progress_percent >= 95) return true;
    if (chAny?.duration > 0 && chAny?.progress != null) {
      if (chAny.progress >= chAny.duration - 30 || (chAny.progress / chAny.duration) >= 0.95) return true;
    }

    try {
      const idsToCheck: number[] = [];
      if (primaryId != null) idsToCheck.push(primaryId);
      if (Array.isArray(alternateIds)) {
        for (const aid of alternateIds) {
          if (aid != null && !idsToCheck.includes(aid)) idsToCheck.push(aid);
        }
      }

      const storeRaw = localStorage.getItem('fred_tv_watch_progress');
      let store: Record<string, any> | null = null;
      if (storeRaw) {
        try {
          store = JSON.parse(storeRaw);
        } catch {
          store = null;
        }
      }

      // If primaryId has active unfinished progress (0 < pct < 95 and not completed),
      // the user actively started watching this movie, so it should not be considered completed.
      if (primaryId != null && store && store[primaryId]) {
        const primaryEntry = store[primaryId];
        if (primaryEntry.completed === true) return true;
        const pt = typeof primaryEntry === 'number' ? primaryEntry : (primaryEntry.time || 0);
        const pdur = primaryEntry.duration || 0;
        const ppct = primaryEntry.percent != null ? primaryEntry.percent : (pdur > 0 ? (pt / pdur) * 100 : 0);
        if (ppct >= 95 || (pdur > 30 && pt >= pdur - 30) || (pdur > 0 && (pt / pdur) >= 0.95)) {
          return true;
        }
        if (ppct > 0 && ppct < 95 && primaryEntry.completed === false) {
          return false;
        }
      }

      for (const id of idsToCheck) {
        if (store && store[id]) {
          const entry = store[id];
          if (entry.completed === true) return true;
          const t = typeof entry === 'number' ? entry : (entry.time || 0);
          const dur = entry.duration || 0;
          const pct = entry.percent != null ? entry.percent : (dur > 0 ? (t / dur) * 100 : 0);
          if (pct >= 95) return true;
          if (dur > 30 && t >= dur - 30) return true;
          if (dur > 0 && (t / dur) >= 0.95) return true;
        }
        const pctRaw = localStorage.getItem(`watch_progress_${id}`);
        if (pctRaw) {
          const pct = parseFloat(pctRaw);
          if (!isNaN(pct) && pct >= 95) return true;
        }
        const posRaw = localStorage.getItem(`playback_pos_${id}`);
        const durRaw = localStorage.getItem(`playback_dur_${id}`);
        if (posRaw && durRaw) {
          const pos = parseFloat(posRaw);
          const dur = parseFloat(durRaw);
          if (dur > 30 && pos >= dur - 30) return true;
          if (dur > 0 && (pos / dur) >= 0.95) return true;
        }
      }
    } catch {}
    return false;
  }

  public getSeriesKey(channel?: Channel): string {
    if (!channel) return '';
    if (channel.series_id != null) return `sid_${channel.source_id}_${channel.series_id}`;
    const sTitle = this.extractSeriesTitle(channel);
    if (sTitle) return `title_${channel.source_id}_${sTitle.toLowerCase()}`;
    return `cid_${channel.id}`;
  }

  public getPersistedNextEpisode(seriesKey: string, fromEpisodeId?: number): Channel | null | undefined {
    if (!seriesKey) return undefined;
    try {
      const raw = localStorage.getItem(`fred_tv_series_next_ep_${seriesKey}`);
      if (!raw) return undefined;
      const data = JSON.parse(raw);
      if (!data) return undefined;
      if (fromEpisodeId == null || data.fromEpisodeId == null || String(data.fromEpisodeId) !== String(fromEpisodeId)) {
        return undefined;
      }
      if (data.nextEpisode) {
        const ep = data.nextEpisode as any;
        const realSeason = this.extractSeasonNumber(ep);
        let modified = false;
        if (realSeason > 0) {
          if (ep.seasonNum === ep.season_id || (ep.seasonNum != null && ep.seasonNum !== realSeason)) {
            ep.seasonNum = realSeason;
            modified = true;
          }
          if (ep.season === ep.season_id) {
            delete ep.season;
            modified = true;
          }
        }
        if (modified) {
          try {
            localStorage.setItem(`fred_tv_series_next_ep_${seriesKey}`, JSON.stringify(data));
          } catch {}
        }
        // Safety check: if cached nextEpisode is in the same season but has episode_num <= current episode, it's stale poisoned cache!
        const nextEpNum = ep.episode_num ?? this.extractEpisodeNumber(ep.name, 0);
        const nextSNum = ep.seasonNum ?? this.extractSeasonNumber(ep);
        if (this.currentSeasonNum != null && nextSNum === this.currentSeasonNum && this.currentEpisodeNum != null && nextEpNum > 0 && nextEpNum <= this.currentEpisodeNum) {
          return undefined;
        }
      }
      return data.nextEpisode;
    } catch {
      return undefined;
    }
  }

  public setPersistedNextEpisode(seriesKey: string, fromEpisodeId: number, nextEpisode: Channel | null): void {
    if (!seriesKey) return;
    try {
      let sanitizedNext = nextEpisode;
      if (sanitizedNext) {
        const ep = { ...sanitizedNext } as any;
        const sNum = this.extractSeasonNumber(sanitizedNext);
        if (sNum > 0) {
          ep.seasonNum = sNum;
        }
        if (ep.season === ep.season_id) {
          delete ep.season;
        }
        sanitizedNext = ep;
      }
      localStorage.setItem(
        `fred_tv_series_next_ep_${seriesKey}`,
        JSON.stringify({
          nextEpisode: sanitizedNext,
          fromEpisodeId,
          completed: !sanitizedNext,
          updatedAt: Date.now(),
        })
      );
    } catch {}
  }

  public clearPersistedNextEpisode(seriesKey: string): void {
    if (!seriesKey) return;
    try {
      localStorage.removeItem(`fred_tv_series_next_ep_${seriesKey}`);
    } catch {}
  }

  public async findNextEpisode(channel: Channel): Promise<Channel | null> {
    if (!channel) return null;
    try {
      const sourceId = channel.source_id ?? this.seriesChannel?.source_id;
      const sourceIds = sourceId != null ? [sourceId] : Array.from(this.memory.Sources.keys());
      if (sourceIds.length === 0) return null;

      const refSeries = this.seriesChannel;
      let seriesId =
        channel.series_id ||
        refSeries?.series_id ||
        (refSeries?.url && /^\d+$/.test(refSeries.url.trim()) ? parseInt(refSeries.url.trim(), 10) : undefined) ||
        refSeries?.id;

      if (!seriesId) {
        const sTitle = this.extractSeriesTitle(channel);
        if (sTitle) {
          const seriesList = (await invoke('search', {
            filters: {
              source_ids: sourceIds,
              view_type: ViewMode.All,
              media_types: [MediaType.serie],
              query: sTitle,
              use_keywords: false,
              page: 1,
              sort: SortType.alphabeticalAscending,
            },
          })) as Channel[];
          if (seriesList && seriesList.length > 0) {
            const found = seriesList.find((s) => s.url === String(seriesId) || s.id === seriesId) || seriesList[0];
            if (found) {
              seriesId = found.series_id || (found.url && /^\d+$/.test(found.url.trim()) ? parseInt(found.url.trim(), 10) : found.id);
            }
          }
        }
      }

      // 1. Resolve seasons: reuse in-memory seasons if available, or fetch from DB
      let seasons: Array<{ id: number; seasonNum: number; name: string }> = [];
      if (this.seasons && this.seasons.length > 0) {
        seasons = this.seasons.map((s, idx) => {
          const sMatch = s.name?.match(/(\d+)/);
          return {
            id: s.id,
            seasonNum: s.seasonNum ?? (sMatch ? parseInt(sMatch[1], 10) : idx + 1),
            name: s.name || `Season ${idx + 1}`,
          };
        });
      } else if (seriesId) {
        const seasonFilters = {
          source_ids: sourceIds,
          series_id: seriesId,
          media_types: [MediaType.serie],
          view_type: ViewMode.All,
          use_keywords: false,
          page: 1,
          sort: SortType.alphabeticalAscending,
        };
        const seasonChannels = (await invoke('search', { filters: seasonFilters })) as Channel[];
        if (seasonChannels && seasonChannels.length > 0) {
          seasons = seasonChannels.map((s, idx) => {
            const sMatch = s.name?.match(/(\d+)/);
            return {
              id: s.id!,
              seasonNum: sMatch ? parseInt(sMatch[1], 10) : idx + 1,
              name: s.name || `Season ${idx + 1}`,
            };
          });
        }
      }

      if (seasons.length === 0) return null;
      seasons.sort((a, b) => a.seasonNum - b.seasonNum);

      // Determine current season
      let currentSeasonIdx = -1;
      if (channel.season_id != null) {
        currentSeasonIdx = seasons.findIndex((s) => s.id === channel.season_id);
      }
      if (currentSeasonIdx === -1 && this.currentSeasonNum != null) {
        currentSeasonIdx = seasons.findIndex((s) => s.seasonNum === this.currentSeasonNum);
      }
      if (currentSeasonIdx === -1) {
        const sNum = this.extractSeasonNumber(channel);
        currentSeasonIdx = seasons.findIndex((s) => s.seasonNum === sNum);
      }
      if (currentSeasonIdx === -1) {
        currentSeasonIdx = 0;
      }

      const currentSeason = seasons[currentSeasonIdx];
      const isCurrentTarget = this.currentChannel?.id != null && (channel.id === this.currentChannel.id || String(channel.id) === String(this.currentChannel.id));
      const currentEpNum =
        (isCurrentTarget && this.currentEpisodeNum != null && this.currentEpisodeNum > 0)
          ? this.currentEpisodeNum
          : (channel.episode_num != null && channel.episode_num > 0)
            ? channel.episode_num
            : this.extractEpisodeNumber(channel.name, 0);

      // 2. Fetch episodes for current season ordered by episode_num ASC
      // Check in-memory this.episodes first if active
      if (this.episodes && this.episodes.length > 0 &&
          (this.currentSeasonNum === currentSeason.seasonNum || channel.season_id == null || this.episodes.some((e) => e.channel?.season_id === currentSeason.id))) {
        const curIdx = this.findEpisodeIndexInList(this.episodes, channel, currentEpNum, currentSeason.seasonNum);
        if (curIdx !== -1 && curIdx + 1 < this.episodes.length) {
          const nextEpItem = this.episodes[curIdx + 1];
          if (nextEpItem && nextEpItem.channel) {
            const ep = { ...nextEpItem.channel } as any;
            ep.seasonNum = currentSeason.seasonNum;
            ep.episode_num = nextEpItem.episodeNum ?? ep.episode_num;
            if (!ep.season_id) ep.season_id = currentSeason.id;
            return ep as Channel;
          }
        }
      }

      if (seriesId) {
        const epFilters = {
          source_ids: sourceIds,
          series_id: seriesId,
          season: currentSeason.id,
          media_types: [MediaType.movie],
          view_type: ViewMode.All,
          use_keywords: false,
          page: 1,
          sort: SortType.alphabeticalAscending,
        };
        const curEpisodes = (await invoke('search', { filters: epFilters })) as Channel[];

        if (curEpisodes && curEpisodes.length > 0) {
          curEpisodes.sort((a, b) => {
            const aNum = a.episode_num ?? this.extractEpisodeNumber(a.name, 0);
            const bNum = b.episode_num ?? this.extractEpisodeNumber(b.name, 0);
            return aNum - bNum;
          });

          // Find index of current episode
          let curIdx = curEpisodes.findIndex((e) => (e.id != null && (e.id === channel.id || String(e.id) === String(channel.id))));
          if (curIdx === -1 && currentEpNum > 0) {
            curIdx = curEpisodes.findIndex((e) => (e.episode_num != null && e.episode_num === currentEpNum) || (this.extractEpisodeNumber(e.name, 0) === currentEpNum));
          }

          if (curIdx !== -1 && curIdx + 1 < curEpisodes.length) {
            const foundEp = { ...curEpisodes[curIdx + 1] } as any;
            foundEp.seasonNum = currentSeason.seasonNum;
            if (!foundEp.season_id) foundEp.season_id = currentSeason.id;
            return foundEp as Channel;
          } else if (curIdx === -1 && currentEpNum > 0) {
            const nextInSeason = curEpisodes.find(
              (e) => (e.episode_num != null && e.episode_num > currentEpNum) || (this.extractEpisodeNumber(e.name, 0) > currentEpNum)
            );
            if (nextInSeason) {
              const foundEp = { ...nextInSeason } as any;
              foundEp.seasonNum = currentSeason.seasonNum;
              if (!foundEp.season_id) foundEp.season_id = currentSeason.id;
              return foundEp as Channel;
            }
          }
        }
      }

      // 3. Current episode is the last episode of the season: transition to next available season!
      let nextSeasonIdx = currentSeasonIdx + 1;
      while (nextSeasonIdx < seasons.length) {
        const nextSeason = seasons[nextSeasonIdx];
        if (seriesId) {
          const nextSeasonEpFilters = {
            source_ids: sourceIds,
            series_id: seriesId,
            season: nextSeason.id,
            media_types: [MediaType.movie],
            view_type: ViewMode.All,
            use_keywords: false,
            page: 1,
            sort: SortType.alphabeticalAscending,
          };
          const nextSeasonEpisodes = (await invoke('search', { filters: nextSeasonEpFilters })) as Channel[];
          if (nextSeasonEpisodes && nextSeasonEpisodes.length > 0) {
            nextSeasonEpisodes.sort((a, b) => {
              const aNum = a.episode_num ?? this.extractEpisodeNumber(a.name, 0);
              const bNum = b.episode_num ?? this.extractEpisodeNumber(b.name, 0);
              return aNum - bNum;
            });
            const firstEpOfNextSeason = { ...nextSeasonEpisodes[0] } as any;
            firstEpOfNextSeason.seasonNum = nextSeason.seasonNum;
            if (!firstEpOfNextSeason.season_id) {
              firstEpOfNextSeason.season_id = nextSeason.id;
            }
            return firstEpOfNextSeason as Channel;
          }
        }
        nextSeasonIdx++;
      }

      // No next episode available (end of series)
      return null;
    } catch (e) {
      console.warn('findNextEpisode error:', e);
      return null;
    }
  }

  public async resolveAndPersistNextEpisode(channelId: number, channel?: Channel): Promise<Channel | null> {
    try {
      let targetChannel = channel || (this.currentChannel?.id === channelId ? this.currentChannel : undefined);
      if (!targetChannel) {
        const results = (await invoke('search', {
          filters: {
            source_ids: Array.from(this.memory.Sources.keys()),
            view_type: ViewMode.All,
            media_types: [MediaType.movie],
            page: 1,
            sort: SortType.alphabeticalAscending,
            use_keywords: false,
          },
        })) as Channel[];
        targetChannel = results?.find((c) => c.id === channelId);
      }
      if (!targetChannel) return null;

      const nextEp = await this.findNextEpisode(targetChannel);
      const seriesKey = this.getSeriesKey(targetChannel);
      if (seriesKey) {
        this.setPersistedNextEpisode(seriesKey, channelId, nextEp);
      }
      if (nextEp?.id) {
        const nextSeasonNum =
          (nextEp as any).seasonNum ?? this.extractSeasonNumber(nextEp);
        const nextEpisodeNum =
          nextEp.episode_num ?? this.extractEpisodeNumber(nextEp.name, 0);
        const cached = this.authoritativeProgressCache.get(channelId);
        const savedPos = cached?.position_sec || 0;
        const savedDur = cached?.duration_sec || this.getSavedDuration(channelId, targetChannel);
        const tmdbId = this.tmdbEnrichment.getEnrichmentSync(targetChannel)?.tmdbId;
        void this.invokeIpc('upsert_watch_progress', {
          payload: {
            channel_id: channelId,
            position_sec: savedPos,
            duration_sec: savedDur,
            completed: true,
            tmdb_id: tmdbId ?? null,
            next_ep_channel_id: nextEp.id,
            next_ep_stream_id: nextEp.stream_id ?? null,
            next_ep_season_number: nextSeasonNum > 0 ? nextSeasonNum : null,
            next_ep_episode_number: nextEpisodeNum > 0 ? nextEpisodeNum : null,
          },
        }).catch(() => {});
      }
      return nextEp;
    } catch (err) {
      console.warn('resolveAndPersistNextEpisode error:', err);
      return null;
    }
  }

  public saveWatchProgress(channelId: number, time: number, duration: number, forceCompleted?: boolean): void {
    if (!channelId || time <= 0) return;
    if (this.currentMode === 'live') return;
    if (this.currentChannel?.id === channelId && this.currentChannel.media_type === MediaType.livestream) {
      return;
    }
    try {
      if (duration <= 0) {
        const cachedDur = this.authoritativeProgressCache.get(channelId)?.duration_sec || 0;
        const prevDur = localStorage.getItem(`playback_dur_${channelId}`);
        duration = cachedDur > 0 ? cachedDur : (prevDur ? parseFloat(prevDur) || 0 : 0);
      }
      const isEpisode = this.currentMode === 'episode' || (
        this.currentChannel?.id === channelId && (
          this.currentChannel.season_id != null ||
          this.currentChannel.series_id != null ||
          this.currentChannel.episode_num != null ||
          (this.currentChannel as any).media_type === MediaType.serie ||
          this.extractSeasonNumber(this.currentChannel) > 0
        )
      );
      const completionThreshold = isEpisode ? 90 : 95;
      const pct = duration > 0 ? Math.min(100, Math.max(0, Math.round((time / duration) * 100))) : 0;
      const isCompleted = forceCompleted === true || (
        duration > 0 && (pct >= completionThreshold || (duration > 30 && time >= duration - 30))
      );

      localStorage.setItem(`playback_pos_${channelId}`, isCompleted ? '0' : String(time));
      if (duration > 0) {
        localStorage.setItem(`playback_dur_${channelId}`, String(duration));
        localStorage.setItem(`watch_progress_${channelId}`, String(isCompleted ? 100 : pct));
      }

      let store: Record<string, any> = {};
      const storeRaw = localStorage.getItem('fred_tv_watch_progress');
      if (storeRaw) {
        try {
          store = JSON.parse(storeRaw) || {};
        } catch {
          store = {};
        }
      }
      const finalTime = isCompleted ? (duration || time) : time;
      const finalDuration = duration > 0 ? duration : (store[channelId]?.duration || 0);
      const finalPercent = isCompleted ? 100 : (pct > 0 ? pct : (store[channelId]?.percent || 0));

      store[channelId] = {
        time: finalTime,
        duration: finalDuration,
        percent: finalPercent,
        completed: isCompleted,
        updatedAt: Date.now(),
      };
      localStorage.setItem('fred_tv_watch_progress', JSON.stringify(store));
      this.playbackProgress$.next({
        channelId,
        time: finalTime,
        duration: finalDuration,
        percent: finalPercent,
      });

      this.syncProgressToWatchHistory(
        channelId,
        finalTime,
        finalDuration,
        finalPercent,
        isCompleted,
      );

      const prevCached = this.authoritativeProgressCache.get(channelId);
      const nowSec = Math.floor(Date.now() / 1000);
      this.authoritativeProgressCache.set(channelId, {
        identity_key: prevCached?.identity_key ?? '',
        channel_id: channelId,
        position_sec: finalTime,
        duration_sec: finalDuration,
        progress_percent: isCompleted ? 100 : Math.max(finalPercent, prevCached?.completed ? 100 : 0),
        completed: Boolean(prevCached?.completed || isCompleted),
        updated_at: nowSec,
        last_watched: Math.max(prevCached?.last_watched ?? 0, nowSec),
        tmdb_id: prevCached?.tmdb_id ?? null,
      });

      if (isCompleted) {
        if (isEpisode) {
          const epChannel = (this.currentChannel?.id === channelId) ? this.currentChannel : undefined;
          this.resolveAndPersistNextEpisode(channelId, epChannel).catch(console.warn);
        }
        this.lastWatchedUpdated$.next(channelId);
      } else if (isEpisode && this.currentChannel?.id === channelId) {
        const seriesKey = this.getSeriesKey(this.currentChannel);
        if (seriesKey) {
          this.clearPersistedNextEpisode(seriesKey);
        }
      }
    } catch (e) {
      console.warn('Failed to save watch progress:', e);
    }
  }

  private syncProgressToWatchHistory(
    channelId: number,
    time: number,
    duration: number,
    percent: number,
    completed: boolean,
  ): void {
    if (this.currentMode === 'live') return;
    if (this.currentChannel?.id === channelId && this.currentChannel.media_type === MediaType.livestream) {
      return;
    }

    const now = Date.now();
    const prev = this.lastDbProgressSync.get(channelId);
    if (prev) {
      const completionJustTriggered = completed && !prev.completed;
      const deltaTime = Math.abs(time - prev.time);
      const deltaDur = Math.abs(duration - prev.duration);
      const elapsed = now - prev.syncedAt;
      if (
        !completionJustTriggered &&
        deltaTime < 10 &&
        deltaDur < 5 &&
        !(elapsed >= 15000 && deltaTime >= 2)
      ) {
        return;
      }
    }

    this.lastDbProgressSync.set(channelId, {
      time,
      duration,
      completed,
      syncedAt: now,
    });

    const targetCh = this.currentChannel?.id === channelId ? this.currentChannel : undefined;
    const tmdbId = targetCh
      ? this.tmdbEnrichment.getEnrichmentSync(targetCh)?.tmdbId
      : undefined;

    void this.invokeIpc('upsert_watch_progress', {
      payload: {
        channel_id: channelId,
        position_sec: Number.isFinite(time) && time >= 0 ? time : 0,
        duration_sec: Number.isFinite(duration) && duration > 0 ? duration : 0,
        progress_percent: Number.isFinite(percent) ? percent : 0,
        completed,
        tmdb_id: tmdbId ?? null,
      },
    }).catch((err) => {
      if (!this.dbProgressErrorLogged.has(channelId)) {
        this.dbProgressErrorLogged.add(channelId);
        console.warn('watch_history dual-write failed:', err);
      }
    });
  }

  public scheduleLegacyWatchHistoryMigration(): void {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem('lh_watch_history_migrated_v1') === '1') return;
    if (this.legacyMigrationTimer || this.legacyMigrationPromise) return;

    this.legacyMigrationTimer = setTimeout(() => {
      this.legacyMigrationTimer = null;
      void this.runLegacyWatchHistoryMigrationIfNeeded();
    }, 1500);
  }

  public async runLegacyWatchHistoryMigrationIfNeeded(): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    if (localStorage.getItem('lh_watch_history_migrated_v1') === '1') return;
    if (this.legacyMigrationPromise) return this.legacyMigrationPromise;

    this.legacyMigrationPromise = (async () => {
      try {
        const entries = this.collectLegacyWatchProgressEntries();
        if (entries.length > 0) {
          await invoke<number>('migrate_legacy_watch_progress', { entries });
        }
        localStorage.setItem('lh_watch_history_migrated_v1', '1');
      } catch (err) {
        console.warn('Legacy watch_history migration deferred (will retry):', err);
      } finally {
        this.legacyMigrationPromise = null;
      }
    })();

    return this.legacyMigrationPromise;
  }

  public collectLegacyWatchProgressEntries(): Array<{
    channel_id: number;
    position_sec: number;
    duration_sec: number;
    progress_percent?: number;
    completed?: boolean;
    tmdb_id?: number;
    updated_at?: number;
    next_ep_channel_id?: number;
    next_ep_stream_id?: number;
    next_ep_season_number?: number;
    next_ep_episode_number?: number;
    fallback_name?: string;
    fallback_series_id?: number;
    fallback_is_episode?: boolean;
  }> {
    const byId = new Map<
      number,
      {
        channel_id: number;
        position_sec: number;
        duration_sec: number;
        progress_percent?: number;
        completed?: boolean;
        tmdb_id?: number;
        updated_at?: number;
        next_ep_channel_id?: number;
        next_ep_stream_id?: number;
        next_ep_season_number?: number;
        next_ep_episode_number?: number;
        fallback_name?: string;
        fallback_series_id?: number;
        fallback_is_episode?: boolean;
      }
    >();

    const toUnixSec = (raw: unknown): number | undefined => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return undefined;
      return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
    };

    const getOrCreate = (id: number) => {
      let existing = byId.get(id);
      if (!existing) {
        existing = { channel_id: id, position_sec: 0, duration_sec: 0 };
        byId.set(id, existing);
      }
      return existing;
    };

    // 1. fred_tv_watch_progress
    try {
      const raw = localStorage.getItem('fred_tv_watch_progress');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, val] of Object.entries(parsed)) {
            const id = Number(k);
            if (!Number.isInteger(id) || id <= 0) continue;
            if (typeof val === 'number') {
              if (Number.isFinite(val) && val > 0) {
                const entry = getOrCreate(id);
                entry.position_sec = Math.max(entry.position_sec, val);
              }
            } else if (val && typeof val === 'object') {
              const obj = val as any;
              const t = Number(obj.time);
              const d = Number(obj.duration);
              const p = Number(obj.percent);
              const entry = getOrCreate(id);
              if (Number.isFinite(t) && t > 0) entry.position_sec = Math.max(entry.position_sec, t);
              if (Number.isFinite(d) && d > 0) entry.duration_sec = Math.max(entry.duration_sec, d);
              if (Number.isFinite(p) && p > 0) {
                entry.progress_percent = Math.max(entry.progress_percent || 0, Math.min(100, p));
              }
              if (obj.completed === true) entry.completed = true;
              const ts = toUnixSec(obj.updatedAt);
              if (ts) entry.updated_at = Math.max(entry.updated_at || 0, ts);
            }
          }
        }
      }
    } catch {}

    // 2. Individual playback_pos_*, playback_dur_*, watch_progress_*, and fred_tv_series_next_ep_*
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) keys.push(key);
      }

      for (const key of keys) {
        if (key.startsWith('playback_pos_')) {
          const id = Number(key.slice('playback_pos_'.length));
          const pos = Number(localStorage.getItem(key));
          if (Number.isInteger(id) && id > 0 && Number.isFinite(pos) && pos > 0) {
            const entry = getOrCreate(id);
            entry.position_sec = Math.max(entry.position_sec, pos);
          }
        } else if (key.startsWith('playback_dur_')) {
          const id = Number(key.slice('playback_dur_'.length));
          const dur = Number(localStorage.getItem(key));
          if (Number.isInteger(id) && id > 0 && Number.isFinite(dur) && dur > 0) {
            const entry = getOrCreate(id);
            entry.duration_sec = Math.max(entry.duration_sec, dur);
          }
        } else if (key.startsWith('watch_progress_')) {
          const id = Number(key.slice('watch_progress_'.length));
          const pct = Number(localStorage.getItem(key));
          if (Number.isInteger(id) && id > 0 && Number.isFinite(pct) && pct > 0) {
            const entry = getOrCreate(id);
            entry.progress_percent = Math.max(entry.progress_percent || 0, Math.min(100, pct));
            if (pct >= 95) entry.completed = true;
          }
        } else if (key.startsWith('fred_tv_series_next_ep_')) {
          try {
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const data = JSON.parse(raw);
            const fromId = Number(data?.fromEpisodeId);
            if (!Number.isInteger(fromId) || fromId <= 0) continue;

            const entry = getOrCreate(fromId);
            entry.fallback_is_episode = true;
            if (data?.completed === true) entry.completed = true;
            const ts = toUnixSec(data?.updatedAt);
            if (ts) entry.updated_at = Math.max(entry.updated_at || 0, ts);

            const nextEp = data?.nextEpisode as any;
            if (nextEp && typeof nextEp === 'object') {
              const nextId = Number(nextEp.id);
              if (Number.isInteger(nextId) && nextId > 0) entry.next_ep_channel_id = nextId;
              const nextStreamId = Number(nextEp.stream_id);
              if (Number.isInteger(nextStreamId) && nextStreamId > 0) {
                entry.next_ep_stream_id = nextStreamId;
              }
              const sNum = nextEp.seasonNum ?? this.extractSeasonNumber(nextEp);
              if (Number.isInteger(sNum) && sNum > 0) entry.next_ep_season_number = sNum;
              const eNum = nextEp.episode_num ?? this.extractEpisodeNumber(nextEp.name, 0);
              if (Number.isInteger(eNum) && eNum > 0) entry.next_ep_episode_number = eNum;
              if (nextEp.series_id != null) {
                const serId = Number(nextEp.series_id);
                if (Number.isInteger(serId) && serId > 0) entry.fallback_series_id = serId;
              }
            }
          } catch {}
        }
      }
    } catch {}

    // Attach cached TMDB IDs where available and filter out empty entries
    const result = [];
    for (const entry of byId.values()) {
      const hasProgress =
        entry.position_sec > 0 ||
        (entry.progress_percent || 0) > 0 ||
        entry.completed === true ||
        entry.next_ep_channel_id != null;
      if (!hasProgress) continue;

      const tmdbId = this.tmdbEnrichment.getEnrichmentSync({ id: entry.channel_id } as Channel)?.tmdbId;
      if (tmdbId) entry.tmdb_id = tmdbId;
      result.push(entry);
    }

    return result;
  }

  public resolveVideoCanvasId(preferredCanvasId?: string): string {
    if (preferredCanvasId) return preferredCanvasId;
    const url = this.router.url || '';
    if (url.includes('movie-detail')) return 'movie-video-canvas';
    if (url.includes('tv-detail')) return 'tv-video-canvas';
    if (url.includes('profile')) return 'profile-video-canvas';
    return 'home-video-canvas';
  }

  public async playMediaDirectly(channel: Channel, hostCanvasId?: string): Promise<void> {
    if (!channel) return;

    // Handle group / season folder navigation
    if (channel.media_type === MediaType.group || channel.media_type === MediaType.season) {
      this.memory.SetNode.next({
        id: channel.id!,
        name: channel.name!,
        type: fromMediaType(channel.media_type),
        sourceId: channel.source_id,
      });
      return;
    }

    const canvas = this.resolveVideoCanvasId(hostCanvasId);

    // 1. Live TV / livestream
    if (channel.media_type === MediaType.livestream) {
      await this.startPlayer(channel, canvas, {
        title: cleanMediaTitle(channel.name || 'Live TV'),
        mode: 'live',
      });
      return;
    }

    // 2. Individual TV Episode
    const isEpisode = !!(
      channel.season_id != null ||
      channel.episode_num != null ||
      (channel.series_id != null && channel.media_type !== MediaType.serie) ||
      (/\b(?:s\d{1,2}\s*e\d{1,2}|season\s*\d+|\b\d{1,2}x\d{1,2}\b)/i.test(channel.name || '') &&
        channel.media_type !== MediaType.serie)
    );

    if (isEpisode) {
      await this.playEpisodeDirectly(channel, canvas);
      return;
    }

    // 3. TV Show (MediaType.serie)
    if (channel.media_type === MediaType.serie) {
      await this.playSeriesDirectly(channel, canvas);
      return;
    }

    // 4. Movie (MediaType.movie or default)
    await this.playMovieDirectly(channel, canvas);
  }

  private async playMovieDirectly(channel: Channel, canvas: string): Promise<void> {
    let playChannel = this.getImmediatePlaybackChannel(channel);

    // Version discovery searches the full local catalog and can take several
    // seconds. Only wait for it when the card did not include a playable
    // source; otherwise start the selected/default source immediately.
    if (!this.hasPlayableStream(playChannel)) {
      playChannel = await this.resolvePlayableVersion(channel, 'movie');
    }

    if (!playChannel.url || !playChannel.source_id) {
      try {
        const results = (await invoke('search', {
          filters: {
            source_ids: playChannel.source_id ? [playChannel.source_id] : Array.from(this.memory.Sources.keys()),
            view_type: ViewMode.All,
            media_types: [MediaType.movie],
            query: playChannel.name,
            page: 1,
            sort: SortType.provider,
            use_keywords: false,
          },
        })) as Channel[];
        const fresh = results?.find((c) => c.id === playChannel.id);
        if (fresh) {
          playChannel = { ...fresh, media_type: MediaType.movie, favorite: !!fresh.favorite };
        }
      } catch (err) {
        console.warn('Failed to query fresh channel record for movie:', err);
      }
    }

    if (!this.hasPlayableStream(playChannel)) {
      throw new Error('No playable movie source is available.');
    }

    await this.startPlayer(playChannel, canvas, {
      title: cleanMediaTitle(channel.name || playChannel.name),
      mode: 'movie',
    });
  }

  private getImmediatePlaybackChannel(channel: Channel): Channel {
    const cachedVersions = this.versionMatching.getCachedVersions(channel);
    if (cachedVersions?.length) {
      const preferred = this.getEnglishPreferredVersion(channel, cachedVersions);
      if (preferred?.channel) {
        return { ...preferred.channel, favorite: !!channel.favorite };
      }
    }

    const savedPreferred = this.versionMatching.getStoredPreferredChannel(channel);
    if (savedPreferred && this.versionMatching.isEnglishVersion(savedPreferred)) {
      return savedPreferred;
    }

    return { ...channel, favorite: !!channel.favorite };
  }

  private async resolvePlayableVersion(
    channel: Channel,
    mediaLabel: 'movie' | 'series',
  ): Promise<Channel> {
    try {
      const versions = await this.versionMatching.findVersions(channel);
      const preferred = this.getEnglishPreferredVersion(channel, versions);
      if (preferred?.channel) {
        this.versionMatching.savePreferredVersion(channel, preferred);
        return { ...preferred.channel, favorite: !!channel.favorite };
      }
    } catch (e) {
      console.warn(`Failed to resolve a playable ${mediaLabel} version:`, e);
    }

    return { ...channel, favorite: !!channel.favorite };
  }

  private getEnglishPreferredVersion(
    channel: Channel,
    versions: MediaVersion[],
  ): MediaVersion | undefined {
    const savedPreferred = this.versionMatching.getPreferredVersion(channel, versions);
    const isManual = this.versionMatching.isUserSelectedVersion(channel);
    if (savedPreferred && (isManual || this.versionMatching.isEnglishVersion(savedPreferred))) {
      return savedPreferred;
    }

    return (
      this.versionMatching.getDefaultVersion(versions, channel) ||
      savedPreferred
    );
  }

  private hasPlayableStream(channel: Channel): boolean {
    return !!channel?.url && channel.source_id != null;
  }

  private async playSeriesDirectly(channel: Channel, canvas: string): Promise<void> {
    const seriesChannel = this.getImmediatePlaybackChannel(channel);

    const seriesId =
      seriesChannel.series_id ||
      (seriesChannel.url && /^\d+$/.test(seriesChannel.url.trim())
        ? parseInt(seriesChannel.url.trim(), 10)
        : seriesChannel.id);

    if (!seriesId) {
      this.tvDetailService.openTvDetail(seriesChannel);
      return;
    }

    if (!this.memory.SeriesRefreshed.has(seriesChannel.id!)) {
      try {
        await invoke('get_episodes', { channel: seriesChannel });
        this.memory.SeriesRefreshed.set(seriesChannel.id!, true);
      } catch (e) {
        console.warn('Failed to get_episodes for series:', e);
      }
    }

    const sourceIds = seriesChannel.source_id
      ? [seriesChannel.source_id]
      : Array.from(this.memory.Sources.keys());

    const filters: Filters = {
      source_ids: sourceIds,
      series_id: seriesId,
      media_types: [MediaType.serie],
      view_type: ViewMode.All,
      use_keywords: false,
      page: 1,
      sort: SortType.alphabeticalAscending,
    };

    let seasonChannels = (await invoke('search', { filters })) as Channel[];
    if ((!seasonChannels || seasonChannels.length === 0) && !this.memory.SeriesRefreshed.has(seriesChannel.id!)) {
      try {
        await invoke('get_episodes', { channel: seriesChannel });
        this.memory.SeriesRefreshed.set(seriesChannel.id!, true);
        seasonChannels = (await invoke('search', { filters })) as Channel[];
      } catch {}
    }

    if (!seasonChannels || seasonChannels.length === 0) {
      this.tvDetailService.openTvDetail(seriesChannel);
      return;
    }

    // Check watch history for this series
    let lastWatchedEp: Channel | undefined;
    const seriesDbById = new Map<number, any>();
    try {
      const seriesProgress = (await this.invokeIpc<any[]>(
        'get_series_watch_progress',
        {
          sourceIds,
          seriesId,
          seriesName: sanitizeShowTitle(seriesChannel.name || ''),
        },
      )) || [];
      for (const entry of seriesProgress) {
        if (entry?.channel?.id != null) {
          seriesDbById.set(entry.channel.id, entry);
        }
      }
      if (seriesProgress.length > 0) {
        const latest = seriesProgress[0];
        if (latest.completed && latest.next_episode) {
          lastWatchedEp = latest.next_episode;
        } else {
          lastWatchedEp = latest.channel;
        }
      }
    } catch (e) {
      console.warn('Failed to query watch_history for series in playSeriesDirectly:', e);
    }

    let targetSeason: Channel | undefined;
    if (lastWatchedEp) {
      if (lastWatchedEp.season_id != null) {
        targetSeason = seasonChannels.find((s) => s.id === lastWatchedEp!.season_id);
      }
      if (!targetSeason) {
        const sMatch =
          lastWatchedEp.name?.match(/\bS(\d{1,2})\s*E\d{1,2}\b/i) ||
          lastWatchedEp.name?.match(/(\d+)x(\d+)/i) ||
          lastWatchedEp.name?.match(/\bSeason\s*(\d{1,2})\b/i);
        if (sMatch) {
          const sNum = parseInt(sMatch[1], 10);
          targetSeason = seasonChannels.find((s, idx) => {
            const numMatch = s.name?.match(/(\d+)/);
            const num = numMatch ? parseInt(numMatch[1], 10) : idx + 1;
            return num === sNum;
          });
        }
      }
    }

    if (!targetSeason) {
      targetSeason = seasonChannels[0];
    }

    const sMatch = targetSeason.name?.match(/(\d+)/);
    const targetSeasonNum = sMatch ? parseInt(sMatch[1], 10) : 1;

    const epFilters: Filters = {
      source_ids: sourceIds,
      series_id: seriesId,
      season: targetSeason.id,
      media_types: [MediaType.movie],
      view_type: ViewMode.All,
      use_keywords: false,
      page: 1,
      sort: SortType.alphabeticalAscending,
    };

    const episodeChannels = (await invoke('search', { filters: epFilters })) as Channel[];
    if (!episodeChannels || episodeChannels.length === 0) {
      this.tvDetailService.openTvDetail(seriesChannel);
      return;
    }

    let targetEpisode: Channel | undefined;
    if (lastWatchedEp) {
      targetEpisode = episodeChannels.find((e) => e.id === lastWatchedEp!.id);
    }
    if (!targetEpisode) {
      targetEpisode = episodeChannels[0];
    }

    const seriesTitle = sanitizeShowTitle(seriesChannel.name);
    const epNum = targetEpisode.episode_num ?? this.extractEpisodeNumber(targetEpisode.name);
    const label = formatPlayerEpisodeLabel(seriesTitle, targetEpisode.name, epNum, targetSeasonNum);
    const overlayTitle = label.full;

    const switcherSeasons: SwitcherSeasonData[] = seasonChannels.map((s, idx) => {
      const numMatch = s.name?.match(/(\d+)/);
      return {
        id: s.id!,
        seasonNum: numMatch ? parseInt(numMatch[1], 10) : idx + 1,
        name: s.name || `Season ${idx + 1}`,
      };
    });

    const switcherEpisodes: SwitcherEpisodeData[] = episodeChannels.map((ch, idx) => {
      const eNumber = ch.episode_num ?? (idx + 1);
      const db = ch.id != null ? seriesDbById.get(ch.id) : undefined;
      const isWatchedDb = Boolean(
        db &&
          (db.completed ||
            db.position_sec > 0 ||
            db.progress_percent > 0 ||
            db.last_watched > 0),
      );
      return {
        id: ch.id!,
        channel: ch,
        episodeNum: eNumber,
        seasonNum: targetSeasonNum,
        title: sanitizeEpisodeTitle(ch.name, seriesTitle, eNumber, targetSeasonNum) || `Episode ${eNumber}`,
        stillUrl: ch.image,
        isWatched: isWatchedDb || (ch as any).last_watched != null,
        isCurrent: ch.id === targetEpisode!.id,
      };
    });

    await this.startPlayer(targetEpisode, canvas, {
      title: overlayTitle,
      mode: 'episode',
      seriesChannel: seriesChannel,
      seriesTitle: seriesTitle,
      seasons: switcherSeasons,
      currentSeasonNum: targetSeasonNum,
      episodes: switcherEpisodes,
    });
  }

  private async playEpisodeDirectly(channel: Channel, canvas: string): Promise<void> {
    let playChannel: Channel = channel;
    if (!playChannel.url || !playChannel.source_id) {
      try {
        const results = (await invoke('search', {
          filters: {
            source_ids: playChannel.source_id ? [playChannel.source_id] : Array.from(this.memory.Sources.keys()),
            view_type: ViewMode.All,
            media_types: [MediaType.movie],
            query: playChannel.name,
            page: 1,
            sort: SortType.provider,
            use_keywords: false,
          },
        })) as Channel[];
        const fresh = results?.find((c) => c.id === playChannel.id);
        if (fresh) {
          playChannel = { ...fresh, media_type: MediaType.movie, favorite: !!fresh.favorite };
        }
      } catch {}
    }

    const seriesTitle = this.extractSeriesTitle(playChannel);
    const seasonNum = this.extractSeasonNumber(playChannel);
    const epNum = this.extractEpisodeNumber(playChannel.name);
    const label = formatPlayerEpisodeLabel(seriesTitle, playChannel.name, epNum, seasonNum);
    const overlayTitle = label.full;

    await this.startPlayer(playChannel, canvas, {
      title: overlayTitle,
      mode: 'episode',
      seriesTitle: seriesTitle || undefined,
      currentSeasonNum: seasonNum,
      currentEpisodeNum: epNum,
    });
  }

  ngOnDestroy(): void {
    this.cancelPendingReconnect(false);
    if (this.routerSubscription) {
      this.routerSubscription.unsubscribe();
    }
    if (this.unlistenRequestMode) this.unlistenRequestMode();
    if (this.unlistenRequestCrop) this.unlistenRequestCrop();
    if (this.unlistenGlobalStopped) this.unlistenGlobalStopped();
    if (this.unlistenPlayerStarted) this.unlistenPlayerStarted();
    if (this.unlistenRequestEpisodes) this.unlistenRequestEpisodes();
    if (this.unlistenChangeSeason) this.unlistenChangeSeason();
    if (this.unlistenSelectEpisode) this.unlistenSelectEpisode();
    if (this.unlistenRequestChannels) this.unlistenRequestChannels();
    if (this.unlistenSelectChannel) this.unlistenSelectChannel();
    if (this.unlistenSaveProgress) this.unlistenSaveProgress();
    if (this.unlistenSaveVolume) this.unlistenSaveVolume();
    if (this.unlistenSettingsUpdated) this.unlistenSettingsUpdated();
    if (this.unlistenRequestRecommendations) this.unlistenRequestRecommendations();
    if (this.unlistenPlayRecommendedMovie) this.unlistenPlayRecommendedMovie();
    if (this.unlistenRequestSegments) this.unlistenRequestSegments();
    if (this.unlistenContextualAction) this.unlistenContextualAction();
    if (this.unlistenPocEvent) this.unlistenPocEvent();
  }
}
