import { ChangeDetectorRef, ElementRef, SecurityContext } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { Subject } from 'rxjs';
import { MediaType } from '../models/mediaType';
import { WatchProgressRecord } from '../services/embedded-player.service';
import { MovieDetailComponent } from './movie-detail.component';

describe('MovieDetailComponent (Phase 4C Authoritative Watch History Reads)', () => {
  let component: MovieDetailComponent;
  let ipcCalls: Array<{ cmd: string; args?: Record<string, unknown> }>;
  let batchMap: Map<number, WatchProgressRecord>;
  let cachedPlayerMap: Map<number, WatchProgressRecord>;

  beforeEach(() => {
    localStorage.clear();
    ipcCalls = [];
    batchMap = new Map();
    cachedPlayerMap = new Map();

    const mockEmbeddedPlayer: any = {
      getCachedProgressRecord: (id: number) => cachedPlayerMap.get(id),
      seedCachedProgressRecords: (recs: WatchProgressRecord[]) => {
        for (const r of recs) {
          if (r.channel_id != null) cachedPlayerMap.set(r.channel_id, r);
        }
      },
      resolveAuthoritativeProgress: jasmine.createSpy('resolveAuthoritativeProgress').and.resolveTo({
        positionSec: 0,
        durationSec: 0,
        completed: false,
        source: 'watch_history',
      }),
      emitPlaybackSegments: () => Promise.resolve(),
      computeStableMediaKey: () => 'movie_test',
    };

    const mockCdr = { markForCheck: () => {}, detectChanges: () => {} } as unknown as ChangeDetectorRef;
    const mockSanitizer = {
      sanitize: (_ctx: SecurityContext, v: string) => v,
      bypassSecurityTrustResourceUrl: (v: string) => v,
    } as unknown as DomSanitizer;

    component = new MovieDetailComponent(
      { getSelectedMovie: () => undefined } as any,
      { getEnrichmentSync: () => undefined, getEnrichment: () => Promise.resolve(undefined), enrichmentUpdated$: new Subject() } as any,
      { saveEnrichment: () => {} } as any,
      { isEnabled: () => false } as any,
      { Sources: new Map([[1, { id: 1, enabled: true }]]), SeriesRefreshed: new Map() } as any,
      {
        getPreferredVersion: () => undefined,
        isUserSelectedVersion: () => false,
        getDefaultVersion: (vs: any[]) => vs[0],
        findVersions: () => Promise.resolve([]),
        channelToVersion: (c: any) => ({ channel: c, isSelected: true, cleanTitle: c.name, rawName: c.name }),
        savePreferredVersion: () => {},
      } as any,
      { nativeElement: document.createElement('div') } as ElementRef,
      { navigate: () => Promise.resolve(true) } as any,
      { back: () => {} } as any,
      { info: () => {}, success: () => {}, error: () => {} } as any,
      { handleError: () => {} } as any,
      mockSanitizer,
      mockCdr,
      mockEmbeddedPlayer,
      { setArtwork: () => {}, resetToDefault: () => {} } as any,
      { favoriteChanged$: new Subject(), toggleFavorite: () => {} } as any,
    );

    spyOn(component as any, 'invokeIpc').and.callFake(
      async (cmd: string, args?: Record<string, unknown>) => {
        ipcCalls.push({ cmd, args });
        if (cmd === 'get_watch_progress_batch') {
          const ids = (args?.['channelIds'] as number[]) || [];
          return ids.map((id) => batchMap.get(id)).filter(Boolean);
        }
        return null;
      },
    );
  });

  afterEach(() => {
    localStorage.clear();
    component.ngOnDestroy();
  });

  it('retrieves movie resume progress from watch_history across catalog ID changes', async () => {
    component.movie = {
      id: 2500, // regenerated ID after relink
      name: 'Interstellar (2014)',
      media_type: MediaType.movie,
      source_id: 2,
    };
    batchMap.set(2500, {
      identity_key: 'wh:v1:fp1:m:sid:777',
      channel_id: 2500,
      position_sec: 1800,
      duration_sec: 7200,
      progress_percent: 25,
      completed: false,
      updated_at: 3000,
      last_watched: 3000,
      tmdb_id: 157336,
    });

    await component.refreshAuthoritativeWatchProgress();
    expect(component.hasWatchProgress).toBeTrue();
    expect(ipcCalls.filter((c) => c.cmd === 'get_watch_progress_batch').length).toBe(1);
  });

  it('marks completed movies as NOT resumable even when stale localStorage or last_watched exist', async () => {
    localStorage.setItem(
      'fred_tv_watch_progress',
      JSON.stringify({
        101: { time: 1200, duration: 3600, percent: 33, completed: false, updatedAt: 1000 },
      }),
    );

    const movieWithLastWatched: any = {
      id: 101,
      name: 'Done Movie',
      media_type: MediaType.movie,
      source_id: 1,
      last_watched: 5000,
    };
    component.movie = movieWithLastWatched;
    batchMap.set(101, {
      identity_key: 'wh:v1:fp1:m:sid:101',
      channel_id: 101,
      position_sec: 3560,
      duration_sec: 3600,
      progress_percent: 99,
      completed: true,
      updated_at: 4000,
      last_watched: 4000,
      tmdb_id: null,
    });

    await component.refreshAuthoritativeWatchProgress();
    expect(component.hasWatchProgress).toBeFalse();
  });

  it('falls back to legacy localStorage only when DB has no record and preserves legacy keys', async () => {
    localStorage.setItem('playback_pos_303', '900');
    localStorage.setItem('playback_dur_303', '3600');
    component.movie = {
      id: 303,
      name: 'Legacy Only Film',
      media_type: MediaType.movie,
      source_id: 1,
    };

    await component.refreshAuthoritativeWatchProgress();
    expect(component.hasWatchProgress).toBeTrue();
    expect(localStorage.getItem('playback_pos_303')).toBe('900');
  });
});
