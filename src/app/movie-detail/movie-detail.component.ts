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
import { emit, listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ToastrService } from 'ngx-toastr';
import { Subscription } from 'rxjs';
import { ErrorService } from '../error.service';
import { MemoryService } from '../memory.service';
import { Channel } from '../models/channel';
import { Filters } from '../models/filters';
import { MediaType } from '../models/mediaType';
import { SortType } from '../models/sortType';
import { ViewMode } from '../models/viewMode';
import { TmdbCastMember, TmdbMediaEnrichment, TmdbVideo } from '../models/tmdb';
import { MediaVersion } from '../models/version';
import { EmbeddedPlayerService } from '../services/embedded-player.service';
import { AmbientBackgroundService } from '../services/ambient-background.service';
import { MovieDetailService } from '../services/movie-detail.service';
import { TmdbCacheService } from '../services/tmdb-cache.service';
import { TmdbConfigService } from '../services/tmdb-config.service';
import { TmdbEnrichmentService } from '../services/tmdb-enrichment.service';
import { VersionMatchingService } from '../services/version-matching.service';
import { isInputFocused } from '../utils';
import {
  cleanMediaTitle,
  extractQuality,
  extractYear,
  selectSynopsis,
} from '../utils/media-presentation';
import {
  getTmdbBackdropUrl,
  getTmdbPosterUrl,
  getTmdbProfileUrl,
} from '../utils/tmdb-image';

@Component({
  selector: 'app-movie-detail',
  templateUrl: './movie-detail.component.html',
  styleUrl: './movie-detail.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MovieDetailComponent implements OnInit, AfterViewInit, OnDestroy {
  @HostBinding('class.skeleton-animations-paused')
  skeletonAnimationsPaused = document.hidden;

  movie?: Channel;
  enrichment?: TmdbMediaEnrichment;

  cleanTitle: string = '';
  backdropUrl?: string;
  currentBackdropPath?: string;

  private updateAmbientBackground(): void {
    const art = (!this.backdropError && this.backdropUrl) ? this.backdropUrl : (this.posterUrl || this.movie?.image);
    if (art) {
      this.ambientBackground.setArtwork(art, `movie-${this.movie?.id}`);
    } else {
      this.ambientBackground.resetToDefault(`movie-${this.movie?.id}`);
    }
  }
  posterUrl?: string;
  synopsis?: string;
  isSynopsisLong: boolean = false;
  isSynopsisExpanded: boolean = false;
  releaseYear?: string;
  runtimeText?: string;
  genres: string[] = [];
  qualityBadge?: string;
  rating?: number;
  voteCount?: number;
  director?: string;
  cast: TmdbCastMember[] = [];
  trailer?: TmdbVideo;
  safeTrailerUrl?: SafeResourceUrl;
  showTrailerModal: boolean = false;

  // Versions state
  versions: MediaVersion[] = [];
  selectedVersion?: MediaVersion;
  showVersionsMenu: boolean = false;
  loadingVersions: boolean = false;
  hasWatchProgress: boolean = false;

  similarMovies: Channel[] = [];
  loadingSimilar: boolean = false;
  loadingEnrichment: boolean = false;
  skeletonCastPlaceholders: number[] = [1, 2, 3, 4, 5, 6, 7];
  skeletonSimilarPlaceholders: number[] = [1, 2, 3, 4, 5, 6];
  private enrichmentTimeout?: any;
  isStartingPlayback: boolean = false;
  imageError: boolean = false;
  backdropError: boolean = false;
  isBackdropFallback: boolean = false;
  castImageErrors: Set<number> = new Set();

  // Embedded player state (Step 2 POC & Step 4 Controls)
  isPlayingEmbedded: boolean = false;
  isFullscreen: boolean = false;
  private unlistenStopped?: UnlistenFn;
  private unlistenFullscreen?: UnlistenFn;
  private unlistenSyncBounds?: UnlistenFn;
  private unlistenAspect?: UnlistenFn;
  private videoResizeObserver: ResizeObserver | null = null;
  private syncScheduled: boolean = false;
  private boundScrollHandler = () => this.syncVideoBounds();

  private subs: Subscription[] = [];
  private enrichmentLoadRequestId = 0;
  private versionLoadRequestId = 0;
  private similarLoadRequestId = 0;
  @ViewChild('similarTrack') similarTrack?: ElementRef<HTMLDivElement>;

  constructor(
    private movieDetailService: MovieDetailService,
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

  private savedScrollTop: number = 0;
  private savedMainScrollTop: number = 0;

  private saveScrollPosition(): void {
    try {
      this.savedScrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
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

  ngOnInit(): void {
    this.resetScrollPosition();
    const selected = this.movieDetailService.getSelectedMovie();
    if (!selected) {
      this.goBack();
      return;
    }

    this.initMovie(selected);

    // Listen for background TMDB updates
    this.subs.push(
      this.tmdbEnrichment.enrichmentUpdated$.subscribe((updated) => {
        if (!this.movie) return;

        const matchesProviderId = Number(updated.providerItemId) === Number(this.movie.id);
        const matchesVersion =
          this.versions?.length > 0 &&
          this.versions.some((v) => Number(v.channel.id) === Number(updated.providerItemId));
        const matchesTmdbId = !!this.enrichment?.tmdbId && updated.tmdbId === this.enrichment.tmdbId;
        const currentCleanTitle = cleanMediaTitle(this.movie.name).toLowerCase();
        const updatedNormTitle = (updated.normalizedTitle || '').toLowerCase();
        const matchesTitle =
          currentCleanTitle.length > 0 &&
          currentCleanTitle === updatedNormTitle &&
          (!this.releaseYear || !updated.releaseYear || this.releaseYear === updated.releaseYear);

        const isMatch = matchesProviderId || matchesVersion || matchesTmdbId || matchesTitle;

        if (isMatch) {
          this.loadingEnrichment = false;
          this.applyEnrichment(updated, this.movie.id);
          if (this.movie?.id && Number(updated.providerItemId) !== Number(this.movie.id)) {
            this.tmdbCache.saveEnrichment({ ...updated, providerItemId: this.movie.id });
          }
        }
      }),
    );

    // Listen for embedded player stopped event (from overlay or MPV EOF)
    listen('embedded-poc-stopped', () => {
      this.cleanupVideoResizeObserver();
      this.isPlayingEmbedded = false;
      document.body.classList.remove('theater-mode-active');
      document.body.classList.remove('fullscreen-player-active');
      if (this.isFullscreen) {
        this.isFullscreen = false;
      }
      this.restoreScrollPosition();
      this.updateWatchProgress();
      this.cdr.detectChanges();
    }).then((un) => (this.unlistenStopped = un));

    // Listen for fullscreen state changes from the Rust backend
    listen('player-fullscreen-changed', (event: any) => {
      this.applyFullscreenState(!!event.payload);
    }).then((un) => (this.unlistenFullscreen = un));

    // Listen for video bounds sync triggers from backend (e.g. window resize/restore)
    listen('sync-video-bounds', () => {
      this.syncVideoBounds();
    }).then((un) => (this.unlistenSyncBounds = un));

    // Listen for video display aspect ratio changes from MPV backend
    listen('video-aspect-changed', (event: any) => {
      const aspect = typeof event.payload === 'number' ? event.payload : parseFloat(event.payload);
      if (aspect && !isNaN(aspect) && isFinite(aspect) && aspect > 0) {
        this.updateVideoAspect(aspect);
      }
    }).then((un) => (this.unlistenAspect = un));
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
    this.subs.forEach((s) => s.unsubscribe());
    if (this.enrichmentTimeout) {
      clearTimeout(this.enrichmentTimeout);
      this.enrichmentTimeout = undefined;
    }
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
    this.cleanupVideoResizeObserver();
    document.body.classList.remove('theater-mode-active');
    document.body.classList.remove('fullscreen-player-active');
    if (this.isFullscreen) {
      this.isFullscreen = false;
      invoke('set_main_window_fullscreen', { fullscreen: false }).catch(console.warn);
    }
    if (this.isPlayingEmbedded) {
      invoke('stop_embedded_poc').catch(console.error);
      this.isPlayingEmbedded = false;
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    if (this.isPlayingEmbedded) {
      if (
        event.key === 'Escape' ||
        event.key === 'BrowserBack' ||
        (event.key === 'Backspace' && !isInputFocused())
      ) {
        if (this.isFullscreen) {
          invoke('toggle_player_fullscreen').catch(console.error);
        } else {
          this.stopEmbedded();
        }
        event.preventDefault();
        return;
      }
      if (event.key === ' ' || event.code === 'Space') {
        invoke('send_embedded_poc_ipc', {
          command: JSON.stringify({ command: ['cycle', 'pause'] }),
        }).catch(console.warn);
        event.preventDefault();
        return;
      }
      if (event.key === 'ArrowLeft') {
        emit('player-seek-left').catch(console.warn);
        event.preventDefault();
        return;
      }
      if (event.key === 'ArrowRight') {
        emit('player-seek-right').catch(console.warn);
        event.preventDefault();
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'AudioVolumeUp') {
        emit('player-volume-up').catch(console.warn);
        event.preventDefault();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'AudioVolumeDown') {
        emit('player-volume-down').catch(console.warn);
        event.preventDefault();
        return;
      }
      if (event.key === 'f' || event.key === 'F') {
        invoke('toggle_player_fullscreen').catch(console.error);
        event.preventDefault();
        return;
      }
      if (event.key === 'm' || event.key === 'M') {
        invoke('send_embedded_poc_ipc', {
          command: JSON.stringify({ command: ['cycle', 'mute'] }),
        }).catch(console.warn);
        event.preventDefault();
        return;
      }
    }

    if (
      event.key === 'Escape' ||
      event.key === 'BrowserBack' ||
      (event.key === 'Backspace' && !isInputFocused())
    ) {
      if (this.showVersionsMenu) {
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
    if (this.showVersionsMenu) {
      const target = event.target as HTMLElement;
      const container = this.elementRef.nativeElement.querySelector(
        '.versions-dropdown-container',
      );
      if (container && !container.contains(target)) {
        this.showVersionsMenu = false;
      }
    }
  }

  initMovie(movie: Channel): void {
    const enrichmentReqId = ++this.enrichmentLoadRequestId;
    const versionReqId = ++this.versionLoadRequestId;
    this.resetScrollPosition();
    this.showVersionsMenu = false;

    // Reset previous title state completely to prevent stale backdrop/metadata leakage
    this.movie = movie;
    this.cleanTitle = cleanMediaTitle(movie.name);
    this.releaseYear = extractYear(movie.name);
    this.qualityBadge = extractQuality(movie.name);
    this.synopsis = selectSynopsis(movie);
    this.posterUrl = movie.image;
    this.enrichment = undefined;
    this.versions = [];
    this.selectedVersion = undefined;
    this.similarMovies = [];
    this.loadingSimilar = true;
    this.loadingVersions = true;
    this.genres = [];
    this.rating = undefined;
    this.voteCount = undefined;
    this.director = undefined;
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
    this.hasWatchProgress = false;

    // 1. Synchronous cache read: check movie ID, or cached versions for THIS movie
    let cached = this.tmdbEnrichment.getEnrichmentSync(movie);
    if (!cached) {
      const cachedVersions = this.versionMatching.getCachedVersions(movie, this.releaseYear);
      if (cachedVersions?.length) {
        for (const v of cachedVersions) {
          cached = this.tmdbEnrichment.getEnrichmentSync(v.channel);
          if (cached?.backdropPath) break;
        }
      }
    }

    if (cached) {
      this.loadingEnrichment = false;
      this.applyEnrichment(cached, movie.id);
    } else {
      this.loadingEnrichment = true;
    }
    this.updateAmbientBackground();

    // 2. Cache-first async retrieval / background enrichment
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

    this.tmdbEnrichment.getEnrichment(movie, true, 'high')
      .then((res) => {
        if (enrichmentReqId !== this.enrichmentLoadRequestId) return;
        if (res) {
          this.applyEnrichment(res);
        }
      })
      .catch((err) => {
        console.warn('Failed to retrieve enrichment for movie:', err);
      })
      .finally(() => {
        if (enrichmentReqId === this.enrichmentLoadRequestId) {
          this.loadingEnrichment = false;
          this.cdr.markForCheck();
        }
      });

    // 3. Load "More Like This" from existing local catalog
    this.loadSimilarMovies(movie);

    // 4. Load alternative versions from provider catalog
    this.loadVersions(movie);

    // Check synopsis length
    this.checkSynopsisLength();
    this.updateWatchProgress();
  }

  async loadVersions(movie: Channel): Promise<void> {
    const requestId = ++this.versionLoadRequestId;
    this.loadingVersions = true;
    try {
      const vers = await this.versionMatching.findVersions(
        movie,
        this.enrichment?.releaseYear,
      );
      if (requestId !== this.versionLoadRequestId) return;
      this.versions = vers;

      // Check for previously saved version preference or playback history
      const preferred = this.versionMatching.getPreferredVersion(
        movie,
        this.versions,
        this.enrichment?.releaseYear,
      );

      // Default to English version for titles opened for the first time
      const targetVersion = preferred || this.versionMatching.getDefaultVersion(this.versions, movie);

      if (targetVersion) {
        this.selectedVersion = targetVersion;
        this.versions.forEach(
          (v) => (v.isSelected = v.channel.id === targetVersion.channel.id),
        );
        if (this.movie && this.movie.id !== targetVersion.channel.id) {
          if (requestId !== this.versionLoadRequestId) return;
          this.movie = targetVersion.channel;
          this.qualityBadge =
            targetVersion.qualityBadge || extractQuality(targetVersion.channel.name);
          if (!this.enrichment || !this.enrichment.backdropPath) {
            const verCached = this.tmdbEnrichment.getEnrichmentSync(targetVersion.channel);
            if (verCached) {
              this.applyEnrichment(verCached, this.movie.id);
            }
          }
        }
      } else {
        this.selectedVersion =
          this.versions.find((v) => v.channel.id === movie.id) || this.versions[0];
        this.versions.forEach(
          (v) => (v.isSelected = v.channel.id === this.selectedVersion?.channel.id),
        );
      }

      // If we still do not have a TMDB backdrop, check if any discovered version has one in cache
      if (!this.enrichment?.backdropPath && this.versions?.length) {
        for (const v of this.versions) {
          const vCached = this.tmdbEnrichment.getEnrichmentSync(v.channel);
          if (vCached?.backdropPath) {
            this.applyEnrichment(vCached, this.movie?.id);
            break;
          }
        }
      }
    } catch (err) {
      if (requestId !== this.versionLoadRequestId) return;
      console.warn('Failed to discover versions for movie:', err);
      this.versions = [this.versionMatching.channelToVersion(movie, true)];
      this.selectedVersion = this.versions[0];
    } finally {
      if (requestId === this.versionLoadRequestId) {
        this.loadingVersions = false;
        this.updateWatchProgress();
        this.cdr.markForCheck();
      }
    }
  }

  toggleVersionsMenu(event?: Event): void {
    if (event) event.stopPropagation();
    this.showVersionsMenu = !this.showVersionsMenu;
  }

  selectVersion(ver: MediaVersion): void {
    if (!ver) return;
    if (this.isPlayingEmbedded) {
      this.stopEmbedded();
    }
    this.showVersionsMenu = false;

    // Persist this selection for this grouped title
    this.versionMatching.savePreferredVersion(
      this.movie || ver.channel,
      ver,
      this.enrichment?.releaseYear,
    );

    if (this.movie?.id === ver.channel.id) {
      this.updateWatchProgress();
      return;
    }

    this.movie = ver.channel;
    this.qualityBadge = ver.qualityBadge || extractQuality(ver.channel.name);
    this.selectedVersion = ver;
    this.versions.forEach(
      (v) => (v.isSelected = v.channel.id === ver.channel.id),
    );

    // Preserve existing enrichment for the newly selected version
    if (this.enrichment) {
      this.applyEnrichment(this.enrichment, this.movie?.id);
      this.tmdbCache.saveEnrichment({ ...this.enrichment, providerItemId: ver.channel.id });
    } else {
      const verCached = this.tmdbEnrichment.getEnrichmentSync(ver.channel);
      if (verCached) {
        this.applyEnrichment(verCached, this.movie?.id);
      }
    }

    this.updateWatchProgress();
    this.toastr.info(`Selected ${ver.badgeLabel || ver.cleanTitle}`);
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

  applyEnrichment(enr: TmdbMediaEnrichment, forMovieId?: number): void {
    if (forMovieId != null && this.movie?.id !== forMovieId) return;
    this.enrichment = enr;
    this.loadingEnrichment = false;

    const chosenBackdrop = this.pickRotatedBackdrop(enr);
    if (chosenBackdrop) {
      // Prioritize w1280 first for instantaneous progressive loading, fall back to original
      const backdropUrl = getTmdbBackdropUrl(chosenBackdrop, 'w1280') || getTmdbBackdropUrl(chosenBackdrop, 'original');
      if (backdropUrl) {
        this.backdropUrl = backdropUrl;
        this.isBackdropFallback = false;
        this.backdropError = false;
        this.updateAmbientBackground();
      }
    }

    if (enr.posterPath && !this.imageError) {
      const p = getTmdbPosterUrl(enr.posterPath, 'w500');
      if (p) this.posterUrl = p;
    }

    if (enr.overview) {
      this.synopsis = enr.overview;
      this.checkSynopsisLength();
    }

    if (enr.releaseYear) {
      this.releaseYear = enr.releaseYear;
    }

    if (enr.runtime) {
      this.runtimeText = this.formatRuntime(enr.runtime);
    }

    if (enr.genres && enr.genres.length > 0) {
      this.genres = enr.genres;
    }

    if (enr.rating) {
      this.rating = enr.rating;
      this.voteCount = enr.voteCount;
    }

    if (enr.director) {
      this.director = enr.director;
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

  updateWatchProgress(): void {
    this.hasWatchProgress = this.checkWatchProgress();
    this.cdr.markForCheck();
  }

  checkWatchProgress(): boolean {
    if (!this.movie) return false;

    const idsToCheck: number[] = [];
    if (this.movie.id) idsToCheck.push(this.movie.id);
    if (this.selectedVersion?.channel?.id && !idsToCheck.includes(this.selectedVersion.channel.id)) {
      idsToCheck.push(this.selectedVersion.channel.id);
    }
    for (const v of this.versions) {
      if (v.channel?.id && !idsToCheck.includes(v.channel.id)) {
        idsToCheck.push(v.channel.id);
      }
    }

    // 1. Check Channel object properties
    const chAny = this.movie as any;
    if (chAny.progress_percent != null && !isNaN(chAny.progress_percent)) {
      if (chAny.progress_percent > 1 && chAny.progress_percent < 95) {
        return true;
      }
    }
    if (chAny.progress != null && !isNaN(chAny.progress) && chAny.progress > 10) {
      return true;
    }

    // 2. Check localStorage fred_tv_watch_progress
    try {
      const storeRaw = localStorage.getItem('fred_tv_watch_progress');
      if (storeRaw) {
        const store = JSON.parse(storeRaw);
        if (store) {
          for (const id of idsToCheck) {
            const entry = store[id];
            if (entry) {
              const time = typeof entry === 'number' ? entry : (entry.time || 0);
              const dur = entry.duration || 0;
              const pct = entry.percent || (dur > 0 ? (time / dur) * 100 : 0);
              // If finished (within 30s of end or >=95%), it's completed, not resume
              if (dur > 0 && (time >= dur - 30 || pct >= 95)) {
                continue;
              }
              if (time > 10 || pct > 1) {
                return true;
              }
            }
          }
        }
      }
    } catch {}

    // 3. Check individual localStorage keys: playback_pos_${id}, watch_progress_${id}
    try {
      for (const id of idsToCheck) {
        const pctRaw = localStorage.getItem(`watch_progress_${id}`);
        if (pctRaw) {
          const pct = parseFloat(pctRaw);
          if (!isNaN(pct) && pct > 1 && pct < 95) {
            return true;
          }
        }
        const posRaw = localStorage.getItem(`playback_pos_${id}`);
        if (posRaw) {
          const pos = parseFloat(posRaw);
          const durRaw = localStorage.getItem(`playback_dur_${id}`);
          const dur = durRaw ? parseFloat(durRaw) : 0;
          if (dur > 0 && (pos >= dur - 30 || (pos / dur) >= 0.95)) {
            continue;
          }
          if (!isNaN(pos) && pos > 10) {
            return true;
          }
        }
      }
    } catch {}

    // 4. Check if channel has last_watched timestamp
    if (chAny.last_watched != null && chAny.last_watched > 0) {
      return true;
    }

    return false;
  }

  async watchNow(): Promise<void> {
    if (!this.movie || this.isStartingPlayback) return;

    if (this.isPlayingEmbedded) {
      await this.stopEmbedded();
      return;
    }

    this.isStartingPlayback = true;

    try {
      let playChannel: Channel = {
        ...this.movie,
        id: this.movie.id,
        name: this.movie.name || this.cleanTitle,
        url: this.movie.url,
        media_type: MediaType.movie,
        source_id: this.movie.source_id,
        favorite: !!this.movie.favorite,
      };

      // Fallback: reload fresh channel data from SQLite if url or source_id is missing
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
            playChannel = {
              ...fresh,
              media_type: MediaType.movie,
              favorite: !!fresh.favorite,
            };
            this.movie = playChannel;
          }
        } catch (err) {
          console.warn('Failed to query fresh channel record:', err);
        }
      }

      invoke('add_last_watched', { id: playChannel.id }).catch(console.error);

      // Persist this played version preference
      if (this.movie && this.selectedVersion) {
        this.versionMatching.savePreferredVersion(
          this.movie,
          this.selectedVersion,
          this.enrichment?.releaseYear,
        );
      }

      // Save scroll position before activating theater mode
      this.saveScrollPosition();

      // Render the embedded video canvas host in DOM in theater mode
      this.isPlayingEmbedded = true;
      document.body.classList.add('theater-mode-active');
      this.cdr.detectChanges();

      // Wait a frame so layout/bounding rect computes
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const el = document.getElementById('movie-video-canvas');
      let x = 0, y = 0, width = 800, height = 600;
      if (el) {
        const rect = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        x = Math.round(rect.x * dpr);
        y = Math.round(rect.y * dpr);
        width = Math.round(rect.width * dpr);
        height = Math.round(rect.height * dpr);
      }

      const playerChannel: Channel = {
        ...playChannel,
        name: cleanMediaTitle(playChannel.name || this.cleanTitle),
      };

      await invoke('start_embedded_player', {
        channel: playerChannel,
        x,
        y,
        width,
        height,
        zOrder: 'top',
      });

      this.setupVideoResizeObserver();
      setTimeout(() => this.syncVideoBounds(), 50);
      setTimeout(() => this.syncVideoBounds(), 150);
    } catch (e) {
      console.error('Movie embedded playback error:', e);
      this.cleanupVideoResizeObserver();
      this.isPlayingEmbedded = false;
      document.body.classList.remove('theater-mode-active');
      document.body.classList.remove('fullscreen-player-active');
      this.restoreScrollPosition();
      this.error.handleError(e, 'Failed to start embedded playback');
    } finally {
      this.isStartingPlayback = false;
      this.cdr.detectChanges();
    }
  }



  async stopEmbedded(): Promise<void> {
    this.cleanupVideoResizeObserver();
    if (this.isFullscreen) {
      this.isFullscreen = false;
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
    this.isPlayingEmbedded = false;
    this.restoreScrollPosition();
    this.updateWatchProgress();
    this.cdr.detectChanges();
  }

  updateVideoAspect(_aspect: number): void {
    // Theater mode fills the whole content area; MPV letterboxes automatically.
  }

  applyFullscreenState(isFs: boolean): void {
    this.isFullscreen = isFs;
    if (isFs) {
      document.body.classList.add('fullscreen-player-active');
    } else {
      document.body.classList.remove('fullscreen-player-active');
      setTimeout(() => this.syncVideoBounds(true), 50);
    }
    this.cdr.detectChanges();
  }

  async toggleFullscreen(): Promise<void> {
    if (!this.isPlayingEmbedded) return;
    try {
      await invoke('toggle_player_fullscreen');
    } catch (e) {
      console.warn('Failed to toggle fullscreen:', e);
    }
  }

  syncVideoBounds(immediate: boolean = false): void {
    if (!this.isPlayingEmbedded || this.isFullscreen) return;
    const doSync = () => {
      this.syncScheduled = false;
      if (!this.isPlayingEmbedded || this.isFullscreen) return;
      const el = document.getElementById('movie-video-canvas');
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = Math.round(rect.x * dpr);
      const y = Math.round(rect.y * dpr);
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
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

  setupVideoResizeObserver(): void {
    this.cleanupVideoResizeObserver();
    const el = document.getElementById('movie-video-canvas');
    if (!el) return;
    if (typeof ResizeObserver !== 'undefined') {
      this.videoResizeObserver = new ResizeObserver(() => {
        this.syncVideoBounds();
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

  cleanupVideoResizeObserver(): void {
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

  async toggleFavorite(event?: Event): Promise<void> {
    if (event) event.stopPropagation();
    if (!this.movie) return;

    const wasFavorite = this.movie.favorite;
    const call = wasFavorite ? 'unfavorite_channel' : 'favorite_channel';

    try {
      await invoke(call, { channelId: this.movie.id });
      this.movie.favorite = !wasFavorite;
    } catch (err) {
      console.error('Failed to update favorite status:', err);
      this.toastr.error('Failed to update favorite status');
    }
  }

  openTrailer(): void {
    if (this.trailer && this.safeTrailerUrl) {
      this.showTrailerModal = true;
    }
  }

  closeTrailer(): void {
    this.showTrailerModal = false;
  }

  openTrailerExternal(): void {
    if (this.trailer?.key) {
      const url = `https://www.youtube.com/watch?v=${this.trailer.key}`;
      window.open(url, '_blank');
    }
  }

  async loadSimilarMovies(movie: Channel): Promise<void> {
    const requestId = ++this.similarLoadRequestId;
    this.loadingSimilar = true;
    try {
      const sourceIds = movie.source_id
        ? [movie.source_id]
        : Array.from(this.memory.Sources.keys());

      // Query local SQLite for movies sharing the same group/category
      const filters: Filters = {
        source_ids: sourceIds,
        group_id: movie.group_id,
        media_types: [MediaType.movie],
        view_type: ViewMode.All,
        use_keywords: false,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };

      let results = (await invoke('search', { filters })) as Channel[];
      if (requestId !== this.similarLoadRequestId) return;
      let filtered = (results || []).filter((m) => m.id !== movie.id);

      // If category has few items, fallback to general movies from provider
      if (filtered.length < 4) {
        const fallbackFilters: Filters = {
          source_ids: sourceIds,
          media_types: [MediaType.movie],
          view_type: ViewMode.All,
          use_keywords: false,
          page: 1,
          sort: SortType.provider,
        };
        const fallbackRes = (await invoke('search', { filters: fallbackFilters })) as Channel[];
        if (requestId !== this.similarLoadRequestId) return;
        const extra = (fallbackRes || []).filter((m) => m.id !== movie.id && !filtered.some(f => f.id === m.id));
        filtered = filtered.concat(extra);
      }

      this.similarMovies = filtered.slice(0, 18);
    } catch (e) {
      if (requestId !== this.similarLoadRequestId) return;
      console.warn('Failed to load similar movies', e);
      this.similarMovies = [];
    } finally {
      if (requestId === this.similarLoadRequestId) {
        this.loadingSimilar = false;
        this.cdr.markForCheck();
      }
    }
  }

  async onPlaySimilarClick(movie: Channel, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.isPlayingEmbedded) {
      await this.stopEmbedded();
    }
    await this.embeddedPlayer.playMediaDirectly(movie, 'movie-video-canvas');
  }

  selectSimilarMovie(channel: Channel): void {
    if (this.isPlayingEmbedded) {
      this.stopEmbedded();
    }
    this.movieDetailService.setSelectedMovie(channel);
    this.initMovie(channel);
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
    if (this.movie?.image && this.posterUrl !== this.movie.image) {
      this.posterUrl = this.movie.image;
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
    if (this.isPlayingEmbedded) {
      this.stopEmbedded();
    }
    if (window.history.length > 1) {
      this.location.back();
    } else {
      this.router.navigateByUrl('');
    }
  }
}
