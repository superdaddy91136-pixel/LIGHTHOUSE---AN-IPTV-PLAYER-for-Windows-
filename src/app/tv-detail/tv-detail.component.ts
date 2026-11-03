import { Location } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { invoke } from '@tauri-apps/api/core';
import { ToastrService } from 'ngx-toastr';
import { Subscription } from 'rxjs';
import { ErrorService } from '../error.service';
import { MemoryService } from '../memory.service';
import { Channel } from '../models/channel';
import { Filters } from '../models/filters';
import { MediaType } from '../models/mediaType';
import { SortType } from '../models/sortType';
import { ViewMode } from '../models/viewMode';
import {
  TmdbCastMember,
  TmdbMediaEnrichment,
  TmdbSeasonDetail,
  TmdbVideo,
} from '../models/tmdb';
import { MediaVersion } from '../models/version';
import { TmdbCacheService } from '../services/tmdb-cache.service';
import { TmdbConfigService } from '../services/tmdb-config.service';
import { TmdbEnrichmentService } from '../services/tmdb-enrichment.service';
import { TvDetailService } from '../services/tv-detail.service';
import { VersionMatchingService } from '../services/version-matching.service';
import { EpisodeSwitcherComponent } from '../episode-switcher/episode-switcher.component';
import { EmbeddedPlayerService } from '../services/embedded-player.service';
import { AmbientBackgroundService } from '../services/ambient-background.service';
import { isInputFocused } from '../utils';
import {
  cleanMediaTitle,
  extractQuality,
  extractYear,
  selectSynopsis,
  sanitizeShowTitle,
  sanitizeEpisodeTitle,
  formatPlayerEpisodeLabel,
} from '../utils/media-presentation';
import {
  getTmdbBackdropUrl,
  getTmdbPosterUrl,
  getTmdbProfileUrl,
  getTmdbStillUrl,
} from '../utils/tmdb-image';

export interface EnrichedEpisode {
  channel: Channel;
  episodeNum: number;
  seasonNum: number;
  title: string;
  overview?: string;
  stillUrl?: string;
  airDate?: string;
  runtimeText?: string;
  rating?: number;
  isWatched?: boolean;
}

@Component({
  selector: 'app-tv-detail',
  templateUrl: './tv-detail.component.html',
  styleUrl: './tv-detail.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TvDetailComponent implements OnInit, AfterViewInit, OnDestroy {
  @HostBinding('class.skeleton-animations-paused')
  skeletonAnimationsPaused = document.hidden;

  show?: Channel;
  enrichment?: TmdbMediaEnrichment;

  cleanTitle: string = '';
  backdropUrl?: string;
  currentBackdropPath?: string;

  private updateAmbientBackground(): void {
    const art = (!this.backdropError && this.backdropUrl) ? this.backdropUrl : (this.posterUrl || this.show?.image);
    if (art) {
      this.ambientBackground.setArtwork(art, `tv-${this.show?.id}`);
    } else {
      this.ambientBackground.resetToDefault(`tv-${this.show?.id}`);
    }
  }
  posterUrl?: string;
  synopsis?: string;
  isSynopsisLong: boolean = false;
  isSynopsisExpanded: boolean = false;
  releaseYear?: string;
  genres: string[] = [];
  qualityBadge?: string;
  rating?: number;
  voteCount?: number;
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  status?: string;
  creator?: string;
  firstAirDate?: string;
  lastAirDate?: string;
  originalLanguage?: string;
  cast: TmdbCastMember[] = [];
  trailer?: TmdbVideo;
  safeTrailerUrl?: SafeResourceUrl;
  showTrailerModal: boolean = false;

  // Versions state
  versions: MediaVersion[] = [];
  selectedVersion?: MediaVersion;
  showVersionsMenu: boolean = false;
  loadingVersions: boolean = false;

  // Seasons & Episodes
  seasons: Channel[] = [];
  selectedSeason?: Channel;
  selectedSeasonNumber: number = 1;
  showSeasonMenu: boolean = false;
  episodes: Channel[] = [];
  enrichedEpisodes: EnrichedEpisode[] = [];
  continueEpisode?: EnrichedEpisode;
  lastWatchedEpisode?: Channel;
  highlightedEpisodeId?: number;
  loadingSeasons: boolean = false;
  loadingEpisodes: boolean = false;

  // Similar Shows
  similarShows: Channel[] = [];
  loadingSimilar: boolean = false;
  loadingEnrichment: boolean = false;
  skeletonCastPlaceholders: number[] = [1, 2, 3, 4, 5, 6, 7];
  skeletonSimilarPlaceholders: number[] = [1, 2, 3, 4, 5, 6];
  skeletonEpisodePlaceholders: number[] = [1, 2, 3, 4];
  private enrichmentTimeout?: any;
  isStartingPlayback: boolean = false;
  imageError: boolean = false;
  backdropError: boolean = false;
  isBackdropFallback: boolean = false;
  castImageErrors: Set<number> = new Set();
  episodeImageErrors: Set<number> = new Set();

  private subs: Subscription[] = [];
  private seasonLoadRequestId = 0;
  private episodeLoadRequestId = 0;
  private enrichmentLoadRequestId = 0;
  private versionLoadRequestId = 0;
  private similarLoadRequestId = 0;
  private episodeCache = new Map<string, Channel[]>();
  private episodeRequests = new Map<string, Promise<Channel[]>>();
  private episodeTitleCache = new Map<string, string>();
  @ViewChild('similarTrack') similarTrack?: ElementRef<HTMLDivElement>;
  @ViewChild('seasonSelectorTrack') seasonSelectorTrack?: ElementRef<HTMLDivElement>;
  @ViewChild(EpisodeSwitcherComponent) episodeSwitcher?: EpisodeSwitcherComponent;
  activePlayingEpisode?: Channel;

  constructor(
    private tvDetailService: TvDetailService,
    private tmdbEnrichment: TmdbEnrichmentService,
    private tmdbCache: TmdbCacheService,
    public tmdbConfig: TmdbConfigService,
    public memory: MemoryService,
    private versionMatching: VersionMatchingService,
    private elementRef: ElementRef,
    private router: Router,
    private location: Location,
    private toastr: ToastrService,
    private error: ErrorService,
    private sanitizer: DomSanitizer,
    private cdr: ChangeDetectorRef,
    public embeddedPlayer: EmbeddedPlayerService,
    private ambientBackground: AmbientBackgroundService,
  ) {}


  private resetScrollPosition(): void {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    } catch {
      window.scrollTo(0, 0);
    }
    if (document.documentElement) {
      document.documentElement.scrollTop = 0;
    }
    if (document.body) {
      document.body.scrollTop = 0;
    }
    const main = document.querySelector('.app-main');
    if (main) {
      main.scrollTop = 0;
    }
  }

  ngOnInit(): void {
    this.resetScrollPosition();
    const selected = this.tvDetailService.getSelectedShow();
    if (!selected) {
      this.goBack();
      return;
    }

    this.initShow(selected);

    // Listen for reactive TMDB background enrichment updates
    this.subs.push(
      this.tmdbEnrichment.enrichmentUpdated$.subscribe((updated) => {
        if (!this.show) return;

        const matchesProviderId = Number(updated.providerItemId) === Number(this.show.id);
        const matchesVersion =
          this.versions?.length > 0 &&
          this.versions.some((v) => Number(v.channel.id) === Number(updated.providerItemId));
        const matchesTmdbId = !!this.enrichment?.tmdbId && updated.tmdbId === this.enrichment.tmdbId;
        const currentCleanTitle = cleanMediaTitle(this.show.name).toLowerCase();
        const updatedNormTitle = (updated.normalizedTitle || '').toLowerCase();
        const matchesTitle =
          currentCleanTitle.length > 0 &&
          currentCleanTitle === updatedNormTitle &&
          (!this.releaseYear || !updated.releaseYear || this.releaseYear === updated.releaseYear);

        const isMatch = matchesProviderId || matchesVersion || matchesTmdbId || matchesTitle;

        if (isMatch) {
          this.loadingEnrichment = false;
          this.applyEnrichment(updated, this.show.id);
          if (this.show?.id && Number(updated.providerItemId) !== Number(this.show.id)) {
            this.tmdbCache.saveEnrichment({ ...updated, providerItemId: this.show.id });
          }
          // If we already have selected a season, re-enrich episodes
          if (this.selectedSeason) {
            this.reEnrichEpisodes();
          }
        }
      }),
    );

    this.subs.push(
      this.embeddedPlayer.isPlayingEmbedded$.subscribe(() => {
        this.cdr.detectChanges();
      }),
    );
  }

  ngAfterViewInit(): void {
    this.resetScrollPosition();
    setTimeout(() => this.resetScrollPosition(), 0);
  }

  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    this.skeletonAnimationsPaused = document.hidden;
    this.cdr.markForCheck();
  }

  ngOnDestroy(): void {
    // Invalidate outstanding promises so a detached detail component cannot be
    // updated after navigation.
    this.enrichmentLoadRequestId++;
    this.versionLoadRequestId++;
    this.similarLoadRequestId++;
    this.seasonLoadRequestId++;
    this.episodeLoadRequestId++;
    this.subs.forEach((s) => s.unsubscribe());
    if (this.enrichmentTimeout) {
      clearTimeout(this.enrichmentTimeout);
      this.enrichmentTimeout = undefined;
    }
    if (this.embeddedPlayer.isPlayingEmbedded) {
      this.embeddedPlayer.stopPlayer().catch(console.warn);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (this.embeddedPlayer.isPlayingEmbedded) {
      // Key events during embedded playback are handled directly by EmbeddedPlayerService
      return;
    }
    if (
      event.key === 'Escape' ||
      event.key === 'BrowserBack' ||
      (event.key === 'Backspace' && !isInputFocused())
    ) {
      if (this.showSeasonMenu) {
        this.showSeasonMenu = false;
      } else if (this.showVersionsMenu) {
        this.showVersionsMenu = false;
      } else if (this.showTrailerModal) {
        this.closeTrailer();
      } else {
        this.goBack();
      }
      event.preventDefault();
    }
  }


  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (this.showVersionsMenu) {
      const container = this.elementRef.nativeElement.querySelector(
        '.versions-dropdown-container',
      );
      if (container && !container.contains(target)) {
        this.showVersionsMenu = false;
      }
    }
    if (this.showSeasonMenu) {
      const seasonContainer = this.elementRef.nativeElement.querySelector(
        '.season-dropdown-container',
      );
      if (seasonContainer && !seasonContainer.contains(target)) {
        this.showSeasonMenu = false;
      }
    }
  }

  initShow(show: Channel): void {
    this.seasonLoadRequestId++;
    this.episodeLoadRequestId++;
    const enrichmentReqId = ++this.enrichmentLoadRequestId;
    this.resetScrollPosition();
    this.showSeasonMenu = false;
    this.showVersionsMenu = false;

    // Reset previous title state completely to prevent stale backdrop/metadata leakage
    this.show = show;
    if (this.show.media_type == null || Number(this.show.media_type) !== MediaType.serie) {
      this.show.media_type = MediaType.serie;
    }
    this.cleanTitle = cleanMediaTitle(show.name);
    this.releaseYear = extractYear(show.name);
    this.qualityBadge = extractQuality(show.name);
    this.synopsis = selectSynopsis(show);
    this.posterUrl = show.image;
    this.enrichment = undefined;
    this.versions = [];
    this.selectedVersion = undefined;
    this.similarShows = [];
    this.loadingSimilar = true;
    this.loadingVersions = true;
    this.genres = [];
    this.rating = undefined;
    this.voteCount = undefined;
    this.numberOfSeasons = undefined;
    this.numberOfEpisodes = undefined;
    this.status = undefined;
    this.creator = undefined;
    this.firstAirDate = undefined;
    this.lastAirDate = undefined;
    this.originalLanguage = undefined;
    this.cast = [];
    this.trailer = undefined;
    this.safeTrailerUrl = undefined;
    this.showTrailerModal = false;
    this.imageError = false;
    this.backdropError = false;
    this.backdropUrl = undefined;
    this.isBackdropFallback = false;
    this.currentBackdropPath = undefined;
    this.backdropRotationApplied = false;
    this.castImageErrors.clear();
    this.episodeImageErrors.clear();
    this.episodeCache.clear();
    this.episodeRequests.clear();
    this.episodeTitleCache.clear();
    this.seasons = [];
    this.selectedSeason = undefined;
    this.episodes = [];
    this.enrichedEpisodes = [];
    this.loadingSeasons = false;
    this.loadingEpisodes = false;
    this.continueEpisode = undefined;
    this.lastWatchedEpisode = undefined;
    this.highlightedEpisodeId = undefined;

    // 1. Synchronous cache read: check show ID, or cached versions for THIS show
    let cached = this.tmdbEnrichment.getEnrichmentSync(show);
    if (!cached) {
      const cachedVersions = this.versionMatching.getCachedVersions(show, this.releaseYear);
      if (cachedVersions?.length) {
        for (const v of cachedVersions) {
          cached = this.tmdbEnrichment.getEnrichmentSync(v.channel);
          if (cached?.backdropPath) break;
        }
      }
    }

    if (cached) {
      this.loadingEnrichment = false;
      this.applyEnrichment(cached, show.id);
    } else {
      this.loadingEnrichment = true;
    }
    this.updateAmbientBackground();

    if (this.enrichmentTimeout) {
      clearTimeout(this.enrichmentTimeout);
      this.enrichmentTimeout = undefined;
    }
    if (this.loadingEnrichment) {
      this.enrichmentTimeout = setTimeout(() => {
        if (this.loadingEnrichment && enrichmentReqId === this.enrichmentLoadRequestId) {
          this.loadingEnrichment = false;
          this.cdr.markForCheck();
        }
      }, 7000);
    }

    // 2. Cache-first async retrieval / background enrichment
    this.tmdbEnrichment.getEnrichment(show, true, 'high')
      .then((res) => {
        if (enrichmentReqId !== this.enrichmentLoadRequestId) return;
        if (res) {
          this.applyEnrichment(res);
          if (this.selectedSeason) {
            this.reEnrichEpisodes();
          }
        }
      })
      .catch((err) => {
        console.warn('Failed to retrieve enrichment for TV show:', err);
      })
      .finally(() => {
        if (enrichmentReqId === this.enrichmentLoadRequestId) {
          this.loadingEnrichment = false;
          this.cdr.markForCheck();
        }
      });

    // 3. Both paths are local-cache first and independent. Do not make the
    // version selector wait for episode/history work or a provider refresh.
    void this.loadSeasonsAndEpisodes(show);
    void this.loadVersions(show);

    // 4. Load Similar Shows
    this.loadSimilarShows(show);

    this.checkSynopsisLength();
  }

  async loadVersions(show: Channel): Promise<void> {
    const requestId = ++this.versionLoadRequestId;
    this.loadingVersions = true;
    try {
      const vers = await this.versionMatching.findVersions(
        show,
        this.enrichment?.releaseYear,
      );
      if (requestId !== this.versionLoadRequestId) return;
      this.versions = vers;

      // Check for previously saved version preference or playback history
      const preferred = this.versionMatching.getPreferredVersion(
        show,
        this.versions,
        this.enrichment?.releaseYear,
      );

      // Default to English version for titles opened for the first time
      const targetVersion = preferred || this.versionMatching.getDefaultVersion(this.versions, show);

      if (targetVersion) {
        this.selectedVersion = targetVersion;
        this.versions.forEach(
          (v) => (v.isSelected = v.channel.id === targetVersion.channel.id),
        );
        this.cdr.markForCheck();

        // If the target version is different from the currently loaded series,
        // switch to the target series and reload seasons & episodes!
        if (this.show && this.show.id !== targetVersion.channel.id) {
          if (requestId !== this.versionLoadRequestId) return;
          this.show = targetVersion.channel;
          if (
            this.show.media_type == null ||
            Number(this.show.media_type) !== MediaType.serie
          ) {
            this.show.media_type = MediaType.serie;
          }
          this.qualityBadge =
            targetVersion.qualityBadge || extractQuality(targetVersion.channel.name);

          if (!this.enrichment || !this.enrichment.backdropPath) {
            const verCached = this.tmdbEnrichment.getEnrichmentSync(targetVersion.channel);
            if (verCached) {
              this.applyEnrichment(verCached, this.show.id);
            }
          }

          this.seasons = [];
          this.selectedSeason = undefined;
          this.episodes = [];
          this.enrichedEpisodes = [];
          this.continueEpisode = undefined;
          await this.loadSeasonsAndEpisodes(this.show);
        }
      } else {
        this.selectedVersion =
          this.versions.find((v) => v.channel.id === show.id) || this.versions[0];
        this.versions.forEach(
          (v) => (v.isSelected = v.channel.id === this.selectedVersion?.channel.id),
        );
      }

      // Keep the no-default path visible as soon as selection is resolved.
      this.cdr.markForCheck();

      // If we still do not have a TMDB backdrop, check if any discovered version has one in cache
      if (!this.enrichment?.backdropPath && this.versions?.length) {
        for (const v of this.versions) {
          const vCached = this.tmdbEnrichment.getEnrichmentSync(v.channel);
          if (vCached?.backdropPath) {
            this.applyEnrichment(vCached, this.show?.id);
            break;
          }
        }
      }
    } catch (err) {
      if (requestId !== this.versionLoadRequestId) return;
      console.warn('Failed to discover versions for TV show:', err);
      this.versions = [this.versionMatching.channelToVersion(show, true)];
      this.selectedVersion = this.versions[0];
    } finally {
      if (requestId === this.versionLoadRequestId) {
        this.loadingVersions = false;
        this.cdr.markForCheck();
      }
    }
  }

  toggleVersionsMenu(event?: Event): void {
    if (event) event.stopPropagation();
    this.showVersionsMenu = !this.showVersionsMenu;
    if (this.showVersionsMenu) {
      this.showSeasonMenu = false;
    }
  }

  toggleSeasonMenu(event?: Event): void {
    if (event) event.stopPropagation();
    this.showSeasonMenu = !this.showSeasonMenu;
    if (this.showSeasonMenu) {
      this.showVersionsMenu = false;
    }
  }

  closeSeasonMenu(): void {
    this.showSeasonMenu = false;
  }

  async selectVersion(ver: MediaVersion): Promise<void> {
    if (!ver) return;
    this.showVersionsMenu = false;

    // Persist this selection for this grouped title
    this.versionMatching.savePreferredVersion(
      this.show || ver.channel,
      ver,
      this.enrichment?.releaseYear,
    );

    if (this.show?.id === ver.channel.id) return;

    this.show = ver.channel;
    if (
      this.show.media_type == null ||
      Number(this.show.media_type) !== MediaType.serie
    ) {
      this.show.media_type = MediaType.serie;
    }
    this.qualityBadge = ver.qualityBadge || extractQuality(ver.channel.name);
    this.selectedVersion = ver;
    this.versions.forEach(
      (v) => (v.isSelected = v.channel.id === ver.channel.id),
    );

    this.toastr.info(`Selected ${ver.badgeLabel || ver.cleanTitle}`);

    // Preserve existing enrichment for the newly selected version
    if (this.enrichment) {
      this.applyEnrichment(this.enrichment, this.show?.id);
      this.tmdbCache.saveEnrichment({ ...this.enrichment, providerItemId: ver.channel.id });
    } else {
      const verCached = this.tmdbEnrichment.getEnrichmentSync(ver.channel);
      if (verCached) {
        this.applyEnrichment(verCached, this.show?.id);
      }
    }

    // Switch active provider series and reload its own seasons/episodes
    // TMDB enrichment metadata is preserved!
    this.seasons = [];
    this.selectedSeason = undefined;
    this.episodes = [];
    this.enrichedEpisodes = [];
    this.continueEpisode = undefined;
    await this.loadSeasonsAndEpisodes(this.show);
  }

  /** Tracks whether backdrop rotation index has been chosen for the current visit */
  private backdropRotationApplied: boolean = false;

  /**
   * Picks a rotated backdrop path for this detail-screen visit.
   * Rotates through backdropPaths on each new visit, persisting the index and path per TMDB ID.
   * Returns the chosen path or falls back to the single backdropPath.
   */
  private pickRotatedBackdrop(enr: TmdbMediaEnrichment): string | undefined {
    if (!enr.backdropPath) return undefined;
    const paths = enr.backdropPaths;
    if (!paths || paths.length <= 1) {
      this.currentBackdropPath = enr.backdropPath;
      return enr.backdropPath;
    }

    const storageKey = `lh_backdrop_idx_${enr.tmdbId}`;
    const pathKey = `lh_backdrop_path_${enr.tmdbId}`;

    if (!this.backdropRotationApplied) {
      this.backdropRotationApplied = true;
      try {
        const prev = localStorage.getItem(storageKey);
        const prevIdx = prev != null ? parseInt(prev, 10) : -1;
        const nextIdx = (isNaN(prevIdx) || prevIdx < 0) ? 0 : (prevIdx + 1) % paths.length;
        const chosen = paths[nextIdx] || enr.backdropPath;
        localStorage.setItem(storageKey, String(nextIdx));
        localStorage.setItem(pathKey, chosen);
        this.currentBackdropPath = chosen;
        return chosen;
      } catch {
        this.currentBackdropPath = enr.backdropPath;
        return enr.backdropPath;
      }
    }

    if (this.currentBackdropPath) {
      return this.currentBackdropPath;
    }

    try {
      const persistedPath = localStorage.getItem(pathKey);
      if (persistedPath && paths.includes(persistedPath)) {
        this.currentBackdropPath = persistedPath;
        return persistedPath;
      }
      const idx = parseInt(localStorage.getItem(storageKey) || '0', 10);
      const chosen = paths[isNaN(idx) ? 0 : idx % paths.length] || enr.backdropPath;
      this.currentBackdropPath = chosen;
      return chosen;
    } catch {
      this.currentBackdropPath = enr.backdropPath;
      return enr.backdropPath;
    }
  }

  applyEnrichment(enr: TmdbMediaEnrichment, forShowId?: number): void {
    if (forShowId != null && this.show?.id !== forShowId) return;
    this.enrichment = enr;
    this.loadingEnrichment = false;

    const chosenBackdrop = this.pickRotatedBackdrop(enr);
    if (chosenBackdrop) {
      this.currentBackdropPath = chosenBackdrop;
      // Prioritize w1280 first for instantaneous progressive loading, fall back to original
      const backdropUrl = getTmdbBackdropUrl(chosenBackdrop, 'w1280') || getTmdbBackdropUrl(chosenBackdrop, 'original');
      if (backdropUrl) {
        this.backdropUrl = backdropUrl;
        this.isBackdropFallback = false;
        this.backdropError = false;
        this.updateAmbientBackground();
      }
    }

    if (enr.posterPath) {
      const p = getTmdbPosterUrl(enr.posterPath, 'w500');
      if (p) {
        this.posterUrl = p;
        this.imageError = false;
      }
    }

    if (enr.overview) {
      this.synopsis = enr.overview;
      this.checkSynopsisLength();
    }

    if (enr.releaseYear) {
      this.releaseYear = enr.releaseYear;
    }

    if (enr.releaseDate) {
      this.firstAirDate = enr.releaseDate;
    }

    if (enr.lastAirDate) {
      this.lastAirDate = enr.lastAirDate;
    }

    if (enr.status) {
      this.status = enr.status;
    }

    if (enr.creator) {
      this.creator = enr.creator;
    }

    if (enr.originalLanguage) {
      this.originalLanguage = enr.originalLanguage;
    }

    if (enr.numberOfSeasons) {
      this.numberOfSeasons = enr.numberOfSeasons;
    }

    if (enr.numberOfEpisodes) {
      this.numberOfEpisodes = enr.numberOfEpisodes;
    }

    if (enr.genres && enr.genres.length > 0) {
      this.genres = enr.genres;
    }

    if (enr.rating) {
      this.rating = enr.rating;
      this.voteCount = enr.voteCount;
    }

    if (enr.cast && enr.cast.length > 0) {
      this.cast = enr.cast;
    }

    if (enr.trailers && enr.trailers.length > 0) {
      this.trailer = enr.trailers[0];
      const ytUrl = `https://www.youtube-nocookie.com/embed/${this.trailer.key}?autoplay=1`;
      this.safeTrailerUrl = this.sanitizer.bypassSecurityTrustResourceUrl(ytUrl);
    }
    this.updateAmbientBackground();
    this.cdr.markForCheck();
  }

  private checkSynopsisLength(): void {
    if (this.synopsis && this.synopsis.length > 280) {
      this.isSynopsisLong = true;
    } else {
      this.isSynopsisLong = false;
      this.isSynopsisExpanded = true;
    }
  }

  toggleSynopsis(): void {
    this.isSynopsisExpanded = !this.isSynopsisExpanded;
  }

  formatRuntime(mins?: number): string | undefined {
    if (!mins || mins <= 0) return undefined;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }

  getActorPhoto(path?: string): string | undefined {
    return getTmdbProfileUrl(path, 'w185');
  }

  onCastImageError(actorId: number): void {
    this.castImageErrors.add(actorId);
  }

  isCastImageBroken(actorId: number): boolean {
    return this.castImageErrors.has(actorId);
  }

  onEpisodeImageError(episodeId: number): void {
    this.episodeImageErrors.add(episodeId);
  }

  isEpisodeImageBroken(episodeId: number): boolean {
    return this.episodeImageErrors.has(episodeId);
  }

  // -------------------------------------------------------------
  // Seasons & Episodes Loading
  // -------------------------------------------------------------
  async loadSeasonsAndEpisodes(show: Channel): Promise<void> {
    const requestId = ++this.seasonLoadRequestId;
    this.loadingSeasons = true;
    try {
      const seriesId = parseInt(show.url || `${show.id}`, 10);
      const sourceIds = show.source_id
        ? [show.source_id]
        : Array.from(this.memory.Sources.keys());

      const seasonFilters: Filters = {
        source_ids: sourceIds,
        series_id: seriesId,
        media_types: [MediaType.serie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };
      const historyFilters: Filters = {
        source_ids: sourceIds,
        series_id: seriesId,
        media_types: [MediaType.movie],
        view_type: ViewMode.History,
        use_keywords: false,
        page: 1,
        sort: 0,
      };

      const [cachedSeasons, watchedEpisodes] = await Promise.all([
        invoke('search', { filters: seasonFilters }) as Promise<Channel[]>,
        (invoke('search', { filters: historyFilters }) as Promise<Channel[]>).catch((err) => {
          console.warn('Failed to query watch history for series:', err);
          return [];
        }),
      ]);
      if (this.show !== show || requestId !== this.seasonLoadRequestId) return;

      let seasonChannels = cachedSeasons || [];
      if (seasonChannels.length === 0 && !this.memory.SeriesRefreshed.has(show.id!)) {
        this.memory.SeriesRefreshed.set(show.id!, true);
        try {
          await invoke('get_episodes', { channel: show });
          if (this.show !== show || requestId !== this.seasonLoadRequestId) return;
          seasonChannels = (await invoke('search', { filters: seasonFilters })) as Channel[];
        } catch (e) {
          console.warn('Failed to get_episodes from Xtream:', e);
        }
      }

      this.seasons = seasonChannels || [];

      let lastWatchedEp: Channel | undefined = watchedEpisodes?.[0];
      if (!lastWatchedEp) {
        try {
          const globalHistory = (await invoke('search', {
            filters: {
              source_ids: sourceIds,
              media_types: [MediaType.movie],
              view_type: ViewMode.History,
              use_keywords: false,
              page: 1,
              sort: 0,
            },
          })) as Channel[];
          if (this.show !== show || requestId !== this.seasonLoadRequestId) return;
          const cleanTitleLower = this.cleanTitle.toLowerCase();
          lastWatchedEp = globalHistory?.find((h) => {
            if (h.series_id != null && h.series_id === seriesId) return true;
            const hClean = cleanMediaTitle(h.name).toLowerCase();
            return hClean.startsWith(cleanTitleLower) || cleanTitleLower.startsWith(hClean);
          });
        } catch (e) {
          console.warn('Failed to query watch history for series:', e);
        }
      }

      if (this.show !== show || requestId !== this.seasonLoadRequestId) return;
      this.lastWatchedEpisode = lastWatchedEp;

      let initialSeason: Channel | undefined;
      if (lastWatchedEp && this.seasons.length > 0) {
        if (lastWatchedEp.season_id != null) {
          initialSeason = this.seasons.find((s) => s.id === lastWatchedEp!.season_id);
        }

        if (!initialSeason) {
          const sMatch =
            lastWatchedEp.name?.match(/\bS(\d{1,2})\s*E\d{1,2}\b/i) ||
            lastWatchedEp.name?.match(/(\d+)x(\d+)/i) ||
            lastWatchedEp.name?.match(/\bSeason\s*(\d{1,2})\b/i);
          if (sMatch) {
            const sNum = parseInt(sMatch[1], 10);
            initialSeason = this.seasons.find((s, idx) => {
              const numMatch = s.name?.match(/(\d+)/);
              const num = numMatch ? parseInt(numMatch[1], 10) : idx + 1;
              return num === sNum;
            });
          }
        }
      }

      if (!initialSeason && this.seasons.length > 0) {
        initialSeason = this.seasons[0];
      }

      if (initialSeason) {
        await this.selectSeason(initialSeason, lastWatchedEp);
      }
    } catch (err) {
      if (this.show !== show || requestId !== this.seasonLoadRequestId) return;
      console.error('Failed to load seasons:', err);
    } finally {
      if (this.show === show && requestId === this.seasonLoadRequestId) {
        this.loadingSeasons = false;
        this.cdr.markForCheck();
      }
    }
  }

  async selectSeason(season: Channel, targetEpisode?: Channel): Promise<void> {
    const requestId = ++this.episodeLoadRequestId;
    const show = this.show;
    if (!show) return;
    this.showSeasonMenu = false;
    this.selectedSeason = season;
    this.loadingEpisodes = true;
    this.episodeImageErrors.clear();

    try {
      const seriesId = this.getSeriesIdNumber() || parseInt(show.url || `${show.id}`, 10);
      const sourceIds = show.source_id
        ? [show.source_id]
        : Array.from(this.memory.Sources.keys());

      // Extract season number from name: e.g. "Season 2" -> 2
      const sMatch = season.name?.match(/(\d+)/);
      this.selectedSeasonNumber = sMatch ? parseInt(sMatch[1], 10) : 1;
      const seasonNumber = this.selectedSeasonNumber;

      // Query episodes from SQLite for this season
      const filters: Filters = {
        source_ids: sourceIds,
        series_id: seriesId,
        season: season.id, // season.id is season_id in SQLite
        media_types: [MediaType.movie], // In SQLite channels table, episodes have media_type = 1
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };

      const cacheKey = `${show.source_id ?? ''}:${seriesId}:${season.id ?? ''}`;
      const episodeChannels = await this.getCachedEpisodes(cacheKey, filters);
      if (this.show !== show || requestId !== this.episodeLoadRequestId) return;
      this.episodes = episodeChannels || [];
      this.mapEnrichedEpisodes();
      this.updateContinueEpisode(targetEpisode);
      this.loadingEpisodes = false;

      if (this.enrichment?.tmdbId) {
        const tmdbId = this.enrichment.tmdbId;
        void this.tmdbEnrichment.getSeasonDetails(tmdbId, seasonNumber).then(
          (tmdbSeason: TmdbSeasonDetail | undefined) => {
            if (this.show === show && requestId === this.episodeLoadRequestId && tmdbSeason) {
              this.mapEnrichedEpisodes(tmdbSeason);
              this.updateContinueEpisode(targetEpisode);
              this.cdr.markForCheck();
            }
          },
          (err) => console.warn('Failed to enrich season episodes:', err),
        );
      }

      // Scroll active season and highlighted episode into view
      setTimeout(() => {
        if (this.show !== show || requestId !== this.episodeLoadRequestId) return;
        const activeSeasonBtn = this.elementRef.nativeElement.querySelector('.season-pill-btn.active');
        if (activeSeasonBtn) {
          activeSeasonBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
        const highlightedCard = this.elementRef.nativeElement.querySelector('.episode-card.highlighted');
        if (highlightedCard) {
          highlightedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 100);
    } catch (err) {
      if (this.show !== show || requestId !== this.episodeLoadRequestId) return;
      console.error('Failed to load episodes for season:', err);
      this.enrichedEpisodes = [];
    } finally {
      if (this.show === show && requestId === this.episodeLoadRequestId) {
        this.loadingEpisodes = false;
        this.cdr.markForCheck();
      }
    }
  }

  private getSeriesIdNumber(): number | undefined {
    if (this.show?.series_id) return this.show.series_id;
    if (this.show?.url && /^\d+$/.test(this.show.url.trim())) {
      return parseInt(this.show.url.trim(), 10);
    }
    return this.show?.id;
  }

  private getCachedEpisodes(cacheKey: string, filters: Filters): Promise<Channel[]> {
    const cached = this.episodeCache.get(cacheKey);
    if (cached) return Promise.resolve(cached);

    const inFlight = this.episodeRequests.get(cacheKey);
    if (inFlight) return inFlight;

    const request = (invoke('search', { filters }) as Promise<Channel[]>)
      .then((episodes) => {
        const result = episodes || [];
        this.episodeCache.set(cacheKey, result);
        return result;
      })
      .finally(() => this.episodeRequests.delete(cacheKey));
    this.episodeRequests.set(cacheKey, request);
    return request;
  }

  private mapEnrichedEpisodes(tmdbSeason?: TmdbSeasonDetail): void {
    const tmdbEpisodesByNumber = tmdbSeason
      ? new Map(tmdbSeason.episodes?.map((episode) => [episode.episodeNumber, episode]) || [])
      : undefined;
    const selectedSeasonId = this.selectedSeason?.id;
    const showSourceId = this.show?.source_id;
    const seriesId = this.getSeriesIdNumber();
    this.enrichedEpisodes = this.episodes.map((epChannel, index) => {
      const epNum = epChannel.episode_num ?? this.extractEpisodeNumber(epChannel.name, index + 1);
      const tmdbEp = tmdbEpisodesByNumber?.get(epNum);

      const cleanProviderTitle = this.cleanEpisodeTitle(epChannel.name);
      const title = tmdbEp?.name ? `${epNum}. ${tmdbEp.name}` : (cleanProviderTitle || `Episode ${epNum}`);
      const stillUrl = tmdbEp?.stillPath
        ? getTmdbStillUrl(tmdbEp.stillPath, 'w300')
        : epChannel.image;

      const cleanEpChannel: Channel = {
        ...epChannel,
        media_type: MediaType.movie,
        season_id: epChannel.season_id || selectedSeasonId,
        episode_num: epNum,
        source_id: epChannel.source_id || showSourceId,
        series_id: epChannel.series_id || seriesId,
        favorite: !!epChannel.favorite,
      };

      return {
        channel: cleanEpChannel,
        episodeNum: epNum,
        seasonNum: this.selectedSeasonNumber,
        title,
        overview: tmdbEp?.overview,
        stillUrl,
        airDate: tmdbEp?.airDate,
        runtimeText: this.formatRuntime(tmdbEp?.runtime),
        rating: tmdbEp?.voteAverage,
        isWatched: (epChannel as any).last_watched != null,
      };
    });
  }

  private async reEnrichEpisodes(): Promise<void> {
    if (!this.enrichment?.tmdbId || this.episodes.length === 0) return;
    const currentEpisodeRequestId = this.episodeLoadRequestId;
    const currentShowId = this.show?.id;
    try {
      const tmdbSeason = await this.tmdbEnrichment.getSeasonDetails(
        this.enrichment.tmdbId,
        this.selectedSeasonNumber,
      );
      if (this.show?.id !== currentShowId || this.episodeLoadRequestId !== currentEpisodeRequestId) return;
      if (tmdbSeason) {
        this.mapEnrichedEpisodes(tmdbSeason);
        this.updateContinueEpisode();
      }
    } catch {}
  }

  extractEpisodeNumber(rawName?: string, fallback: number = 1): number {
    if (!rawName) return fallback;
    const match = rawName.match(/\b(?:e|ep|episode)[\s._-]*(\d+)\b/i) || rawName.match(/(\d+)x(\d+)/i);
    if (match) {
      return parseInt(match[2] || match[1], 10);
    }
    return fallback;
  }

  cleanEpisodeTitle(rawName?: string): string {
    if (!rawName) return '';
    const cached = this.episodeTitleCache.get(rawName);
    if (cached != null) return cached;
    let clean = cleanMediaTitle(rawName);

    // Strip series name prefix if present
    if (this.cleanTitle && clean.toLowerCase().startsWith(this.cleanTitle.toLowerCase())) {
      clean = clean.substring(this.cleanTitle.length).trim();
    }

    // Strip season/episode markers like "S01E02 -", "S1 E2 :", "1x02 -"
    clean = clean.replace(/^[-\s]*\bS\d{1,2}\s*E\d{1,2}\b[-\s:]*/i, '');
    clean = clean.replace(/^[-\s]*\b\d{1,2}x\d{1,2}\b[-\s:]*/i, '');
    clean = clean.replace(/^[-\s]*\bEpisode\s*\d{1,3}\b[-\s:]*/i, '');
    clean = clean.replace(/^[-*#~_+=|:–—\s]+/, '');

    const result = clean.trim() || cleanMediaTitle(rawName);
    this.episodeTitleCache.set(rawName, result);
    return result;
  }

  private updateContinueEpisode(targetEpisode?: Channel): void {
    if (this.enrichedEpisodes.length === 0) {
      if (!this.continueEpisode) {
        this.continueEpisode = undefined;
      }
      this.highlightedEpisodeId = undefined;
      return;
    }

    const candidate = targetEpisode || this.lastWatchedEpisode;

    if (candidate) {
      const isCandidateCompleted = this.embeddedPlayer.isEpisodeCompleted(candidate);
      const matchedIdx = this.enrichedEpisodes.findIndex(
        (ep) =>
          ep.channel.id === candidate.id ||
          (candidate.episode_num != null &&
            ep.episodeNum === candidate.episode_num &&
            (candidate.season_id == null || candidate.season_id === this.selectedSeason?.id))
      );
      if (matchedIdx !== -1) {
        if (!isCandidateCompleted) {
          const matched = this.enrichedEpisodes[matchedIdx];
          this.continueEpisode = matched;
          this.highlightedEpisodeId = matched.channel.id;
          return;
        } else if (matchedIdx + 1 < this.enrichedEpisodes.length) {
          const nextEp = this.enrichedEpisodes[matchedIdx + 1];
          this.continueEpisode = nextEp;
          this.highlightedEpisodeId = nextEp.channel.id;
          return;
        }
      }
      // If candidate belongs to another season and this.continueEpisode is already watched,
      // retain this.continueEpisode for hero play action, but clear highlightedEpisodeId for current season
      if (this.continueEpisode?.isWatched) {
        this.highlightedEpisodeId = undefined;
        return;
      }
    }

    // Check if any episode in current season was watched (has last_watched)
    const watchedInSeason = this.enrichedEpisodes.filter((ep) => ep.isWatched);
    if (watchedInSeason.length > 0) {
      const lastWatchedInSeason = watchedInSeason[watchedInSeason.length - 1];
      const lastIdx = this.enrichedEpisodes.indexOf(lastWatchedInSeason);
      const isCompleted = this.embeddedPlayer.isEpisodeCompleted(lastWatchedInSeason.channel);
      if (isCompleted && lastIdx !== -1 && lastIdx + 1 < this.enrichedEpisodes.length) {
        const nextEp = this.enrichedEpisodes[lastIdx + 1];
        this.continueEpisode = nextEp;
        this.highlightedEpisodeId = nextEp.channel.id;
        return;
      }
      this.continueEpisode = lastWatchedInSeason;
      this.highlightedEpisodeId = lastWatchedInSeason.channel.id;
      return;
    }

    // Fallback: If nothing watched in this season, find first unwatched or first episode
    const firstUnwatched = this.enrichedEpisodes.find((ep) => !ep.isWatched);
    this.continueEpisode = firstUnwatched || this.enrichedEpisodes[0];
    this.highlightedEpisodeId = undefined;
  }

  isEpisodeHighlighted(ep: EnrichedEpisode): boolean {
    if (this.highlightedEpisodeId && ep.channel?.id === this.highlightedEpisodeId) {
      return true;
    }
    if (
      this.continueEpisode?.isWatched &&
      this.continueEpisode.seasonNum === ep.seasonNum &&
      this.continueEpisode.episodeNum === ep.episodeNum
    ) {
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------
  // Playback & Favorites
  // -------------------------------------------------------------
  async playEpisode(enrichedEp: EnrichedEpisode): Promise<void> {
    if (!enrichedEp.channel || this.isStartingPlayback) return;
    this.isStartingPlayback = true;

    try {
      const epChannel = enrichedEp.channel;
      let playChannel: Channel = {
        ...epChannel,
        id: epChannel.id,
        name: epChannel.name,
        url: epChannel.url,
        media_type: MediaType.movie,
        season_id: epChannel.season_id || this.selectedSeason?.id,
        episode_num: epChannel.episode_num ?? enrichedEp.episodeNum,
        source_id: epChannel.source_id || this.show?.source_id,
        series_id: epChannel.series_id || this.getSeriesIdNumber(),
        favorite: !!epChannel.favorite,
      };

      if (!playChannel.url || !playChannel.source_id) {
        try {
          const results = (await invoke('search', {
            filters: {
              source_ids: playChannel.source_id ? [playChannel.source_id] : Array.from(this.memory.Sources.keys()),
              view_type: ViewMode.All,
              media_types: [MediaType.serie],
              query: playChannel.name,
              page: 1,
              sort: SortType.provider,
              use_keywords: false,
            },
          })) as Channel[];
          const fresh = results?.find((c) => c.id === playChannel.id);
          if (fresh) {
            playChannel = {
              ...fresh,
              media_type: MediaType.movie,
              season_id: playChannel.season_id,
              episode_num: playChannel.episode_num,
              series_id: playChannel.series_id,
              favorite: !!fresh.favorite,
            };
          }
        } catch (err) {
          console.warn('Failed to query fresh episode record:', err);
        }
      }

      invoke('add_last_watched', { id: playChannel.id }).catch(console.error);

      // Persist this played series version preference
      if (this.show && this.selectedVersion) {
        this.versionMatching.savePreferredVersion(
          this.show,
          this.selectedVersion,
          this.enrichment?.releaseYear,
        );
      }

      // Immediately mark as watched in UI
      enrichedEp.isWatched = true;
      (enrichedEp.channel as any).last_watched = Date.now();
      this.lastWatchedEpisode = playChannel;
      this.highlightedEpisodeId = playChannel.id;
      this.continueEpisode = enrichedEp;

      this.activePlayingEpisode = playChannel;

      // Close episode switcher if open (do not open during embedded playback)
      if (this.episodeSwitcher?.isOpen) {
        this.episodeSwitcher.closePanel();
      }

      // Format overlay title: "<Series> - S<season>E<episode>: <Episode title>"
      const seriesName = sanitizeShowTitle(this.show?.name || this.cleanTitle);
      const label = formatPlayerEpisodeLabel(seriesName, enrichedEp.title, enrichedEp.episodeNum, enrichedEp.seasonNum);
      const overlayTitle = label.full;

      // Ensure the season containing this episode is loaded so this.enrichedEpisodes matches enrichedEp.seasonNum
      if (this.selectedSeasonNumber !== enrichedEp.seasonNum && this.seasons.length > 0) {
        const targetSeason = this.seasons.find((s, idx) => {
          const sMatch = s.name?.match(/(\d+)/);
          const sNum = sMatch ? parseInt(sMatch[1], 10) : idx + 1;
          return sNum === enrichedEp.seasonNum;
        });
        if (targetSeason) {
          await this.selectSeason(targetSeason);
        }
      }

      this.cdr.detectChanges();

      await this.embeddedPlayer.startPlayer(playChannel, 'tv-video-canvas', {
        title: overlayTitle,
        mode: 'episode',
        seriesChannel: this.show,
        seriesTitle: seriesName,
        seasons: this.seasons.map((s, idx) => {
          const sMatch = s.name?.match(/(\d+)/);
          return {
            id: s.id!,
            seasonNum: sMatch ? parseInt(sMatch[1], 10) : idx + 1,
            name: s.name || `Season ${idx + 1}`,
          };
        }),
        currentSeasonNum: enrichedEp.seasonNum,
        currentEpisodeNum: enrichedEp.episodeNum,
        episodes: this.enrichedEpisodes.map((e) => ({
          id: e.channel.id!,
          channel: e.channel,
          episodeNum: e.episodeNum,
          seasonNum: e.seasonNum,
          title: sanitizeEpisodeTitle(e.title, seriesName, e.episodeNum, e.seasonNum) || `Episode ${e.episodeNum}`,
          stillUrl: e.stillUrl,
          isWatched: e.isWatched,
          isCurrent: e.channel.id === playChannel.id,
        })),
        onSwitchEpisode: (ch: Channel) => this.onSwitchEpisode(ch),
      });
    } catch (e) {
      console.error('TV episode playback error:', e);
      this.toastr.error('Failed to start episode playback');
      this.error.handleError(e, 'Failed to start episode playback');
    } finally {
      this.isStartingPlayback = false;
      this.activePlayingEpisode = undefined;
      this.cdr.detectChanges();
    }
  }

  async onSwitchEpisode(channel: Channel): Promise<void> {
    if (this.activePlayingEpisode?.id && this.activePlayingEpisode.source_id != null) {
      try {
        await invoke('cancel_play', {
          sourceId: this.activePlayingEpisode.source_id,
          channelId: this.activePlayingEpisode.id,
        });
      } catch (e) {
        console.warn('Failed to cancel previous episode:', e);
      }
    }

    let targetEnriched = this.enrichedEpisodes.find(
      (e) => e.channel.id === channel.id,
    );
    if (!targetEnriched) {
      const epNum = channel.episode_num || this.embeddedPlayer.extractEpisodeNumber(channel.name) || 1;
      const epSeason = this.embeddedPlayer.extractSeasonNumber(channel) || this.selectedSeasonNumber;
      targetEnriched = {
        channel,
        episodeNum: epNum,
        seasonNum: epSeason,
        title: channel.name || `Episode ${epNum}`,
      };
    }

    this.playEpisode(targetEnriched);
  }

  onEpisodeSwitcherClose(): void {
    // No-op, panel closes itself
  }

  resumeEpisode(): void {
    if (this.continueEpisode) {
      this.playEpisode(this.continueEpisode);
    } else if (this.enrichedEpisodes.length > 0) {
      this.playEpisode(this.enrichedEpisodes[0]);
    }
  }


  async toggleFavorite(event?: Event): Promise<void> {
    if (event) event.stopPropagation();
    if (!this.show) return;

    const wasFavorite = this.show.favorite;
    const call = wasFavorite ? 'unfavorite_channel' : 'favorite_channel';

    try {
      await invoke(call, { channelId: this.show.id });
      this.show.favorite = !wasFavorite;
    } catch (err) {
      console.error('Failed to update favorite status:', err);
      this.toastr.error('Failed to update favorite status');
    }
  }

  // -------------------------------------------------------------
  // Trailer Modal
  // -------------------------------------------------------------
  openTrailer(): void {
    if (this.trailer?.key) {
      const ytUrl = `https://www.youtube-nocookie.com/embed/${this.trailer.key}?autoplay=1`;
      this.safeTrailerUrl = this.sanitizer.bypassSecurityTrustResourceUrl(ytUrl);
      this.showTrailerModal = true;
    }
  }

  closeTrailer(): void {
    this.showTrailerModal = false;
    this.safeTrailerUrl = undefined;
  }

  openTrailerExternal(): void {
    if (this.trailer?.key) {
      const url = `https://www.youtube.com/watch?v=${this.trailer.key}`;
      window.open(url, '_blank');
    }
  }

  // -------------------------------------------------------------
  // More Like This
  // -------------------------------------------------------------
  async loadSimilarShows(show: Channel): Promise<void> {
    const requestId = ++this.similarLoadRequestId;
    this.loadingSimilar = true;
    try {
      const sourceIds = show.source_id
        ? [show.source_id]
        : Array.from(this.memory.Sources.keys());

      // Query local SQLite for series in same category
      const filters: Filters = {
        source_ids: sourceIds,
        group_id: show.group_id,
        media_types: [MediaType.serie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };

      let results = (await invoke('search', { filters })) as Channel[];
      if (requestId !== this.similarLoadRequestId) return;
      let filtered = (results || []).filter((s) => s.id !== show.id);

      // If category has few items, fallback to general series
      if (filtered.length < 4) {
        const fallbackFilters: Filters = {
          source_ids: sourceIds,
          media_types: [MediaType.serie],
          view_type: ViewMode.All,
          use_keywords: false,
          page: 1,
          sort: SortType.provider,
        };
        const fallbackRes = (await invoke('search', { filters: fallbackFilters })) as Channel[];
        if (requestId !== this.similarLoadRequestId) return;
        const extra = (fallbackRes || []).filter(
          (s) => s.id !== show.id && !filtered.some((f) => f.id === s.id),
        );
        filtered = filtered.concat(extra);
      }

      this.similarShows = filtered.slice(0, 18);
    } catch (e) {
      if (requestId !== this.similarLoadRequestId) return;
      console.warn('Failed to load similar shows', e);
      this.similarShows = [];
    } finally {
      if (requestId === this.similarLoadRequestId) {
        this.loadingSimilar = false;
        this.cdr.markForCheck();
      }
    }
  }

  async onPlaySimilarClick(show: Channel, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.embeddedPlayer.isPlayingEmbedded) {
      await this.embeddedPlayer.stopPlayer();
    }
    await this.embeddedPlayer.playMediaDirectly(show, 'tv-video-canvas');
  }

  selectSimilarShow(channel: Channel): void {
    if (this.embeddedPlayer.isPlayingEmbedded) {
      this.embeddedPlayer.stopPlayer().catch(console.warn);
    }
    this.tvDetailService.setSelectedShow(channel);
    this.initShow(channel);
  }

  scrollSimilar(direction: 'left' | 'right'): void {
    if (!this.similarTrack) return;
    const track = this.similarTrack.nativeElement;
    const scrollAmount = track.clientWidth * 0.75;
    track.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  }

  getSimilarArtwork(channel: Channel): string | undefined {
    const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
    if (cached?.posterPath) {
      return getTmdbPosterUrl(cached.posterPath, 'w500');
    }
    return channel.image;
  }

  getSimilarYear(channel: Channel): string | undefined {
    const cached = this.tmdbEnrichment.getEnrichmentSync(channel);
    return cached?.releaseYear || extractYear(channel.name);
  }

  getSimilarTitle(raw?: string): string {
    return cleanMediaTitle(raw);
  }

  onImageError(): void {
    this.imageError = true;
    if (this.show?.image && this.posterUrl !== this.show.image) {
      this.posterUrl = this.show.image;
      this.imageError = false;
    }
  }

  onBackdropError(): void {
    if (this.backdropUrl && !this.isBackdropFallback) {
      const path = this.currentBackdropPath || this.enrichment?.backdropPath;
      if (path && this.backdropUrl.includes('/w1280/')) {
        const orig = getTmdbBackdropUrl(path, 'original');
        if (orig && orig !== this.backdropUrl) {
          this.backdropUrl = orig;
          this.isBackdropFallback = true;
          this.backdropError = false;
          this.updateAmbientBackground();
          return;
        }
      }
    }
    this.backdropError = true;
    this.backdropUrl = undefined;
    this.updateAmbientBackground();
  }

  goBack(): void {
    if (this.embeddedPlayer.isPlayingEmbedded) {
      this.embeddedPlayer.stopPlayer().catch(console.warn);
    }
    if (window.history.length > 1) {
      this.location.back();
    } else {
      this.router.navigateByUrl('');
    }
  }

}
