import {
  Component,
  EventEmitter,
  HostListener,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { MemoryService } from '../memory.service';
import { Channel } from '../models/channel';
import { Filters } from '../models/filters';
import { MediaType } from '../models/mediaType';
import { SortType } from '../models/sortType';
import { ViewMode } from '../models/viewMode';
import { TmdbEnrichmentService } from '../services/tmdb-enrichment.service';
import { TmdbMediaEnrichment, TmdbSeasonDetail } from '../models/tmdb';
import { WatchProgressRecord } from '../services/embedded-player.service';
import { getTmdbStillUrl } from '../utils/tmdb-image';
import { cleanMediaTitle, sanitizeShowTitle, sanitizeEpisodeTitle } from '../utils/media-presentation';

export interface SwitcherEpisode {
  channel: Channel;
  episodeNum: number;
  seasonNum: number;
  title: string;
  stillUrl?: string;
  isWatched?: boolean;
}

@Component({
  selector: 'app-episode-switcher',
  templateUrl: './episode-switcher.component.html',
  styleUrl: './episode-switcher.component.css',
})
export class EpisodeSwitcherComponent implements OnInit, OnDestroy {
  @Output() switchEpisode = new EventEmitter<Channel>();
  @Output() close = new EventEmitter<void>();

  isOpen = false;
  loading = false;

  // Series info
  seriesChannel?: Channel;
  seriesTitle: string = '';
  enrichment?: TmdbMediaEnrichment;

  // Seasons & Episodes
  seasons: Channel[] = [];
  selectedSeason?: Channel;
  selectedSeasonNumber: number = 1;
  episodes: SwitcherEpisode[] = [];
  currentEpisodeId?: number;

  constructor(
    private memory: MemoryService,
    private tmdbEnrichment: TmdbEnrichmentService,
  ) {}

  ngOnInit(): void {}
  ngOnDestroy(): void {}

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (!this.isOpen) return;
    if (event.key === 'Escape') {
      this.closePanel();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  async open(
    seriesChannel: Channel,
    currentEpisode?: Channel,
    enrichment?: TmdbMediaEnrichment,
  ): Promise<void> {
    this.isOpen = true;
    this.seriesChannel = seriesChannel;
    this.seriesTitle = sanitizeShowTitle(seriesChannel.name);
    this.currentEpisodeId = currentEpisode?.id;
    this.enrichment = enrichment;
    this.seasons = [];
    this.episodes = [];
    this.selectedSeason = undefined;

    // Try to get TMDB enrichment from cache
    if (!this.enrichment) {
      this.enrichment = this.tmdbEnrichment.getEnrichmentSync(seriesChannel);
    }

    await this.loadSeasons();
  }

  closePanel(): void {
    this.isOpen = false;
    this.close.emit();
  }

  async loadSeasons(): Promise<void> {
    if (!this.seriesChannel) return;
    this.loading = true;
    try {
      const seriesId = parseInt(
        this.seriesChannel.url || `${this.seriesChannel.id}`,
        10,
      );
      const sourceIds = this.seriesChannel.source_id
        ? [this.seriesChannel.source_id]
        : Array.from(this.memory.Sources.keys());

      // Ensure episodes are fetched from Xtream
      if (!this.memory.SeriesRefreshed.has(this.seriesChannel.id!)) {
        try {
          await invoke('get_episodes', { channel: this.seriesChannel });
          this.memory.SeriesRefreshed.set(this.seriesChannel.id!, true);
        } catch {}
      }

      const filters: Filters = {
        source_ids: sourceIds,
        series_id: seriesId,
        media_types: [MediaType.serie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };

      const results = (await invoke('search', { filters })) as Channel[];
      this.seasons = results || [];

      // Auto-select first season
      if (this.seasons.length > 0) {
        await this.selectSeason(this.seasons[0]);
      }
    } catch (e) {
      console.error('Episode switcher: failed to load seasons:', e);
    } finally {
      this.loading = false;
    }
  }

  async selectSeason(season: Channel): Promise<void> {
    this.selectedSeason = season;
    this.loading = true;

    try {
      const seriesId = parseInt(
        this.seriesChannel!.url || `${this.seriesChannel!.id}`,
        10,
      );
      const sourceIds = this.seriesChannel!.source_id
        ? [this.seriesChannel!.source_id]
        : Array.from(this.memory.Sources.keys());

      const sMatch = season.name?.match(/(\d+)/);
      this.selectedSeasonNumber = sMatch ? parseInt(sMatch[1], 10) : 1;

      const filters: Filters = {
        source_ids: sourceIds,
        series_id: seriesId,
        season: season.id,
        media_types: [MediaType.movie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };

      const episodeChannels = (await invoke('search', { filters })) as Channel[];

      const epIds = (episodeChannels || [])
        .map((c) => c.id)
        .filter((id): id is number => id != null);
      const dbByChId = new Map<number, WatchProgressRecord>();
      if (epIds.length > 0) {
        try {
          const batch = (await invoke('get_watch_progress_batch', {
            channelIds: epIds,
          })) as WatchProgressRecord[];
          if (Array.isArray(batch)) {
            for (const rec of batch) {
              if (rec?.channel_id != null) {
                dbByChId.set(rec.channel_id, rec);
              }
            }
          }
        } catch {}
      }

      // Get TMDB season details for thumbnails
      let tmdbSeason: TmdbSeasonDetail | undefined;
      if (this.enrichment?.tmdbId) {
        try {
          tmdbSeason = await this.tmdbEnrichment.getSeasonDetails(
            this.enrichment.tmdbId,
            this.selectedSeasonNumber,
          );
        } catch {}
      }

      this.episodes = (episodeChannels || []).map((epChannel, index) => {
        const epNum =
          epChannel.episode_num ?? this.extractEpNum(epChannel.name, index + 1);
        const tmdbEp = tmdbSeason?.episodes?.find(
          (te) => te.episodeNumber === epNum,
        );

        const cleanEpTitle = epChannel.name ? sanitizeEpisodeTitle(epChannel.name, this.seriesTitle, epNum, this.selectedSeasonNumber) : '';
        const title = tmdbEp?.name
          ? `${epNum}. ${tmdbEp.name}`
          : (cleanEpTitle ? `${epNum}. ${cleanEpTitle}` : `Episode ${epNum}`);
        const stillUrl = tmdbEp?.stillPath
          ? getTmdbStillUrl(tmdbEp.stillPath, 'w300')
          : epChannel.image;

        const cleanEp: Channel = {
          ...epChannel,
          media_type: MediaType.movie,
          season_id: epChannel.season_id || season.id,
          episode_num: epNum,
          source_id: epChannel.source_id || this.seriesChannel?.source_id,
          series_id:
            epChannel.series_id || this.getSeriesIdNumber(),
          favorite: !!epChannel.favorite,
        };
        const dbRec = epChannel.id != null ? dbByChId.get(epChannel.id) : undefined;
        const isWatchedFromDb = Boolean(
          dbRec &&
            (dbRec.completed ||
              dbRec.position_sec > 0 ||
              dbRec.progress_percent > 0 ||
              dbRec.last_watched > 0),
        );

        return {
          channel: cleanEp,
          episodeNum: epNum,
          seasonNum: this.selectedSeasonNumber,
          title,
          stillUrl,
          isWatched: isWatchedFromDb || (epChannel as any).last_watched != null,
        };
      });
    } catch (e) {
      console.error('Episode switcher: failed to load episodes:', e);
      this.episodes = [];
    } finally {
      this.loading = false;
    }
  }

  private getSeriesIdNumber(): number | undefined {
    if (this.seriesChannel?.series_id) return this.seriesChannel.series_id;
    if (
      this.seriesChannel?.url &&
      /^\d+$/.test(this.seriesChannel.url.trim())
    ) {
      return parseInt(this.seriesChannel.url.trim(), 10);
    }
    return this.seriesChannel?.id;
  }

  private extractEpNum(rawName?: string, fallback: number = 1): number {
    if (!rawName) return fallback;
    const match =
      rawName.match(/\b(?:e|ep|episode)[\s._-]*(\d+)\b/i) ||
      rawName.match(/(\d+)x(\d+)/i);
    if (match) {
      return parseInt(match[2] || match[1], 10);
    }
    return fallback;
  }

  onSelectEpisode(ep: SwitcherEpisode): void {
    this.currentEpisodeId = ep.channel.id;
    this.switchEpisode.emit(ep.channel);
    this.isOpen = false;
  }

  isCurrentEpisode(ep: SwitcherEpisode): boolean {
    return !!this.currentEpisodeId && ep.channel.id === this.currentEpisodeId;
  }

  trackBySeasonId(_index: number, s: Channel): number | undefined {
    return s.id;
  }

  trackByEpisodeId(_index: number, ep: SwitcherEpisode): number | undefined {
    return ep.channel.id;
  }
}
