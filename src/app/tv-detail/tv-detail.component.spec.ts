import { ChangeDetectorRef, ElementRef, SecurityContext } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { Subject } from 'rxjs';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { ContinueWatchingEntry } from '../services/home-discovery-state.service';
import { TvDetailComponent } from './tv-detail.component';

describe('TvDetailComponent (Phase 4C Authoritative Series & Episode Progress)', () => {
  let component: TvDetailComponent;
  let ipcCalls: Array<{ cmd: string; args?: Record<string, unknown> }>;
  let seriesEntriesResponse: ContinueWatchingEntry[];
  let seasonChannelsResponse: Channel[];
  let episodeChannelsResponse: Channel[];

  beforeEach(() => {
    localStorage.clear();
    ipcCalls = [];
    seriesEntriesResponse = [];
    seasonChannelsResponse = [];
    episodeChannelsResponse = [];

    const mockEmbeddedPlayer: any = {
      isPlayingEmbedded$: new Subject<boolean>(),
      playbackProgress$: new Subject(),
      lastWatchedUpdated$: new Subject<number>(),
      isPlayingEmbedded: false,
      getCachedProgressRecord: () => undefined,
      seedCachedProgressRecords: () => {},
      isEpisodeCompleted: () => false,
      extractSeasonNumber: () => 1,
      extractEpisodeNumber: (name: string) => {
        const m = name.match(/E(\d+)/i);
        return m ? parseInt(m[1], 10) : 1;
      },
      startPlayer: () => Promise.resolve(),
    };

    const mockCdr = { markForCheck: () => {}, detectChanges: () => {} } as unknown as ChangeDetectorRef;
    const mockSanitizer = {
      sanitize: (_ctx: SecurityContext, v: string) => v,
      bypassSecurityTrustResourceUrl: (v: string) => v,
    } as unknown as DomSanitizer;

    component = new TvDetailComponent(
      { getSelectedShow: () => undefined } as any,
      { getEnrichmentSync: () => undefined, getEnrichment: () => Promise.resolve(undefined), getSeasonDetails: () => Promise.resolve(undefined), enrichmentUpdated$: new Subject() } as any,
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
        if (cmd === 'get_series_watch_progress') {
          return seriesEntriesResponse;
        }
        if (cmd === 'search') {
          const filters: any = args?.['filters'];
          if (filters?.media_types?.includes(MediaType.serie)) {
            return seasonChannelsResponse;
          }
          return episodeChannelsResponse;
        }
        return null;
      },
    );
  });

  afterEach(() => {
    localStorage.clear();
    component.ngOnDestroy();
  });

  it('loads batched series watch_history progress (no N+1 calls), marks watched episodes, ignores stale localStorage, and selects next episode after completed episode', async () => {
    localStorage.setItem(
      'fred_tv_watch_progress',
      JSON.stringify({
        2002: { time: 200, duration: 2400, percent: 8, completed: false, updatedAt: 1000 },
      }),
    );

    const show: Channel = {
      id: 100,
      name: 'Breaking Bad',
      url: '300',
      media_type: MediaType.serie,
      source_id: 2,
    };
    component.show = show;
    component.cleanTitle = 'Breaking Bad';

    const ep1: Channel = {
      id: 2001,
      name: 'Breaking Bad S01E01 - Pilot',
      media_type: MediaType.movie,
      source_id: 2,
      series_id: 300,
      season_id: 20,
      episode_num: 1,
    };
    const ep2: Channel = {
      id: 2002,
      name: 'Breaking Bad S01E02 - Cat Bag',
      media_type: MediaType.movie,
      source_id: 2,
      series_id: 300,
      season_id: 20,
      episode_num: 2,
    };
    const ep3: Channel = {
      id: 2003,
      name: 'Breaking Bad S01E03 - And the Bag',
      media_type: MediaType.movie,
      source_id: 2,
      series_id: 300,
      season_id: 20,
      episode_num: 3,
    };

    seasonChannelsResponse = [
      { id: 20, name: 'Season 1', media_type: MediaType.serie, source_id: 2 },
    ];
    episodeChannelsResponse = [ep1, ep2, ep3];
    seriesEntriesResponse = [
      {
        identity_key: 'wh:v1:fp1:ep:s300:sn1:e2',
        channel: ep2,
        position_sec: 1200,
        duration_sec: 2400,
        progress_percent: 50,
        completed: false,
        last_watched: 5000,
        updated_at: 5000,
        is_episode: true,
        show_title: 'Breaking Bad',
        season_number: 1,
        episode_number: 2,
      },
      {
        identity_key: 'wh:v1:fp1:ep:s300:sn1:e1',
        channel: ep1,
        position_sec: 2350,
        duration_sec: 2400,
        progress_percent: 98,
        completed: true,
        last_watched: 4000,
        updated_at: 4000,
        is_episode: true,
        show_title: 'Breaking Bad',
        season_number: 1,
        episode_number: 1,
        next_episode: ep2,
      },
    ];

    await component.loadSeasonsAndEpisodes(show);

    expect(ipcCalls.filter((c) => c.cmd === 'get_series_watch_progress').length).toBe(1);
    expect(ipcCalls.filter((c) => c.cmd === 'get_watch_progress').length).toBe(0);
    expect(component.enrichedEpisodes.length).toBe(3);
    expect(component.enrichedEpisodes[0].isWatched).toBeTrue();
    expect(component.enrichedEpisodes[1].isWatched).toBeTrue();
    expect(component.enrichedEpisodes[2].isWatched).toBeFalse();
    expect(component.getEpisodeProgress(component.enrichedEpisodes[0])).toBe(100);
    // DB says 50%, overriding stale 8% localStorage
    expect(component.getEpisodeProgress(component.enrichedEpisodes[1])).toBe(50);
    expect(component.getEpisodeProgress(component.enrichedEpisodes[2])).toBe(0);
    expect(component.continueEpisode?.channel.id).toBe(2002);
  });

  it('advances to DB-resolved next_episode across seasons when latest episode is completed', async () => {
    const show: Channel = {
      id: 100,
      name: 'Severance',
      url: '700',
      media_type: MediaType.serie,
      source_id: 1,
    };
    component.show = show;
    component.cleanTitle = 'Severance';

    const s1e9: Channel = {
      id: 109,
      name: 'Severance S01E09',
      media_type: MediaType.movie,
      source_id: 1,
      series_id: 700,
      season_id: 10,
      episode_num: 9,
    };
    const s2e1: Channel = {
      id: 201,
      name: 'Severance S02E01',
      media_type: MediaType.movie,
      source_id: 1,
      series_id: 700,
      season_id: 20,
      episode_num: 1,
    };

    seasonChannelsResponse = [
      { id: 10, name: 'Season 1', media_type: MediaType.serie, source_id: 1 },
      { id: 20, name: 'Season 2', media_type: MediaType.serie, source_id: 1 },
    ];
    episodeChannelsResponse = [s2e1];
    seriesEntriesResponse = [
      {
        identity_key: 'wh:v1:fp1:ep:s700:sn1:e9',
        channel: s1e9,
        position_sec: 2900,
        duration_sec: 3000,
        progress_percent: 97,
        completed: true,
        last_watched: 6000,
        updated_at: 6000,
        is_episode: true,
        show_title: 'Severance',
        season_number: 1,
        episode_number: 9,
        next_episode: s2e1,
      },
    ];

    await component.loadSeasonsAndEpisodes(show);

    expect(component.selectedSeason?.id).toBe(20);
    expect(component.continueEpisode?.channel.id).toBe(201);
  });
});
