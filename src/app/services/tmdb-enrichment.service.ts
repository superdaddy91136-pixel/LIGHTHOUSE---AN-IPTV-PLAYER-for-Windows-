import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { TmdbMediaEnrichment, TmdbSeasonDetail } from '../models/tmdb';
import { cleanMediaTitle } from '../utils/media-presentation';
import {
  extractImdbId,
  prepareSearchQuery,
  scoreMatch,
  TMDB_MINIMUM_CONFIDENCE_THRESHOLD,
} from '../utils/tmdb-matcher';
import { getTmdbStillUrl } from '../utils/tmdb-image';
import { TmdbCacheService } from './tmdb-cache.service';
import { TmdbConfigService } from './tmdb-config.service';
import { TmdbService } from './tmdb.service';

interface QueueItem {
  channel: Channel;
  priority: 'high' | 'normal';
}

@Injectable({
  providedIn: 'root',
})
export class TmdbEnrichmentService {
  /** Emits whenever an enrichment record is matched, updated, or refreshed */
  public enrichmentUpdated$ = new Subject<TmdbMediaEnrichment>();

  private queue: QueueItem[] = [];
  private inFlightKeys = new Set<string>();
  private activeWorkers = 0;
  private isPlaybackActive = false;
  private readonly MAX_CONCURRENT = 2;
  private readonly REQUEST_DELAY_MS = 200;

  /**
   * Playback-aware workload coordinator: pauses nonessential background
   * catalogue enrichment during active video playback to eliminate CPU and network contention,
   * resuming automatically when playback ends.
   */
  public setPlaybackActive(active: boolean): void {
    if (this.isPlaybackActive === active) return;
    this.isPlaybackActive = active;
    if (!active) {
      this.processQueue();
    }
  }

  constructor(
    private configService: TmdbConfigService,
    private cacheService: TmdbCacheService,
    private tmdbService: TmdbService,
  ) {}

  /**
   * Fast synchronous lookup from hot memory cache.
   * Never blocks or incurs Promise overhead.
   */
  getEnrichmentSync(channel?: Channel): TmdbMediaEnrichment | undefined {
    if (!channel?.id) return undefined;
    const cached = this.cacheService.getEnrichmentSync(channel.id);
    if (cached) {
      const isSeries = Number(channel.media_type) === MediaType.serie || (channel as any).series_id != null;
      const expectedType: 'movie' | 'tv' = isSeries ? 'tv' : 'movie';
      if (cached.mediaType && cached.mediaType !== expectedType) {
        return undefined;
      }
    }
    return cached;
  }

  /**
   * Cache-first retrieval.
   * Returns cached data immediately if present (stale-while-revalidate).
   * Enqueues non-blocking background fetch if missing or stale.
   */
  async getEnrichment(
    channel: Channel,
    allowBackgroundFetch = true,
    priority: 'high' | 'normal' = 'normal',
  ): Promise<TmdbMediaEnrichment | undefined> {
    if (!channel?.id || channel.media_type === MediaType.livestream) {
      return undefined;
    }

    const cached = await this.cacheService.getEnrichment(channel.id);

    if (cached) {
      const isSeries = Number(channel.media_type) === MediaType.serie || (channel as any).series_id != null;
      const expectedType: 'movie' | 'tv' = isSeries ? 'tv' : 'movie';
      if (cached.mediaType && cached.mediaType !== expectedType) {
        if (allowBackgroundFetch && this.configService.isEnabled()) {
          this.enqueue(channel, priority);
        }
        return undefined;
      }

      const isIncomplete =
        priority === 'high' &&
        (cached.backdropVersion !== 1 ||
          !cached.backdropPath ||
          (!cached.overview && !cached.cast) ||
          !cached.logoPath);
      if ((this.cacheService.isStale(cached) || isIncomplete) && allowBackgroundFetch && this.configService.isEnabled()) {
        this.enqueue(channel, priority);
      }
      return cached;
    }

    if (allowBackgroundFetch && this.configService.isEnabled()) {
      if (priority === 'high') {
        return new Promise<TmdbMediaEnrichment | undefined>((resolve) => {
          const sub = this.enrichmentUpdated$.subscribe((res) => {
            if (Number(res.providerItemId) === Number(channel.id)) {
              sub.unsubscribe();
              resolve(res);
            }
          });
          setTimeout(() => {
            sub.unsubscribe();
            resolve(this.cacheService.getEnrichmentSync(channel.id));
          }, 8000);

          this.enqueue(channel, 'high');
        });
      } else {
        this.enqueue(channel, priority);
      }
    }

    return undefined;
  }

  /**
   * Enqueues a channel for background TMDB enrichment.
   * Deduplicates requests and handles priority ordering.
   */
  enqueue(channel: Channel, priority: 'high' | 'normal' = 'normal'): void {
    if (!channel?.id || !this.configService.isEnabled()) return;

    const key = `ch_${channel.id}`;
    if (this.inFlightKeys.has(key)) return;

    // Check if already in queue
    const existingIdx = this.queue.findIndex(item => item.channel.id === channel.id);
    if (existingIdx !== -1) {
      if (priority === 'high' && this.queue[existingIdx].priority !== 'high') {
        this.queue.splice(existingIdx, 1);
        this.queue.unshift({ channel, priority });
      }
      return;
    }

    if (priority === 'high') {
      this.queue.unshift({ channel, priority });
    } else {
      this.queue.push({ channel, priority });
    }

    this.processQueue();
  }

  private processQueue(): void {
    if (this.activeWorkers >= this.MAX_CONCURRENT || this.queue.length === 0) {
      return;
    }

    // While video playback is active, suspend nonessential background queue
    // to preserve CPU for smooth video presentation. High priority user requests still execute.
    if (this.isPlaybackActive && this.queue[0]?.priority !== 'high') {
      return;
    }

    const item = this.queue.shift();
    if (!item || !item.channel.id) return;

    const key = `ch_${item.channel.id}`;
    this.inFlightKeys.add(key);
    this.activeWorkers++;

    this.enrichWorker(item.channel, item.priority)
      .catch((err) => {
        console.warn(`Enrichment failed for channel ${item.channel.name}:`, err);
      })
      .finally(() => {
        this.inFlightKeys.delete(key);
        this.activeWorkers--;
        setTimeout(() => this.processQueue(), this.REQUEST_DELAY_MS);
      });
  }

  /**
   * Background enrichment worker executing the matching pipeline.
   */
  private async enrichWorker(channel: Channel, priority: 'high' | 'normal' = 'normal'): Promise<void> {
    if (!channel.id || !this.configService.isEnabled()) return;

    const isSeries = Number(channel.media_type) === MediaType.serie || (channel as any).series_id != null;
    const mediaType: 'movie' | 'tv' = isSeries ? 'tv' : 'movie';

    // 1. Check for IMDb ID in channel fields
    const externalImdb =
      extractImdbId(channel.name) ||
      extractImdbId(channel.url) ||
      (channel as any).stream_icon
        ? extractImdbId((channel as any).stream_icon)
        : undefined;

    if (externalImdb) {
      const findRes = await this.tmdbService.findByExternalId(externalImdb);
      const results = isSeries ? findRes?.tv_results : findRes?.movie_results;

      if (results && results.length > 0) {
        const top = results[0];
        const fullDetails = isSeries
          ? await this.tmdbService.getTvDetails(top.id)
          : await this.tmdbService.getMovieDetails(top.id);

        if (fullDetails) {
          const enrichment = isSeries
            ? this.tmdbService.parseTvDetails(fullDetails, 1.0, cleanMediaTitle(channel.name), channel.id)
            : this.tmdbService.parseMovieDetails(fullDetails, 1.0, cleanMediaTitle(channel.name), channel.id);

          await this.cacheService.saveEnrichment(enrichment);
          this.enrichmentUpdated$.next(enrichment);
          return;
        }
      }
    }

    // 2. Query preparation and title normalization
    const { query, year } = prepareSearchQuery(channel.name, mediaType);
    if (!query || query.length < 2) return;

    const searchKey = `${mediaType}:${query.toLowerCase()}:${year || ''}`;

    // 3. Check negative cache (bypass on high priority to allow user detail requests to retry)
    if (priority !== 'high') {
      const isFailed = await this.cacheService.isFailedMatch(searchKey);
      if (isFailed) return;
    }

    // 4. Search TMDB
    // For TV series, search by clean series title without year constraint initially,
    // because IPTV channel years often indicate season release year rather than series premiere date.
    let searchResults = isSeries
      ? await this.tmdbService.searchTv(query)
      : await this.tmdbService.searchMovie(query, year);

    // For movies: if search with year returned no results, retry without year constraint
    if (!isSeries && (!searchResults || searchResults.length === 0) && year) {
      searchResults = await this.tmdbService.searchMovie(query);
    }

    // Alternative query 1: try primary title before colon or dash if query contains subtitle
    if ((!searchResults || searchResults.length === 0) && /[:–—-]/.test(query)) {
      const primaryPart = query.split(/[:–—-]/)[0].trim();
      if (primaryPart.length >= 2 && primaryPart !== query) {
        searchResults = isSeries
          ? await this.tmdbService.searchTv(primaryPart)
          : await this.tmdbService.searchMovie(primaryPart, year);
        if (!isSeries && (!searchResults || searchResults.length === 0) && year) {
          searchResults = await this.tmdbService.searchMovie(primaryPart);
        }
      }
    }

    // Alternative query 2: try replacing '&' with 'and' or vice versa
    if ((!searchResults || searchResults.length === 0) && query.includes('&')) {
      const andQuery = query.replace(/&/g, 'and').trim();
      searchResults = isSeries
        ? await this.tmdbService.searchTv(andQuery)
        : await this.tmdbService.searchMovie(andQuery, year);
    }

    if (!searchResults || searchResults.length === 0) {
      await this.cacheService.recordFailedMatch(searchKey, query, mediaType, year);
      return;
    }

    // 5. Score candidates
    const scored = searchResults.map((cand) => ({
      candidate: cand,
      score: scoreMatch(cand, query, year, mediaType),
    }));

    if (/[:–—-]/.test(query)) {
      const primaryPart = query.split(/[:–—-]/)[0].trim();
      for (const s of scored) {
        const altScore = scoreMatch(s.candidate, primaryPart, year, mediaType);
        if (altScore.confidence > s.score.confidence) {
          s.score = altScore;
        }
      }
    }

    scored.sort((a, b) => b.score.confidence - a.score.confidence);
    const best = scored[0];

    // 6. Check confidence threshold
    if (!best || best.score.confidence < TMDB_MINIMUM_CONFIDENCE_THRESHOLD) {
      await this.cacheService.recordFailedMatch(searchKey, query, mediaType, year);
      return;
    }

    // 7. Fetch full details for the best match
    const full = isSeries
      ? await this.tmdbService.getTvDetails(best.candidate.id)
      : await this.tmdbService.getMovieDetails(best.candidate.id);

    if (!full) {
      return;
    }

    const enrichment = isSeries
      ? this.tmdbService.parseTvDetails(full, best.score.confidence, query, channel.id)
      : this.tmdbService.parseMovieDetails(full, best.score.confidence, query, channel.id);

    await this.cacheService.saveEnrichment(enrichment);
    this.enrichmentUpdated$.next(enrichment);
  }

  /**
   * Fetches TV season details with cache-first strategy.
   */
  async getSeasonDetails(
    tmdbId: number,
    seasonNumber: number,
  ): Promise<TmdbSeasonDetail | undefined> {
    const cached = await this.cacheService.getSeasonDetail(tmdbId, seasonNumber);
    if (cached && !this.cacheService.isStale(cached as any, 14 * 24 * 60 * 60 * 1000)) {
      return cached;
    }

    if (!this.configService.isEnabled()) return cached;

    const raw = await this.tmdbService.getTvSeasonDetails(tmdbId, seasonNumber);
    if (!raw) return cached;

    const parsed = this.tmdbService.parseSeasonDetails(raw, tmdbId);
    await this.cacheService.saveSeasonDetail(parsed);
    return parsed;
  }

  /**
   * Fast synchronous lookup of an episode still from hot memory cache.
   */
  getEpisodeStillSync(
    tmdbId: number,
    seasonNumber: number,
    episodeNumber: number,
  ): string | undefined {
    const season = this.cacheService.getSeasonDetailSync(tmdbId, seasonNumber);
    if (!season?.episodes) return undefined;
    const ep = season.episodes.find((e) => e.episodeNumber === episodeNumber);
    return ep?.stillPath ? getTmdbStillUrl(ep.stillPath, 'w300') : undefined;
  }

  /**
   * Fetches an episode still with cache-first strategy (memory -> IndexedDB -> TMDB API).
   */
  async getEpisodeStill(
    tmdbId: number,
    seasonNumber: number,
    episodeNumber: number,
  ): Promise<string | undefined> {
    const season = await this.getSeasonDetails(tmdbId, seasonNumber);
    if (!season?.episodes) return undefined;
    const ep = season.episodes.find((e) => e.episodeNumber === episodeNumber);
    return ep?.stillPath ? getTmdbStillUrl(ep.stillPath, 'w300') : undefined;
  }

  private trendingMoviesCache?: { data: any[]; timestamp: number };
  private trendingTvCache?: { data: any[]; timestamp: number };
  private readonly TRENDING_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  private popularMoviesCache = new Map<number, { data: any[]; timestamp: number }>();
  private popularTvCache = new Map<number, { data: any[]; timestamp: number }>();
  private topRatedMoviesCache = new Map<number, { data: any[]; timestamp: number }>();
  private topRatedTvCache = new Map<number, { data: any[]; timestamp: number }>();
  private recommendationsCache = new Map<string, { data: any[]; timestamp: number }>();
  private readonly DISCOVERY_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  /**
   * Fetches trending movies from TMDB with memory cache to avoid repeated requests.
   */
  async getTrendingMovies(timeWindow: 'day' | 'week' = 'week'): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    const now = Date.now();
    if (this.trendingMoviesCache && now - this.trendingMoviesCache.timestamp < this.TRENDING_CACHE_TTL) {
      return this.trendingMoviesCache.data;
    }
    const results = await this.tmdbService.getTrendingMovies(timeWindow);
    if (results && results.length > 0) {
      this.trendingMoviesCache = { data: results, timestamp: now };
    }
    return results || [];
  }

  /**
   * Fetches trending TV shows from TMDB with memory cache to avoid repeated requests.
   */
  async getTrendingTv(timeWindow: 'day' | 'week' = 'week'): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    const now = Date.now();
    if (this.trendingTvCache && now - this.trendingTvCache.timestamp < this.TRENDING_CACHE_TTL) {
      return this.trendingTvCache.data;
    }
    const results = await this.tmdbService.getTrendingTv(timeWindow);
    if (results && results.length > 0) {
      this.trendingTvCache = { data: results, timestamp: now };
    }
    return results || [];
  }

  /**
   * Fetches popular movies from TMDB with caching.
   */
  async getPopularMovies(page: number = 1): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    const now = Date.now();
    const cached = this.popularMoviesCache.get(page);
    if (cached && now - cached.timestamp < this.DISCOVERY_CACHE_TTL) {
      return cached.data;
    }
    const results = await this.tmdbService.getPopularMovies(page);
    if (results && results.length > 0) {
      this.popularMoviesCache.set(page, { data: results, timestamp: now });
    }
    return results || [];
  }

  /**
   * Fetches popular TV shows from TMDB with caching.
   */
  async getPopularTv(page: number = 1): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    const now = Date.now();
    const cached = this.popularTvCache.get(page);
    if (cached && now - cached.timestamp < this.DISCOVERY_CACHE_TTL) {
      return cached.data;
    }
    const results = await this.tmdbService.getPopularTv(page);
    if (results && results.length > 0) {
      this.popularTvCache.set(page, { data: results, timestamp: now });
    }
    return results || [];
  }

  /**
   * Fetches top rated movies from TMDB with caching.
   */
  async getTopRatedMovies(page: number = 1): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    const now = Date.now();
    const cached = this.topRatedMoviesCache.get(page);
    if (cached && now - cached.timestamp < this.DISCOVERY_CACHE_TTL) {
      return cached.data;
    }
    const results = await this.tmdbService.getTopRatedMovies(page);
    if (results && results.length > 0) {
      this.topRatedMoviesCache.set(page, { data: results, timestamp: now });
    }
    return results || [];
  }

  /**
   * Fetches top rated TV shows from TMDB with caching.
   */
  async getTopRatedTv(page: number = 1): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    const now = Date.now();
    const cached = this.topRatedTvCache.get(page);
    if (cached && now - cached.timestamp < this.DISCOVERY_CACHE_TTL) {
      return cached.data;
    }
    const results = await this.tmdbService.getTopRatedTv(page);
    if (results && results.length > 0) {
      this.topRatedTvCache.set(page, { data: results, timestamp: now });
    }
    return results || [];
  }

  /**
   * Discovers movies from TMDB based on criteria (genres, ratings, sort).
   */
  async discoverMovies(params: Record<string, string | number | undefined> = {}): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    return await this.tmdbService.discoverMovies(params);
  }

  /**
   * Discovers TV shows from TMDB based on criteria (genres, ratings, sort).
   */
  async discoverTv(params: Record<string, string | number | undefined> = {}): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    return await this.tmdbService.discoverTv(params);
  }

  /**
   * Fetches recommendations and similar titles for multiple seeds (movies or TV).
   * Runs bounded concurrent requests with deduplication.
   */
  async getRecommendationsForSeeds(seeds: { tmdbId: number; isTv: boolean }[]): Promise<any[]> {
    if (!this.configService.isEnabled() || seeds.length === 0) return [];

    const now = Date.now();
    const candidateMap = new Map<number, any>();

    // Bounded concurrency: up to 4 seed calls
    const targetSeeds = seeds.slice(0, 4);
    const promises = targetSeeds.map(async (seed) => {
      const cacheKey = `${seed.isTv ? 'tv' : 'mv'}_${seed.tmdbId}`;
      const cached = this.recommendationsCache.get(cacheKey);
      if (cached && now - cached.timestamp < this.DISCOVERY_CACHE_TTL) {
        return cached.data;
      }

      const [rec, sim] = await Promise.allSettled([
        seed.isTv
          ? this.tmdbService.getTvRecommendations(seed.tmdbId, 1)
          : this.tmdbService.getMovieRecommendations(seed.tmdbId, 1),
        seed.isTv
          ? this.tmdbService.getSimilarTv(seed.tmdbId, 1)
          : this.tmdbService.getSimilarMovies(seed.tmdbId, 1),
      ]);

      const items: any[] = [];
      if (rec.status === 'fulfilled' && Array.isArray(rec.value)) {
        items.push(...rec.value);
      }
      if (sim.status === 'fulfilled' && Array.isArray(sim.value)) {
        items.push(...sim.value);
      }

      this.recommendationsCache.set(cacheKey, { data: items, timestamp: now });
      return items;
    });

    const settled = await Promise.allSettled(promises);
    for (const res of settled) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        for (const item of res.value) {
          if (item?.id && !candidateMap.has(item.id)) {
            candidateMap.set(item.id, item);
          }
        }
      }
    }

    return Array.from(candidateMap.values());
  }

  /**
   * Seeds enrichment cache with TMDB candidate metadata for a matched channel.
   * Gives instant high-resolution artwork, overview, release year, rating, and genres.
   */
  async seedEnrichmentFromTmdbItem(channel: Channel, item: any): Promise<void> {
    if (!channel?.id || !this.configService.isEnabled()) return;
    const existing = this.getEnrichmentSync(channel);
    if (existing) return;

    const isSeries = item.media_type === 'tv' || Number(channel.media_type) === MediaType.serie;
    const dateStr = item.release_date || item.first_air_date || '';
    const releaseYear = dateStr.length >= 4 ? dateStr.substring(0, 4) : undefined;
    const genres = Array.isArray(item.genres)
      ? item.genres.map((g: any) => (typeof g === 'string' ? g : g.name)).filter(Boolean)
      : undefined;

    const normPath = (p: unknown): string | undefined => {
      if (typeof p !== 'string') return undefined;
      const t = p.trim();
      if (!t) return undefined;
      return t.startsWith('/') ? t : `/${t}`;
    };

    const cleanPoster = normPath(item.poster_path);
    const rawBackdrop = normPath(item.backdrop_path);
    const cleanBackdrop = rawBackdrop && rawBackdrop !== cleanPoster ? rawBackdrop : undefined;

    const enrichment: TmdbMediaEnrichment = {
      providerItemId: channel.id,
      tmdbId: item.id,
      mediaType: isSeries ? 'tv' : 'movie',
      normalizedTitle: cleanMediaTitle(channel.name),
      matchedTitle: item.title || item.name || cleanMediaTitle(channel.name),
      originalTitle: item.original_title || item.original_name,
      matchConfidence: 0.95,
      overview: item.overview?.trim() || undefined,
      posterPath: cleanPoster,
      backdropPath: cleanBackdrop,
      releaseDate: dateStr || undefined,
      releaseYear,
      genres,
      rating: item.vote_average ? Math.round(item.vote_average * 10) / 10 : undefined,
      voteCount: item.vote_count,
      originalLanguage: item.original_language || undefined,
      originCountry: Array.isArray(item.origin_country) ? item.origin_country : undefined,
      lastUpdated: Date.now(),
    };

    await this.cacheService.saveEnrichment(enrichment);
    this.enrichmentUpdated$.next(enrichment);
  }

  /**
   * Backwards-compatible alias for seedEnrichmentFromTmdbItem.
   */
  async seedEnrichmentFromTrending(channel: Channel, item: any): Promise<void> {
    return this.seedEnrichmentFromTmdbItem(channel, item);
  }

  /**
   * Resolves and verifies TMDB title logo artwork for a channel.
   * Checks hot cache first; if logo is missing, fetches full details to verify artwork.
   * Returns valid logoPath or undefined if the title has no TMDB logo artwork.
   */
  async resolveChannelLogo(
    channel: Channel,
    tmdbId?: number,
    isTv?: boolean,
  ): Promise<string | undefined> {
    if (!channel?.id || !this.configService.isEnabled()) return undefined;

    const cached = this.getEnrichmentSync(channel);
    // Cached logo is only trusted if verified under the localized logo selection policy (logoVersion === 2)
    if (
      cached?.logoPath &&
      cached.logoVersion === 2 &&
      typeof cached.logoPath === 'string' &&
      cached.logoPath.trim() !== ''
    ) {
      return cached.logoPath;
    }

    const resolvedTmdbId = tmdbId || cached?.tmdbId;
    if (!resolvedTmdbId) return undefined;

    const isSeries =
      isTv !== undefined
        ? isTv
        : Number(channel.media_type) === MediaType.serie || (channel as any).series_id != null;

    try {
      const details = isSeries
        ? await this.tmdbService.getTvDetails(resolvedTmdbId)
        : await this.tmdbService.getMovieDetails(resolvedTmdbId);

      if (!details) return undefined;

      const title = cleanMediaTitle(channel.name);
      const enrichment = isSeries
        ? this.tmdbService.parseTvDetails(details, 1.0, title, channel.id)
        : this.tmdbService.parseMovieDetails(details, 1.0, title, channel.id);

      await this.cacheService.saveEnrichment(enrichment);
      this.enrichmentUpdated$.next(enrichment);
      return enrichment.logoPath && enrichment.logoPath.trim() !== '' ? enrichment.logoPath : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Fetches Korean TV shows from TMDB with config enabled check.
   */
  async getKoreanTv(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams?: Record<string, string | number | undefined>
  ): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    return await this.tmdbService.getKoreanTv(page, sortBy, extraParams);
  }

  /**
   * Fetches Anime TV shows from TMDB with config enabled check.
   */
  async getAnimeTv(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams?: Record<string, string | number | undefined>
  ): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    return await this.tmdbService.getAnimeTv(page, sortBy, extraParams);
  }

  /**
   * Fetches Anime movies from TMDB with config enabled check.
   */
  async getAnimeMovies(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams?: Record<string, string | number | undefined>
  ): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    return await this.tmdbService.getAnimeMovies(page, sortBy, extraParams);
  }

  /**
   * Fetches animated TV shows from TMDB with config enabled check.
   */
  async getAnimationTv(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams?: Record<string, string | number | undefined>
  ): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    return await this.tmdbService.getAnimationTv(page, sortBy, extraParams);
  }

  /**
   * Fetches animated movies from TMDB with config enabled check.
   */
  async getAnimationMovies(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams?: Record<string, string | number | undefined>
  ): Promise<any[]> {
    if (!this.configService.isEnabled()) return [];
    return await this.tmdbService.getAnimationMovies(page, sortBy, extraParams);
  }
}

