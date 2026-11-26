import { NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import {
  EmbeddedPlayerService,
  WatchProgressRecord,
} from './embedded-player.service';

describe('EmbeddedPlayerService (Phase 4A Authoritative Progress Reads)', () => {
  let service: EmbeddedPlayerService;
  let ipcCalls: Array<{ cmd: string; args?: Record<string, unknown> }>;
  let dbResponseMap: Map<number, WatchProgressRecord | null>;
  let initSpy: jasmine.Spy;

  const mockZone = {
    run: (fn: () => any) => fn(),
  } as unknown as NgZone;

  const mockRouter: any = {
    url: '/home',
    events: new Subject(),
  };

  const mockMemory: any = {
    Sources: new Map(),
    SetNode: new Subject(),
  };

  const mockVersionMatching: any = {
    getCachedVersions: () => undefined,
    loadPreferredVersions: () => new Map(),
  };

  const mockMovieDetail: any = {};
  const mockTvDetail: any = {};
  const mockHomeDiscovery: any = {};
  const mockTmdbEnrichment: any = {
    setPlaybackActive: () => {},
    getEnrichmentSync: () => undefined,
  };
  const mockPlaybackSegment: any = {
    getSegmentsSync: () => [],
    getSegments: () => Promise.resolve([]),
  };
  const mockAppPreferences: any = {
    emitOverlayPreferences: () => {},
  };

  const clearLegacyStorage = () => {
    localStorage.removeItem('fred_tv_watch_progress');
    localStorage.removeItem('playback_pos_101');
    localStorage.removeItem('playback_dur_101');
    localStorage.removeItem('watch_progress_101');
    localStorage.removeItem('playback_pos_202');
    localStorage.removeItem('playback_dur_202');
    localStorage.removeItem('watch_progress_202');
    localStorage.removeItem('playback_pos_303');
    localStorage.removeItem('playback_dur_303');
    localStorage.removeItem('watch_progress_303');
  };

  beforeEach(() => {
    clearLegacyStorage();
    ipcCalls = [];
    dbResponseMap = new Map();
    initSpy = spyOn(
      EmbeddedPlayerService.prototype as any,
      'initGlobalListeners',
    ).and.returnValue(Promise.resolve());

    service = new EmbeddedPlayerService(
      mockZone,
      mockRouter,
      mockMemory,
      mockVersionMatching,
      mockMovieDetail,
      mockTvDetail,
      mockHomeDiscovery,
      mockTmdbEnrichment,
      mockPlaybackSegment,
      mockAppPreferences,
    );

    spyOn(service as any, 'invokeIpc').and.callFake(
      async (cmd: string, args?: Record<string, unknown>) => {
        ipcCalls.push({ cmd, args });
        if (cmd === 'get_watch_progress') {
          const id = Number(args?.['channelId']);
          return dbResponseMap.has(id) ? dbResponseMap.get(id) : null;
        }
        if (cmd === 'upsert_watch_progress') {
          return undefined;
        }
        return null;
      },
    );
  });

  afterEach(() => {
    clearLegacyStorage();
    service.ngOnDestroy();
    expect(initSpy).toHaveBeenCalled();
  });

  it('prefers watch_history DB progress over stale localStorage values', async () => {
    const channel: Channel = {
      id: 101,
      name: 'Inception (2010)',
      media_type: MediaType.movie,
      source_id: 1,
    };

    localStorage.setItem(
      'fred_tv_watch_progress',
      JSON.stringify({
        101: { time: 2400, duration: 7200, percent: 33, completed: false, updatedAt: 1000 },
      }),
    );
    localStorage.setItem('playback_pos_101', '2400');

    dbResponseMap.set(101, {
      identity_key: 'wh:v1:fp1:m:sid:555',
      channel_id: 101,
      position_sec: 420,
      duration_sec: 7200,
      progress_percent: 6,
      completed: false,
      updated_at: 2000,
      last_watched: 2000,
      tmdb_id: 27205,
    });

    const resolved = await service.resolveAuthoritativeProgress(101, channel, 'movie');
    expect(resolved.source).toBe('watch_history');
    expect(resolved.positionSec).toBe(420);
    expect(resolved.durationSec).toBe(7200);
    expect(resolved.completed).toBeFalse();
    expect(service.getSavedPosition(101, channel)).toBe(420);
    expect(service.getSavedDuration(101, channel)).toBe(7200);
  });

  it('returns 0 resume position for completed movie even when stale localStorage has old progress', async () => {
    const channel: Channel = {
      id: 101,
      name: 'Completed Movie',
      media_type: MediaType.movie,
      source_id: 1,
    };

    localStorage.setItem('playback_pos_101', '900');
    localStorage.setItem('playback_dur_101', '3600');

    dbResponseMap.set(101, {
      identity_key: 'wh:v1:fp1:m:sid:555',
      channel_id: 101,
      position_sec: 3560,
      duration_sec: 3600,
      progress_percent: 99,
      completed: true,
      updated_at: 3000,
      last_watched: 3000,
      tmdb_id: null,
    });

    const resolved = await service.resolveAuthoritativeProgress(101, channel, 'movie');
    expect(resolved.source).toBe('watch_history');
    expect(resolved.completed).toBeTrue();
    expect(resolved.positionSec).toBe(0);
    expect(service.getSavedPosition(101, channel)).toBe(0);
  });

  it('applies 90% episode completion threshold and resumes non-completed zero-duration rows safely', async () => {
    const completedEp: Channel = {
      id: 202,
      name: 'S01E02 - Test',
      media_type: MediaType.serie,
      series_id: 10,
      episode_num: 2,
      source_id: 1,
    };
    dbResponseMap.set(202, {
      identity_key: 'wh:v1:fp1:ep:s10:sn1:e2',
      channel_id: 202,
      position_sec: 2700,
      duration_sec: 2950,
      progress_percent: 92,
      completed: false,
      updated_at: 3000,
      last_watched: 3000,
      tmdb_id: null,
    });

    const epState = await service.resolveAuthoritativeProgress(202, completedEp, 'episode');
    expect(epState.completed).toBeTrue();
    expect(epState.positionSec).toBe(0);

    const unknownDurMovie: Channel = {
      id: 303,
      name: 'Unknown Duration Film',
      media_type: MediaType.movie,
      source_id: 1,
    };
    dbResponseMap.set(303, {
      identity_key: 'wh:v1:fp1:m:sid:303',
      channel_id: 303,
      position_sec: 515,
      duration_sec: 0,
      progress_percent: 0,
      completed: false,
      updated_at: 3100,
      last_watched: 3100,
      tmdb_id: null,
    });

    const unknownDurState = await service.resolveAuthoritativeProgress(303, unknownDurMovie, 'movie');
    expect(unknownDurState.completed).toBeFalse();
    expect(unknownDurState.positionSec).toBe(515);
    expect(unknownDurState.durationSec).toBe(0);
  });

  it('falls back to legacy localStorage only when DB has no progress and syncs without deleting legacy keys', async () => {
    const channel: Channel = {
      id: 101,
      name: 'Legacy Movie',
      media_type: MediaType.movie,
      source_id: 1,
    };

    localStorage.setItem(
      'fred_tv_watch_progress',
      JSON.stringify({
        101: { time: 650, duration: 3600, percent: 18, completed: false, updatedAt: 1700000000000 },
      }),
    );
    dbResponseMap.set(101, null);

    const resolved = await service.resolveAuthoritativeProgress(101, channel, 'movie');
    expect(resolved.source).toBe('legacy');
    expect(resolved.positionSec).toBe(650);
    expect(resolved.durationSec).toBe(3600);
    expect(resolved.completed).toBeFalse();

    const upserts = ipcCalls.filter((c) => c.cmd === 'upsert_watch_progress');
    expect(upserts.length).toBe(1);
    expect(localStorage.getItem('fred_tv_watch_progress')).not.toBeNull();
  });

  it('excludes Live TV from watch_history and localStorage progress reads', async () => {
    const liveChannel: Channel = {
      id: 101,
      name: 'Live News HD',
      media_type: MediaType.livestream,
      source_id: 1,
    };
    localStorage.setItem('playback_pos_101', '300');
    dbResponseMap.set(101, {
      identity_key: 'should-not-matter',
      channel_id: 101,
      position_sec: 300,
      duration_sec: 1200,
      progress_percent: 25,
      completed: false,
      updated_at: 3000,
      last_watched: 3000,
      tmdb_id: null,
    });

    const resolved = await service.resolveAuthoritativeProgress(101, liveChannel, 'live');
    expect(resolved.source).toBe('none');
    expect(resolved.positionSec).toBe(0);
    expect(ipcCalls.some((c) => c.cmd === 'get_watch_progress')).toBeFalse();
    expect(service.getSavedPosition(101, liveChannel)).toBe(0);
  });

  it('handles corrupt localStorage gracefully without throwing', async () => {
    const channel: Channel = {
      id: 101,
      name: 'Corrupt Fallback Test',
      media_type: MediaType.movie,
      source_id: 1,
    };
    localStorage.setItem('fred_tv_watch_progress', '{not valid json');
    dbResponseMap.set(101, null);

    const resolved = await service.resolveAuthoritativeProgress(101, channel, 'movie');
    expect(resolved.positionSec).toBe(0);
    expect(resolved.completed).toBeFalse();
  });
});
