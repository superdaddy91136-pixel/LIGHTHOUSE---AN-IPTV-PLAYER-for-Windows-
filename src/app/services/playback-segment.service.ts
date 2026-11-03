import { Injectable } from '@angular/core';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { extractImdbId, prepareSearchQuery, scoreMatch, TMDB_MINIMUM_CONFIDENCE_THRESHOLD } from '../utils/tmdb-matcher';
import { TmdbEnrichmentService } from './tmdb-enrichment.service';
import { TmdbService } from './tmdb.service';
import { TmdbCacheService } from './tmdb-cache.service';
import { MediaSegmentsRecord, PlaybackSegment, PlaybackSegmentType } from '../models/playback-segment';

export interface ResolveSegmentOptions {
  isMovie?: boolean;
  seasonNum?: number;
  episodeNum?: number;
  seriesChannel?: Channel;
  seriesTitle?: string;
}

const INTRODB_BASE_URL = 'https://api.introdb.app';
const CINEMETA_BASE_URL = 'https://v3-cinemeta.strem.io/catalog';
const FETCH_TIMEOUT_MS = 6000;
const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable({
  providedIn: 'root',
})
export class PlaybackSegmentService {
  constructor(
    private tmdbEnrichment: TmdbEnrichmentService,
    private tmdbService: TmdbService,
    private cacheService: TmdbCacheService
  ) {}

  /**
   * Generates a stable caching key for media playback segments.
   */
  public buildMediaKey(
    channel: Channel,
    isMovie: boolean,
    seasonNum?: number,
    episodeNum?: number,
    identifier?: string
  ): string {
    if (isMovie) {
      if (identifier) return `mv_${identifier}`;
      const imdbId = extractImdbId(channel.name) || extractImdbId(channel.url);
      if (imdbId) return `mv_${imdbId}`;
      const enrichment = this.tmdbEnrichment.getEnrichmentSync(channel);
      if (enrichment?.imdbId) return `mv_${enrichment.imdbId}`;
      if (enrichment?.tmdbId) return `mv_tmdb_${enrichment.tmdbId}`;
      return `mv_ch_${channel.id}`;
    }

    const s = seasonNum != null && seasonNum > 0 ? seasonNum : 1;
    const e = episodeNum != null && episodeNum > 0 ? episodeNum : 1;
    const seriesPrefix = identifier || channel.series_id || channel.id;
    return `tv_${seriesPrefix}_s${s}_e${e}`;
  }

  /**
   * Synchronous check for cached playback segments in memory.
   */
  public getSegmentsSync(channel?: Channel, options?: ResolveSegmentOptions): PlaybackSegment[] | undefined {
    if (!channel?.id) return undefined;
    const isMovie = this.resolveIsMovie(channel, options);
    const { seasonNum, episodeNum } = this.resolveSeasonAndEpisode(channel, options);
    const fastId = isMovie
      ? this.extractFastMovieIdentifier(channel)
      : this.extractFastSeriesIdentifier(channel, options?.seriesChannel, options?.seriesTitle);
    const key = this.buildMediaKey(channel, isMovie, seasonNum, episodeNum, fastId);
    const cached = this.cacheService.getPlaybackSegmentsSync(key);
    if (cached) return cached.segments;

    const fallbackKey = this.buildMediaKey(channel, isMovie, seasonNum, episodeNum);
    if (fallbackKey !== key) {
      const fallbackCached = this.cacheService.getPlaybackSegmentsSync(fallbackKey);
      if (fallbackCached) return fallbackCached.segments;
    }

    return undefined;
  }

  /**
   * Asynchronously retrieves playback segments.
   * Returns immediately from IndexedDB/memory cache if present;
   * otherwise resolves IMDb ID and fetches from public IntroDB API in the background.
   */
  public async getSegments(channel?: Channel, options?: ResolveSegmentOptions): Promise<PlaybackSegment[]> {
    if (!channel?.id) return [];

    const isMovie = this.resolveIsMovie(channel, options);
    const { seasonNum, episodeNum } = this.resolveSeasonAndEpisode(channel, options);

    // 1. Resolve IMDb ID (direct -> TMDB enrichment -> Cinemeta public fallback)
    const resolvedImdbId = isMovie
      ? await this.resolveMovieImdbId(channel)
      : await this.resolveSeriesImdbId(channel, options?.seriesChannel, options?.seriesTitle);

    const mediaKey = this.buildMediaKey(channel, isMovie, seasonNum, episodeNum, resolvedImdbId);

    // 2. Check local cache (memory + IndexedDB)
    const cachedRecord = await this.cacheService.getPlaybackSegments(mediaKey);
    if (cachedRecord) {
      if (cachedRecord.segments.length > 0) {
        return cachedRecord.segments;
      }
      // If confirmed empty and within TTL, return []
      const isFresh = Date.now() - cachedRecord.lastUpdated < NEGATIVE_CACHE_TTL_MS;
      if (cachedRecord.isConfirmedEmpty && isFresh) {
        return [];
      }
    }

    // If we could not resolve an IMDb ID at all, do NOT negative-cache
    if (!resolvedImdbId) {
      return [];
    }

    // 3. Fetch timestamps from public API
    try {
      const fetchResult = await this.fetchSegmentsFromApi(
        resolvedImdbId,
        isMovie,
        seasonNum,
        episodeNum
      );

      if (!fetchResult) {
        return cachedRecord ? cachedRecord.segments : [];
      }

      const { segments, noIntro, noRecap, noOutro, isConfirmedEmpty } = fetchResult;

      const record: MediaSegmentsRecord = {
        mediaKey,
        imdbId: resolvedImdbId,
        season: isMovie ? undefined : seasonNum,
        episode: isMovie ? undefined : episodeNum,
        segments,
        hasIntro: segments.some((s) => s.type === 'intro'),
        hasRecap: segments.some((s) => s.type === 'recap'),
        hasCredits: segments.some((s) => s.type === 'credits'),
        hasPostCredits: segments.some((s) => s.type === 'post_credits'),
        noIntro,
        noRecap,
        noOutro,
        isConfirmedEmpty,
        lastUpdated: Date.now(),
      };

      // Only persist to IndexedDB if segments exist OR IntroDB confirmed absence
      if (segments.length > 0 || isConfirmedEmpty) {
        await this.cacheService.setPlaybackSegments(record);
      }

      return segments;
    } catch (err) {
      console.warn('[PlaybackSegmentService] Failed to retrieve timestamps:', err);
      return cachedRecord ? cachedRecord.segments : [];
    }
  }

  /**
   * Public, keyless resolution of IMDb IDs via Cinemeta catalog search.
   * Validates candidates against query, media type, and year using scoreMatch.
   * Does NOT blindly accept the first search result.
   */
  public async resolveImdbIdFromCinemeta(
    rawTitle: string,
    mediaType: 'movie' | 'tv',
    targetYear?: string
  ): Promise<string | undefined> {
    if (!rawTitle) return undefined;

    const prep = prepareSearchQuery(rawTitle, mediaType);
    const searchTitle = prep.query;
    const year = targetYear || prep.year;
    if (!searchTitle || searchTitle.length < 2) return undefined;

    const catalogType = mediaType === 'tv' ? 'series' : 'movie';
    const url = `${CINEMETA_BASE_URL}/${catalogType}/top/search=${encodeURIComponent(searchTitle)}.json`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) return undefined;

      const data = await resp.json();
      const metas: any[] = Array.isArray(data?.metas) ? data.metas : [];
      if (metas.length === 0) return undefined;

      let bestMatch: { imdbId: string; confidence: number } | null = null;

      for (const meta of metas) {
        if (!meta || !meta.id || !meta.id.startsWith('tt')) continue;
        if (catalogType === 'series' && meta.type !== 'series') continue;
        if (catalogType === 'movie' && meta.type !== 'movie') continue;

        const candidateYear = meta.releaseInfo ? String(meta.releaseInfo).substring(0, 4) : undefined;
        const score = scoreMatch(
          {
            name: meta.name,
            title: meta.name,
            release_date: candidateYear,
            first_air_date: candidateYear,
          },
          searchTitle,
          year,
          mediaType
        );

        if (score.confidence >= TMDB_MINIMUM_CONFIDENCE_THRESHOLD) {
          if (!bestMatch || score.confidence > bestMatch.confidence) {
            bestMatch = { imdbId: meta.id, confidence: score.confidence };
          }
        }
      }

      return bestMatch ? bestMatch.imdbId : undefined;
    } catch {
      clearTimeout(timer);
      return undefined;
    }
  }

  /**
   * Internal fetcher querying the public IntroDB endpoint.
   */
  private async fetchSegmentsFromApi(
    imdbId: string,
    isMovie: boolean,
    seasonNum?: number,
    episodeNum?: number
  ): Promise<{
    segments: PlaybackSegment[];
    noIntro?: boolean;
    noRecap?: boolean;
    noOutro?: boolean;
    isConfirmedEmpty?: boolean;
  } | null> {
    const s = seasonNum != null && seasonNum > 0 ? seasonNum : 1;
    const e = episodeNum != null && episodeNum > 0 ? episodeNum : 1;

    const url = isMovie
      ? `${INTRODB_BASE_URL}/segments?imdb_id=${encodeURIComponent(imdbId)}&is_movie=true`
      : `${INTRODB_BASE_URL}/segments?imdb_id=${encodeURIComponent(imdbId)}&season=${s}&episode=${e}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        return null;
      }

      const raw = await response.json();
      const segments = this.normalizeSegments(raw);

      const noIntro = Boolean(raw?.no_intro);
      const noRecap = Boolean(raw?.no_recap);
      const noOutro = Boolean(raw?.no_outro);

      // Confirmed empty: no segments AND IntroDB confirmed absence
      const isConfirmedEmpty = segments.length === 0 && (noIntro && (isMovie || noOutro));

      return {
        segments,
        noIntro,
        noRecap,
        noOutro,
        isConfirmedEmpty,
      };
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  /**
   * Normalizes and validates raw segment payloads from the API.
   * Maps IntroDB 'outro' to internal 'credits' segment and 'post_credits' to 'post_credits'.
   */
  public normalizeSegments(raw: any): PlaybackSegment[] {
    if (!raw || typeof raw !== 'object') return [];

    const segments: PlaybackSegment[] = [];

    // 1. Intro
    if (raw.intro && typeof raw.intro === 'object') {
      const seg = this.validateSegment('intro', raw.intro);
      if (seg) segments.push(seg);
    }

    // 2. Recap
    if (raw.recap && typeof raw.recap === 'object') {
      const seg = this.validateSegment('recap', raw.recap);
      if (seg) segments.push(seg);
    }

    // 3. Outro -> mapped to internal 'credits'
    if (raw.outro && typeof raw.outro === 'object') {
      const seg = this.validateSegment('credits', raw.outro);
      if (seg) segments.push(seg);
    }

    // 4. Post-credits -> mapped to 'post_credits'
    if (raw.post_credits && typeof raw.post_credits === 'object') {
      const seg = this.validateSegment('post_credits', raw.post_credits);
      if (seg) segments.push(seg);
    }

    // Sort by startTime ascending
    segments.sort((a, b) => a.startTime - b.startTime);
    return segments;
  }

  /**
   * Validates a single segment candidate.
   * Ensures start >= 0, end > start, duration >= 2s, and non-NaN timestamps.
   */
  private validateSegment(type: PlaybackSegmentType, raw: any): PlaybackSegment | null {
    const startSec = typeof raw.start_sec === 'number'
      ? raw.start_sec
      : (typeof raw.start_ms === 'number' ? raw.start_ms / 1000 : NaN);

    const endSec = typeof raw.end_sec === 'number'
      ? raw.end_sec
      : (typeof raw.end_ms === 'number' ? raw.end_ms / 1000 : NaN);

    if (isNaN(startSec) || isNaN(endSec)) return null;
    if (startSec < 0 || endSec <= startSec) return null;
    if (endSec - startSec < 2) return null; // Must be at least 2 seconds long

    const confidence = typeof raw.confidence === 'number' && !isNaN(raw.confidence)
      ? Math.round(raw.confidence * 100) / 100
      : undefined;

    return {
      type,
      startTime: Math.round(startSec * 10) / 10,
      endTime: Math.round(endSec * 10) / 10,
      confidence,
    };
  }

  /**
   * Resolves the movie's IMDb ID using stream name, URL, TMDB enrichment, or Cinemeta fallback.
   */
  private async resolveMovieImdbId(channel: Channel): Promise<string | undefined> {
    const directImdb = extractImdbId(channel.name) || extractImdbId(channel.url);
    if (directImdb) return directImdb;

    const enrichment = this.tmdbEnrichment.getEnrichmentSync(channel);
    if (enrichment?.imdbId) return enrichment.imdbId;

    if (enrichment?.tmdbId) {
      const movieDetails = await this.tmdbService.getMovieDetails(enrichment.tmdbId);
      if (movieDetails?.imdb_id) return movieDetails.imdb_id;
    }

    if (channel.name) {
      const cinemetaImdb = await this.resolveImdbIdFromCinemeta(channel.name, 'movie');
      if (cinemetaImdb) return cinemetaImdb;
    }

    return undefined;
  }

  /**
   * Resolves the series' IMDb ID from channel, series container, TMDB external IDs, or Cinemeta fallback.
   */
  private async resolveSeriesImdbId(
    channel: Channel,
    seriesChannel?: Channel,
    seriesTitle?: string
  ): Promise<string | undefined> {
    const target = seriesChannel || channel;

    // 1. Direct IMDb ID in series title or URL
    const directImdb = extractImdbId(target.name) || extractImdbId(target.url);
    if (directImdb) {
      const findRes = await this.tmdbService.findByExternalId(directImdb);
      if (findRes?.tv_results?.length > 0) return directImdb;
      if (findRes?.tv_episode_results?.length > 0) {
        const showId = findRes.tv_episode_results[0].show_id;
        if (showId) {
          const extIds = await this.tmdbService.getTvExternalIds(showId);
          if (extIds?.imdb_id) return extIds.imdb_id;
        }
      }
    }

    // 2. TMDB enrichment for series
    const enrichment = this.tmdbEnrichment.getEnrichmentSync(target);
    if (enrichment?.tmdbId && enrichment.mediaType === 'tv') {
      const extIds = await this.tmdbService.getTvExternalIds(enrichment.tmdbId);
      if (extIds?.imdb_id) return extIds.imdb_id;
    }

    // 3. Cinemeta public fallback using series title candidates
    const titleCandidates = [
      seriesTitle,
      seriesChannel?.name,
      channel.name,
    ].filter((t): t is string => !!t && t.trim().length > 0);

    for (const title of titleCandidates) {
      const imdbId = await this.resolveImdbIdFromCinemeta(title, 'tv');
      if (imdbId) return imdbId;
    }

    // 4. Fallback: check if the episode itself has an IMDb ID and resolve its series via TMDB
    const episodeImdbId = extractImdbId(channel.name) || extractImdbId(channel.url);
    if (episodeImdbId) {
      const findRes = await this.tmdbService.findByExternalId(episodeImdbId);
      const epMatch = findRes?.tv_episode_results?.[0];
      if (epMatch?.show_id) {
        const extIds = await this.tmdbService.getTvExternalIds(epMatch.show_id);
        if (extIds?.imdb_id) return extIds.imdb_id;
      }
    }

    return undefined;
  }

  private extractFastSeriesIdentifier(channel: Channel, seriesChannel?: Channel, seriesTitle?: string): string {
    const directImdb =
      extractImdbId(seriesChannel?.name) ||
      extractImdbId(seriesChannel?.url) ||
      extractImdbId(channel.name) ||
      extractImdbId(channel.url);
    if (directImdb) return directImdb;

    const target = seriesChannel || channel;
    const enrichment = this.tmdbEnrichment.getEnrichmentSync(target);
    if (enrichment?.imdbId) return enrichment.imdbId;
    if (enrichment?.tmdbId) return `tmdb_${enrichment.tmdbId}`;

    return String(seriesTitle || target.series_id || target.id || 'unknown');
  }

  private extractFastMovieIdentifier(channel: Channel): string | undefined {
    const direct = extractImdbId(channel.name) || extractImdbId(channel.url);
    if (direct) return direct;
    const enrichment = this.tmdbEnrichment.getEnrichmentSync(channel);
    if (enrichment?.imdbId) return enrichment.imdbId;
    return undefined;
  }

  private resolveIsMovie(channel: Channel, options?: ResolveSegmentOptions): boolean {
    if (options?.isMovie != null) return options.isMovie;
    const isEpisode =
      Number(channel.media_type) === MediaType.serie ||
      channel.season_id != null ||
      channel.series_id != null ||
      channel.episode_num != null;
    return !isEpisode;
  }

  private resolveSeasonAndEpisode(
    channel: Channel,
    options?: ResolveSegmentOptions
  ): { seasonNum: number; episodeNum: number } {
    let s = options?.seasonNum;
    let e = options?.episodeNum ?? channel.episode_num;

    const name = channel.name || '';
    if (s == null) {
      const sMatch = name.match(/\b[Ss](\d{1,2})\b/) || name.match(/[Ss](\d{1,2})/);
      s = sMatch ? parseInt(sMatch[1], 10) : 1;
    }

    if (e == null) {
      const eMatch = name.match(/\b[Ee](\d{1,3})\b/) || name.match(/[Ee](\d{1,3})/);
      e = eMatch ? parseInt(eMatch[1], 10) : 1;
    }

    return { seasonNum: s, episodeNum: e };
  }
}
