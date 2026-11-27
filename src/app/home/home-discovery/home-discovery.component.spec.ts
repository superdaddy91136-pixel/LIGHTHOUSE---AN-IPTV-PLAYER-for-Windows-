import { ChangeDetectorRef, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { Channel } from '../../models/channel';
import { MediaType } from '../../models/mediaType';
import {
  ContinueWatchingEntry,
  HomeDiscoveryStateService,
} from '../../services/home-discovery-state.service';
import { HomeDiscoveryComponent } from './home-discovery.component';

describe('HomeDiscoveryComponent (Phase 4B Continue Watching DB Reads)', () => {
  let component: HomeDiscoveryComponent;
  let ipcCalls: Array<{ cmd: string; args?: Record<string, unknown> }>;
  let mockEmbeddedPlayer: any;
  let discoveryState: HomeDiscoveryStateService;

  const mockZone = {
    run: (fn: () => any) => fn(),
  } as unknown as NgZone;

  const mockCdr = {
    markForCheck: () => {},
    detectChanges: () => {},
  } as unknown as ChangeDetectorRef;

  const mockMemory: any = {
    Sources: new Map([[1, { id: 1, name: 'TestSource', enabled: true }]]),
    Refresh: new Subject(),
    SetNode: new Subject(),
  };

  const mockTmdbEnrichment: any = {
    enrichmentUpdated$: new Subject(),
    getEnrichmentSync: () => undefined,
    prefetchContentRating: () => {},
    getEpisodeStillSync: () => undefined,
    enqueue: () => {},
    getEnrichment: () => Promise.resolve(undefined),
    getTvEpisodeStill: () => Promise.resolve(undefined),
  };

  const mockTmdbConfig: any = {
    isEnabled: () => false,
  };

  const mockTmdbCache: any = {
    preloadChannels: () => Promise.resolve(),
  };

  const mockVersionMatching: any = {
    normalizeNumberTokens: (s: string) => s,
  };

  beforeEach(() => {
    localStorage.clear();
    ipcCalls = [];
    discoveryState = new HomeDiscoveryStateService(mockZone);
    discoveryState.clearCache();

    mockEmbeddedPlayer = {
      lastWatchedUpdated$: new Subject(),
      isPlayingEmbedded$: new Subject(),
      isEpisodeCompleted: () => false,
      isMovieCompleted: () => false,
      getSeriesKey: (ch: Channel) => `sid_${ch.source_id}_${ch.series_id ?? ch.id}`,
      getPersistedNextEpisode: () => undefined,
      setPersistedNextEpisode: () => {},
      clearPersistedNextEpisode: () => {},
      findNextEpisode: jasmine.createSpy('findNextEpisode').and.returnValue(Promise.resolve(null)),
      runLegacyWatchHistoryMigrationIfNeeded: () => Promise.resolve(),
      playMediaDirectly: () => Promise.resolve(),
    };

    component = new HomeDiscoveryComponent(
      mockMemory,
      { success: () => {}, error: () => {} } as any,
      mockTmdbEnrichment,
      mockTmdbConfig,
      mockTmdbCache,
      discoveryState,
      { openMovieDetail: () => {} } as any,
      { openTvDetail: () => {} } as any,
      mockVersionMatching,
      mockEmbeddedPlayer,
      { setAmbientArtwork: () => {} } as any,
      mockCdr,
      mockZone,
      { markHeroReady: () => {}, markRowsReady: () => {}, markHomeReady: () => {}, dismiss: () => {} } as any,
      { favoriteChanged$: new Subject(), setInitialFavorites: () => {} } as any,
    );

    spyOn(component as any, 'invokeIpc').and.callFake(
      async (cmd: string, args?: Record<string, unknown>) => {
        ipcCalls.push({ cmd, args });
        return null;
      },
    );
  });

  afterEach(() => {
    localStorage.clear();
    component.ngOnDestroy();
    discoveryState.ngOnDestroy();
  });

  it('reads Continue Watching movies and episodes from watch_history entries, keeps series/episode metadata, sorts by last_watched, and skips N+1 season searches', async () => {
    const movieEntry: ContinueWatchingEntry = {
      identity_key: 'wh:v1:fp1:m:sid:777',
      channel: {
        id: 5001,
        name: 'Interstellar (2014)',
        media_type: MediaType.movie,
        source_id: 1,
        stream_id: 777,
      },
      position_sec: 900,
      duration_sec: 3600,
      progress_percent: 25,
      completed: false,
      last_watched: 2000,
      updated_at: 2000,
      tmdb_id: 157336,
      is_episode: false,
    };

    const epEntry: ContinueWatchingEntry = {
      identity_key: 'wh:v1:fp1:ep:s300:sn1:e3',
      channel: {
        id: 5033,
        name: 'Episode 3 - Fly',
        media_type: MediaType.serie,
        source_id: 1,
        series_id: 300,
        season_id: 10,
        episode_num: 3,
        stream_id: 903,
      },
      position_sec: 1200,
      duration_sec: 3000,
      progress_percent: 40,
      completed: false,
      last_watched: 3000,
      updated_at: 3000,
      tmdb_id: 1396,
      is_episode: true,
      show_title: 'Breaking Bad',
      season_number: 1,
      episode_number: 3,
    };

    const result = await component.deduplicateContinueWatching([movieEntry, epEntry]);
    expect(result.map((c) => c.id)).toEqual([5033, 5001]);
    expect(component.getWatchProgress(result[0])).toBe(40);
    expect(component.getWatchProgress(result[1])).toBe(25);
    expect(component.getContinueWatchingTitle(result[0])).toContain('Breaking Bad');
    expect(component.getContinueWatchingTitle(result[0])).toContain('S1 E3');
    // Season number was seeded from SQLite entry, so zero per-series season search IPC calls
    expect(ipcCalls.filter((c) => c.cmd === 'search').length).toBe(0);
  });

  it('excludes completed movies and prevents stale localStorage from overriding DB progress or completion', async () => {
    // Stale localStorage claims movie 101 is at 60% AND movie 102 is at 99% completed
    localStorage.setItem(
      'fred_tv_watch_progress',
      JSON.stringify({
        101: { time: 2160, duration: 3600, percent: 60, completed: false, updatedAt: 1000 },
        102: { time: 3564, duration: 3600, percent: 99, completed: true, updatedAt: 1000 },
      }),
    );

    const completedDbMovie: ContinueWatchingEntry = {
      identity_key: 'wh:v1:fp1:m:sid:101',
      channel: { id: 101, name: 'Completed DB Movie', media_type: MediaType.movie, source_id: 1 },
      position_sec: 3550,
      duration_sec: 3600,
      progress_percent: 99,
      completed: true,
      last_watched: 3000,
      updated_at: 3000,
      is_episode: false,
    };

    const activeDbMovie: ContinueWatchingEntry = {
      identity_key: 'wh:v1:fp1:m:sid:102',
      channel: { id: 102, name: 'Rewatched DB Movie', media_type: MediaType.movie, source_id: 1 },
      position_sec: 720,
      duration_sec: 3600,
      progress_percent: 20,
      completed: false,
      last_watched: 2500,
      updated_at: 2500,
      is_episode: false,
    };

    const result = await component.deduplicateContinueWatching([
      completedDbMovie,
      activeDbMovie,
    ]);
    expect(result.map((c) => c.id)).toEqual([102]);
    expect(component.getWatchProgress(result[0])).toBe(20);
  });

  it('advances completed episode to DB-resolved next_episode and keeps series visible without duplicates', async () => {
    const nextEp: Channel = {
      id: 702,
      name: 'S01E02 - Second Hour',
      media_type: MediaType.serie,
      source_id: 1,
      series_id: 700,
      season_id: 70,
      episode_num: 2,
      stream_id: 7020,
    };

    const olderCompletedEp: ContinueWatchingEntry = {
      identity_key: 'wh:v1:fp1:ep:s700:sn1:e1',
      channel: {
        id: 701,
        name: 'S01E01 - First Hour',
        media_type: MediaType.serie,
        source_id: 1,
        series_id: 700,
        season_id: 70,
        episode_num: 1,
        stream_id: 7010,
      },
      position_sec: 2900,
      duration_sec: 3000,
      progress_percent: 97,
      completed: true,
      last_watched: 4000,
      updated_at: 4000,
      is_episode: true,
      show_title: 'Severance',
      season_number: 1,
      episode_number: 1,
      next_episode: nextEp,
    };

    const olderDupEp: ContinueWatchingEntry = {
      ...olderCompletedEp,
      identity_key: 'wh:v1:fp1:ep:s700:sn1:e1b',
      last_watched: 3500,
    };

    const result = await component.deduplicateContinueWatching([
      olderCompletedEp,
      olderDupEp,
    ]);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(702);
    expect(component.isNextEpisodeCard(result[0])).toBeTrue();
    expect(component.getContinueWatchingTitle(result[0])).toContain('Severance');
  });

  it('keeps a completed episode visible while next-episode lookup is in progress and does not merge different providers with identical numeric series_id', async () => {
    let resolveNext!: (ep: Channel | null) => void;
    mockEmbeddedPlayer.findNextEpisode.and.returnValue(
      new Promise<Channel | null>((r) => {
        resolveNext = r;
      }),
    );

    const provider1Ep: ContinueWatchingEntry = {
      identity_key: 'wh:v1:fp1:ep:s12:sn1:e4',
      channel: {
        id: 801,
        name: 'Show Alpha S01E04',
        media_type: MediaType.serie,
        source_id: 1,
        series_id: 12,
        episode_num: 4,
      },
      position_sec: 2900,
      duration_sec: 3000,
      progress_percent: 97,
      completed: true,
      last_watched: 5000,
      updated_at: 5000,
      is_episode: true,
      show_title: 'Show Alpha',
    };

    const provider2Ep: ContinueWatchingEntry = {
      identity_key: 'wh:v1:fp2:ep:s12:sn1:e2',
      channel: {
        id: 802,
        name: 'Different Show Beta S01E02',
        media_type: MediaType.serie,
        source_id: 2,
        series_id: 12,
        episode_num: 2,
      },
      position_sec: 600,
      duration_sec: 3000,
      progress_percent: 20,
      completed: false,
      last_watched: 4500,
      updated_at: 4500,
      is_episode: true,
      show_title: 'Different Show Beta',
    };

    const result = await component.deduplicateContinueWatching([
      provider1Ep,
      provider2Ep,
    ]);
    // Both distinct shows kept; provider1 stays visible while next-ep lookup is pending
    expect(result.map((c) => c.id)).toEqual([801, 802]);
    expect(mockEmbeddedPlayer.findNextEpisode).toHaveBeenCalledTimes(1);

    resolveNext(null);
    await Promise.resolve();
  });

  it('uses legacy localStorage fallback only when DB has no progress and preserves legacy storage', async () => {
    localStorage.setItem(
      'fred_tv_watch_progress',
      JSON.stringify({
        901: { time: 450, duration: 1800, percent: 25, completed: false, updatedAt: 1700000000000 },
      }),
    );

    const legacyChannel: Channel = {
      id: 901,
      name: 'Legacy Only Movie',
      media_type: MediaType.movie,
      source_id: 1,
    };

    const result = await component.deduplicateContinueWatching([legacyChannel]);
    expect(result.map((c) => c.id)).toEqual([901]);
    expect(component.getWatchProgress(result[0])).toBe(25);
    expect(localStorage.getItem('fred_tv_watch_progress')).not.toBeNull();
  });
});
