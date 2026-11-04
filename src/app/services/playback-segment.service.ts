import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { extractImdbId, prepareSearchQuery, scoreMatch, TMDB_MINIMUM_CONFIDENCE_THRESHOLD } from '../utils/tmdb-matcher';
import { cleanMediaTitle, extractYear } from '../utils/media-presentation';
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

export interface MediaIdentifierResolution {
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
}

export interface FetchSegmentsQuery {
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
  isMovie: boolean;
  seasonNum?: number;
  episodeNum?: number;
}

const THEINTRODB_BASE_URL = 'https://api.theintrodb.org/v4/media';
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
      if (enrichment?.tmdbId) return `mv_tmdb_${enrichment.tmdbId}`;
      if (enrichment?.imdbId) return `mv_${enrichment.imdbId}`;
      return `mv_ch_${channel.id}`;
    }

    const s = seasonNum != null && seasonNum >= 0 ? seasonNum : 1;
    const e = episodeNum != null && episodeNum >= 0 ? episodeNum : 1;
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
   * Asynchronously retrieves playback segments from TheIntroDB v4.
   * Returns immediately from IndexedDB/memory cache if present;
   * otherwise resolves best available identifiers (TVDB -> TMDB -> IMDb)
   * and fetches from TheIntroDB v4 API in the background.
   */
  public async getSegments(channel?: Channel, options?: ResolveSegmentOptions): Promise<PlaybackSegment[]> {
    if (!channel?.id) return [];

    const isMovie = this.resolveIsMovie(channel, options);
    const { seasonNum, episodeNum } = this.resolveSeasonAndEpisode(channel, options);

    // 1. Resolve best available media identifiers (TVDB -> TMDB -> IMDb)
    const ids = isMovie
      ? await this.resolveMovieIdentifiers(channel)
      : await this.resolveSeriesIdentifiers(channel, options?.seriesChannel, options?.seriesTitle);

    const primaryIdStr = ids.tvdbId
      ? `tvdb_${ids.tvdbId}`
      : (ids.tmdbId ? `tmdb_${ids.tmdbId}` : ids.imdbId);

    const mediaKey = this.buildMediaKey(channel, isMovie, seasonNum, episodeNum, primaryIdStr);

    // 2. Check local cache (memory + IndexedDB)
    let cachedRecord = await this.cacheService.getPlaybackSegments(mediaKey);

    if (!cachedRecord && ids.tmdbId) {
      const tmdbKey = this.buildMediaKey(channel, isMovie, seasonNum, episodeNum, `tmdb_${ids.tmdbId}`);
      if (tmdbKey !== mediaKey) {
        cachedRecord = await this.cacheService.getPlaybackSegments(tmdbKey);
      }
    }
    if (!cachedRecord && ids.imdbId) {
      const imdbKey = this.buildMediaKey(channel, isMovie, seasonNum, episodeNum, ids.imdbId);
      if (imdbKey !== mediaKey) {
        cachedRecord = await this.cacheService.getPlaybackSegments(imdbKey);
      }
    }
    if (!cachedRecord) {
      const fallbackKey = this.buildMediaKey(channel, isMovie, seasonNum, episodeNum);
      if (fallbackKey !== mediaKey) {
        cachedRecord = await this.cacheService.getPlaybackSegments(fallbackKey);
      }
    }

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

    // If we could not resolve ANY valid identifier, do not negative-cache
    if (!ids.tvdbId && !ids.tmdbId && !ids.imdbId) {
      return [];
    }

    // 3. Fetch timestamps from TheIntroDB v4 API
    try {
      const fetchResult = await this.fetchSegmentsFromApi({
        tvdbId: ids.tvdbId,
        tmdbId: ids.tmdbId,
        imdbId: ids.imdbId,
        isMovie,
        seasonNum,
        episodeNum,
      });

      if (!fetchResult) {
        return cachedRecord ? cachedRecord.segments : [];
      }

      const { segments, noIntro, noRecap, noOutro, isConfirmedEmpty } = fetchResult;

      const record: MediaSegmentsRecord = {
        mediaKey,
        channelId: channel.id,
        tvdbId: ids.tvdbId,
        tmdbId: ids.tmdbId,
        imdbId: ids.imdbId,
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

      // Only persist to IndexedDB if segments exist OR TheIntroDB confirmed absence
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
   * Internal fetcher querying TheIntroDB v4 endpoint.
   */
  private async fetchSegmentsFromApi(query: FetchSegmentsQuery): Promise<{
    segments: PlaybackSegment[];
    noIntro?: boolean;
    noRecap?: boolean;
    noOutro?: boolean;
    isConfirmedEmpty?: boolean;
  } | null> {
    const params = new URLSearchParams();

    // Priority: tvdb_id -> tmdb_id -> imdb_id
    if (query.tvdbId) {
      params.set('tvdb_id', String(query.tvdbId));
    } else if (query.tmdbId) {
      params.set('tmdb_id', String(query.tmdbId));
    } else if (query.imdbId) {
      params.set('imdb_id', query.imdbId);
    } else {
      return null;
    }

    if (!query.isMovie) {
      const s = query.seasonNum != null && query.seasonNum >= 0 ? query.seasonNum : 1;
      const e = query.episodeNum != null && query.episodeNum >= 0 ? query.episodeNum : 1;
      params.set('season', String(s));
      params.set('episode', String(e));
    }

    params.set('details', 'true');

    const url = `${THEINTRODB_BASE_URL}?${params.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      let raw: any = null;

      // 1. Try native Tauri command to avoid browser CORS restrictions
      try {
        const text = await invoke<string>('fetch_playback_segments', { url });
        if (text) {
          raw = JSON.parse(text);
        }
      } catch (ipcErr) {
        // Fall back to direct fetch if native IPC is unavailable
      }

      // 2. Direct browser fetch fallback
      if (!raw) {
        const response = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });

        if (response.status === 404) {
          clearTimeout(timer);
          try {
            const errBody = await response.json();
            if (errBody?.code === 'no_submissions' || errBody?.code === 'episode_not_found') {
              return {
                segments: [],
                noIntro: true,
                noRecap: true,
                noOutro: true,
                isConfirmedEmpty: true,
              };
            }
          } catch {}
          return {
            segments: [],
            noIntro: true,
            noRecap: true,
            noOutro: true,
            isConfirmedEmpty: true,
          };
        }

        if (!response.ok) {
          clearTimeout(timer);
          return null;
        }

        raw = await response.json();
      }

      clearTimeout(timer);

      // Handle TheIntroDB error codes if returned via native IPC
      if (raw?.error) {
        if (raw.code === 'no_submissions' || raw.code === 'episode_not_found') {
          return {
            segments: [],
            noIntro: true,
            noRecap: true,
            noOutro: true,
            isConfirmedEmpty: true,
          };
        }
        return null;
      }

      const segments = this.normalizeSegments(raw);

      const hasIntro = segments.some((s) => s.type === 'intro');
      const hasRecap = segments.some((s) => s.type === 'recap');
      const hasCredits = segments.some((s) => s.type === 'credits');

      const isConfirmedEmpty = segments.length === 0;

      return {
        segments,
        noIntro: !hasIntro,
        noRecap: !hasRecap,
        noOutro: !hasCredits,
        isConfirmedEmpty,
      };
    } catch (err) {
      clearTimeout(timer);
      return null;
    }
  }

  /**
   * Normalizes and validates raw segment payloads from TheIntroDB v4 (or legacy formats).
   * Supports multiple segment ranges per type (arrays), timestamp conversion from ms,
   * and maps outro/credits to 'credits' and post_credits to 'post_credits'.
   */
  public normalizeSegments(raw: any): PlaybackSegment[] {
    if (!raw || typeof raw !== 'object') return [];

    const segments: PlaybackSegment[] = [];
    const fallbackDurationSec =
      typeof raw.group_duration_ms === 'number' && raw.group_duration_ms > 0
        ? raw.group_duration_ms / 1000
        : undefined;

    const processEntries = (type: PlaybackSegmentType, data: any) => {
      if (!data) return;
      if (Array.isArray(data)) {
        for (const item of data) {
          const seg = this.validateSegment(type, item, fallbackDurationSec);
          if (seg) segments.push(seg);
        }
      } else if (typeof data === 'object') {
        const seg = this.validateSegment(type, data, fallbackDurationSec);
        if (seg) segments.push(seg);
      }
    };

    // 1. Intro
    processEntries('intro', raw.intro);

    // 2. Recap
    processEntries('recap', raw.recap);

    // 3. Credits / Outro -> mapped to internal 'credits'
    processEntries('credits', raw.credits);
    processEntries('credits', raw.outro);

    // 4. Post-credits -> mapped to 'post_credits'
    processEntries('post_credits', raw.post_credits);

    // Sort by startTime ascending
    segments.sort((a, b) => a.startTime - b.startTime);
    return segments;
  }

  /**
   * Validates a single segment candidate.
   * Ensures start >= 0, end > start, duration >= 2s, and non-NaN timestamps.
   * Handles null start_ms for intro/recap (defaults to 0) and null end_ms for credits.
   */
  private validateSegment(
    type: PlaybackSegmentType,
    raw: any,
    fallbackDurationSec?: number
  ): PlaybackSegment | null {
    if (!raw || typeof raw !== 'object') return null;

    // 1. Resolve startSec
    let startSec: number;
    if (typeof raw.start_sec === 'number') {
      startSec = raw.start_sec;
    } else if (typeof raw.start_ms === 'number') {
      startSec = raw.start_ms / 1000;
    } else if (raw.start_sec === null || raw.start_ms === null || raw.start_ms === undefined) {
      if (type === 'intro' || type === 'recap') {
        startSec = 0;
      } else {
        return null;
      }
    } else {
      return null;
    }

    // 2. Resolve endSec
    let endSec: number;
    if (typeof raw.end_sec === 'number') {
      endSec = raw.end_sec;
    } else if (typeof raw.end_ms === 'number') {
      endSec = raw.end_ms / 1000;
    } else if (raw.end_sec === null || raw.end_ms === null || raw.end_ms === undefined) {
      if (type === 'credits') {
        endSec =
          fallbackDurationSec != null && fallbackDurationSec > startSec
            ? fallbackDurationSec
            : startSec + 3600;
      } else {
        return null;
      }
    } else {
      return null;
    }

    if (isNaN(startSec) || isNaN(endSec)) return null;
    if (startSec < 0 || endSec <= startSec) return null;
    if (endSec - startSec < 2) return null; // Must be at least 2 seconds long
    if (type === 'credits' && startSec === 0) return null; // 0 start for credits denotes no segment

    const confidence =
      typeof raw.confidence === 'number' && !isNaN(raw.confidence)
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
   * Resolves movie identifiers (preferring TVDB -> TMDB -> IMDb).
   * Works accurately even when IPTV channel names do not contain IMDb IDs.
   */
  public async resolveMovieIdentifiers(channel: Channel): Promise<MediaIdentifierResolution> {
    const result: MediaIdentifierResolution = {};

    // 1. Direct IMDb ID from channel name or URL
    const directImdb = extractImdbId(channel.name) || extractImdbId(channel.url);
    if (directImdb) {
      result.imdbId = directImdb;
    }

    // 2. TMDB enrichment (sync -> cache -> fetch)
    let enrichment = this.tmdbEnrichment.getEnrichmentSync(channel);
    if (!enrichment && channel.id) {
      enrichment = await this.cacheService.getEnrichment(channel.id);
    }
    if (!enrichment && channel.id) {
      enrichment = await this.tmdbEnrichment.getEnrichment(channel);
    }

    if (enrichment?.tmdbId) {
      result.tmdbId = enrichment.tmdbId;
    }
    if (enrichment?.imdbId) {
      result.imdbId = enrichment.imdbId;
    }

    // If we already have TMDB ID or IMDb ID, we are ready!
    if (result.tmdbId || result.imdbId) {
      return result;
    }

    // 3. Cinemeta public fallback using title and year
    const targetYear =
      extractYear(channel.name) ||
      extractYear(channel.url) ||
      enrichment?.releaseYear;

    const titleCandidates = [
      channel.name,
      cleanMediaTitle(channel.name),
    ].filter((t): t is string => !!t && t.trim().length > 0);

    for (const title of titleCandidates) {
      const cinemetaImdb = await this.resolveImdbIdFromCinemeta(title, 'movie', targetYear);
      if (cinemetaImdb) {
        result.imdbId = cinemetaImdb;
        try {
          const findRes = await this.tmdbService.findByExternalId(cinemetaImdb);
          if (findRes?.movie_results?.[0]?.id) {
            result.tmdbId = findRes.movie_results[0].id;
          }
        } catch {}
        return result;
      }
    }

    return result;
  }

  /**
   * Resolves TV series identifiers (preferring TVDB -> TMDB -> IMDb).
   */
  public async resolveSeriesIdentifiers(
    channel: Channel,
    seriesChannel?: Channel,
    seriesTitle?: string
  ): Promise<MediaIdentifierResolution> {
    const result: MediaIdentifierResolution = {};
    const target = seriesChannel || channel;

    // 1. Direct IMDb ID in series title or URL
    const directImdb =
      extractImdbId(target.name) ||
      extractImdbId(target.url) ||
      extractImdbId(channel.name) ||
      extractImdbId(channel.url);

    if (directImdb) {
      result.imdbId = directImdb;
      try {
        const findRes = await this.tmdbService.findByExternalId(directImdb);
        if (findRes?.tv_results?.length > 0) {
          result.tmdbId = findRes.tv_results[0].id;
        } else if (findRes?.tv_episode_results?.length > 0) {
          result.tmdbId = findRes.tv_episode_results[0].show_id;
        }
      } catch {}
    }

    // 2. TMDB enrichment for series
    let enrichment = this.tmdbEnrichment.getEnrichmentSync(target);
    if (!enrichment && target.id) {
      enrichment = await this.cacheService.getEnrichment(target.id);
    }
    if (!enrichment && target.id) {
      enrichment = await this.tmdbEnrichment.getEnrichment(target);
    }

    if (enrichment?.tmdbId && enrichment.mediaType === 'tv') {
      result.tmdbId = enrichment.tmdbId;
      if (enrichment.imdbId) {
        result.imdbId = enrichment.imdbId;
      }
    }

    // 3. If we have TMDB ID, query external IDs to get TVDB ID
    if (result.tmdbId) {
      try {
        const extIds = await this.tmdbService.getTvExternalIds(result.tmdbId);
        if (extIds?.tvdb_id) {
          result.tvdbId = Number(extIds.tvdb_id);
        }
        if (extIds?.imdb_id && !result.imdbId) {
          result.imdbId = extIds.imdb_id;
        }
      } catch {}
    }

    if (result.tvdbId || result.tmdbId || result.imdbId) {
      return result;
    }

    // 4. Cinemeta public fallback using series title candidates
    const titleCandidates = [
      seriesTitle,
      seriesChannel?.name,
      channel.name,
    ].filter((t): t is string => !!t && t.trim().length > 0);

    for (const title of titleCandidates) {
      const cinemetaImdb = await this.resolveImdbIdFromCinemeta(title, 'tv');
      if (cinemetaImdb) {
        result.imdbId = cinemetaImdb;
        try {
          const findRes = await this.tmdbService.findByExternalId(cinemetaImdb);
          const showId = findRes?.tv_results?.[0]?.id || findRes?.tv_episode_results?.[0]?.show_id;
          if (showId) {
            result.tmdbId = showId;
            const extIds = await this.tmdbService.getTvExternalIds(showId);
            if (extIds?.tvdb_id) {
              result.tvdbId = Number(extIds.tvdb_id);
            }
          }
        } catch {}
        return result;
      }
    }

    // 5. Fallback: check if the episode itself has an IMDb ID and resolve its series via TMDB
    const episodeImdbId = extractImdbId(channel.name) || extractImdbId(channel.url);
    if (episodeImdbId && episodeImdbId !== directImdb) {
      try {
        const findRes = await this.tmdbService.findByExternalId(episodeImdbId);
        const epMatch = findRes?.tv_episode_results?.[0];
        if (epMatch?.show_id) {
          result.tmdbId = epMatch.show_id;
          const extIds = await this.tmdbService.getTvExternalIds(epMatch.show_id);
          if (extIds?.tvdb_id) {
            result.tvdbId = Number(extIds.tvdb_id);
          }
          if (extIds?.imdb_id) {
            result.imdbId = extIds.imdb_id;
          }
          return result;
        }
      } catch {}
    }

    return result;
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
    if (enrichment?.tmdbId) return `tmdb_${enrichment.tmdbId}`;
    if (enrichment?.imdbId) return enrichment.imdbId;

    return String(seriesTitle || target.series_id || target.id || 'unknown');
  }

  private extractFastMovieIdentifier(channel: Channel): string | undefined {
    const direct = extractImdbId(channel.name) || extractImdbId(channel.url);
    if (direct) return direct;
    const enrichment = this.tmdbEnrichment.getEnrichmentSync(channel);
    if (enrichment?.tmdbId) return `tmdb_${enrichment.tmdbId}`;
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
