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
  duration?: number; // Stream duration in seconds for offset-aware matching
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
const SKIPDB_BASE_URL = 'https://api.skipdb.tv/api/segments';
const CINEMETA_BASE_URL = 'https://v3-cinemeta.strem.io/catalog';
const FETCH_TIMEOUT_MS = 6000;
const NEGATIVE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (allows newly submitted timestamps to become visible)

@Injectable({
  providedIn: 'root',
})
export class PlaybackSegmentService {
  private skipDbEnabled = true;

  constructor(
    private tmdbEnrichment: TmdbEnrichmentService,
    private tmdbService: TmdbService,
    private cacheService: TmdbCacheService
  ) {}

  /**
   * Checks whether SkipDB secondary skip source is enabled.
   */
  public isSkipDbEnabled(): boolean {
    try {
      const stored = localStorage.getItem('fred_tv_skipdb_enabled');
      if (stored !== null) {
        return stored !== 'false';
      }
    } catch {}
    return this.skipDbEnabled;
  }

  /**
   * Enables or disables SkipDB secondary skip source without affecting TheIntroDB.
   */
  public setSkipDbEnabled(enabled: boolean): void {
    this.skipDbEnabled = enabled;
    try {
      localStorage.setItem('fred_tv_skipdb_enabled', enabled ? 'true' : 'false');
    } catch {}
  }

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

    // 3. Fetch timestamps from TheIntroDB v4 API (primary source)
    let theIntroDbResult: {
      segments: PlaybackSegment[];
      noIntro?: boolean;
      noRecap?: boolean;
      noOutro?: boolean;
      isConfirmedEmpty?: boolean;
    } | null = null;

    try {
      theIntroDbResult = await this.fetchSegmentsFromApi({
        tvdbId: ids.tvdbId,
        tmdbId: ids.tmdbId,
        imdbId: ids.imdbId,
        isMovie,
        seasonNum,
        episodeNum,
      });
    } catch (err) {
      console.warn('[PlaybackSegmentService] TheIntroDB fetch failed:', err);
    }

    const primarySegments = theIntroDbResult ? theIntroDbResult.segments : [];
    const hasIntro = primarySegments.some((s) => s.type === 'intro');
    const hasCredits = primarySegments.some((s) => s.type === 'credits');

    // 4. Check if useful timestamp data is missing
    // For movies: credits/outro is the core timestamp
    // For TV episodes: missing intro or missing credits means useful data is missing
    const isUsefulDataMissing = isMovie
      ? !hasCredits
      : (!hasIntro || !hasCredits);

    let secondarySegments: PlaybackSegment[] = [];
    let skipDbResult: {
      segments: PlaybackSegment[];
      noIntro?: boolean;
      noRecap?: boolean;
      noOutro?: boolean;
      noPreview?: boolean;
      isConfirmedEmpty?: boolean;
    } | null = null;

    // 5. Query SkipDB only when enabled, IMDb ID is available, and useful data is missing
    if (this.isSkipDbEnabled() && ids.imdbId && isUsefulDataMissing) {
      try {
        skipDbResult = await this.fetchSegmentsFromSkipDb(
          ids.imdbId,
          isMovie,
          seasonNum,
          episodeNum,
          options?.duration
        );
        if (skipDbResult?.segments) {
          secondarySegments = skipDbResult.segments;
        }
      } catch (err) {
        console.warn('[PlaybackSegmentService] SkipDB fetch failed:', err);
      }
    }

    // If neither source succeeded with any response (e.g. network failure on both)
    if (!theIntroDbResult && !skipDbResult) {
      return cachedRecord ? cachedRecord.segments : [];
    }

    // 6. Merge primary and secondary segments individually by type
    const mergedSegments = this.mergeSegments(primarySegments, secondarySegments, options?.duration);

    const mergedHasIntro = mergedSegments.some((s) => s.type === 'intro');
    const mergedHasRecap = mergedSegments.some((s) => s.type === 'recap');
    const mergedHasCredits = mergedSegments.some((s) => s.type === 'credits');
    const mergedHasPostCredits = mergedSegments.some((s) => s.type === 'post_credits');
    const mergedHasPreview = mergedSegments.some((s) => s.type === 'preview');

    // Distinguish confirmed absence vs network error:
    const isConfirmedEmpty =
      mergedSegments.length === 0 &&
      ((theIntroDbResult?.isConfirmedEmpty && (!ids.imdbId || !this.isSkipDbEnabled() || !isUsefulDataMissing || skipDbResult?.isConfirmedEmpty)) ||
       (skipDbResult?.isConfirmedEmpty && (!theIntroDbResult || theIntroDbResult.isConfirmedEmpty)));

    const record: MediaSegmentsRecord = {
      mediaKey,
      channelId: channel.id,
      tvdbId: ids.tvdbId,
      tmdbId: ids.tmdbId,
      imdbId: ids.imdbId,
      season: isMovie ? undefined : seasonNum,
      episode: isMovie ? undefined : episodeNum,
      segments: mergedSegments,
      hasIntro: mergedHasIntro,
      hasRecap: mergedHasRecap,
      hasCredits: mergedHasCredits,
      hasPostCredits: mergedHasPostCredits,
      hasPreview: mergedHasPreview,
      noIntro: !mergedHasIntro,
      noRecap: !mergedHasRecap,
      noOutro: !mergedHasCredits,
      noPreview: !mergedHasPreview,
      isConfirmedEmpty,
      primarySource: 'theintrodb',
      secondarySource: secondarySegments.length > 0 ? 'skipdb' : undefined,
      lastUpdated: Date.now(),
    };

    // Only persist to IndexedDB if segments exist OR confirmed absence
    if (mergedSegments.length > 0 || isConfirmedEmpty) {
      await this.cacheService.setPlaybackSegments(record);
    }

    return mergedSegments;
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
   * Resolves external IDs (TVDB and TMDB) directly and keylessly from Cinemeta metadata endpoint.
   */
  public async resolveExternalIdsFromCinemeta(imdbId: string): Promise<{ tvdbId?: number; tmdbId?: number }> {
    if (!imdbId || !imdbId.startsWith('tt')) return {};
    const url = `https://v3-cinemeta.strem.io/meta/series/${encodeURIComponent(imdbId)}.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return {};
      const data = await resp.json();
      const meta = data?.meta;
      const tvdbId = typeof meta?.tvdb_id === 'number' ? meta.tvdb_id : (meta?.tvdb_id ? parseInt(meta.tvdb_id, 10) : undefined);
      const tmdbId = typeof meta?.moviedb_id === 'number' ? meta.moviedb_id : (meta?.moviedb_id ? parseInt(meta.moviedb_id, 10) : undefined);
      return {
        tvdbId: tvdbId && !isNaN(tvdbId) ? tvdbId : undefined,
        tmdbId: tmdbId && !isNaN(tmdbId) ? tmdbId : undefined,
      };
    } catch {
      clearTimeout(timer);
      return {};
    }
  }

  /**
   * Internal fetcher querying TheIntroDB v4 endpoint.
   * Tries available identifiers in fallback sequence (tvdb_id -> imdb_id -> tmdb_id)
   * to ensure valid submissions aren't missed if an external mapping is unbound.
   */
  private async fetchSegmentsFromApi(query: FetchSegmentsQuery): Promise<{
    segments: PlaybackSegment[];
    noIntro?: boolean;
    noRecap?: boolean;
    noOutro?: boolean;
    isConfirmedEmpty?: boolean;
  } | null> {
    const candidateIds: Array<{ key: 'tvdb_id' | 'imdb_id' | 'tmdb_id'; value: string | number }> = [];

    // Priority: tvdb_id -> imdb_id -> tmdb_id
    if (query.tvdbId) {
      candidateIds.push({ key: 'tvdb_id', value: query.tvdbId });
    }
    if (query.imdbId) {
      candidateIds.push({ key: 'imdb_id', value: query.imdbId });
    }
    if (query.tmdbId) {
      candidateIds.push({ key: 'tmdb_id', value: query.tmdbId });
    }

    if (candidateIds.length === 0) return null;

    let successfulPayload: any = null;
    let confirmedEmptyCount = 0;

    for (const cand of candidateIds) {
      const params = new URLSearchParams();
      params.set(cand.key, String(cand.value));

      if (!query.isMovie) {
        const s = query.seasonNum != null && query.seasonNum >= 0 ? query.seasonNum : 1;
        const e = query.episodeNum != null && query.episodeNum >= 0 ? query.episodeNum : 1;
        params.set('season', String(s));
        params.set('episode', String(e));
      }

      params.set('details', 'true');

      const url = `${THEINTRODB_BASE_URL}?${params.toString()}`;

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
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          const response = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
          });
          clearTimeout(timer);

          if (response.status === 404) {
            try {
              const errBody = await response.json();
              if (errBody?.code === 'no_submissions' || errBody?.code === 'episode_not_found') {
                confirmedEmptyCount++;
              }
            } catch {}
            continue;
          }

          if (!response.ok) {
            continue;
          }

          raw = await response.json();
        }

        // Handle error body returned by native IPC (which succeeds with response body on 404)
        if (raw?.error) {
          if (raw.code === 'no_submissions' || raw.code === 'episode_not_found') {
            confirmedEmptyCount++;
          }
          continue;
        }

        // Check if payload contains any valid segment fields or valid TVDB media record
        if (raw && (raw.intro || raw.recap || raw.credits || raw.outro || raw.preview || raw.tvdb_id)) {
          successfulPayload = raw;
          break; // Successfully retrieved data!
        }
      } catch (err) {
        // Continue to next identifier
      }
    }

    if (!successfulPayload) {
      if (confirmedEmptyCount > 0 && confirmedEmptyCount === candidateIds.length) {
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

    const segments = this.normalizeSegments(successfulPayload);

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
  }

  /**
   * Normalizes and validates raw segment payloads from TheIntroDB v4 (or legacy formats).
   * Supports multiple segment ranges per type (arrays), timestamp conversion from ms,
   * maps outro/credits to 'credits', post_credits to 'post_credits', and preview to 'preview'.
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
          if (seg) {
            seg.source = 'theintrodb';
            segments.push(seg);
          }
        }
      } else if (typeof data === 'object') {
        const seg = this.validateSegment(type, data, fallbackDurationSec);
        if (seg) {
          seg.source = 'theintrodb';
          segments.push(seg);
        }
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

    // 5. Preview -> mapped to 'preview'
    processEntries('preview', raw.preview);

    // Sort by startTime ascending
    segments.sort((a, b) => a.startTime - b.startTime);
    return segments;
  }

  /**
   * Fetches skip segment timestamps from SkipDB (secondary source).
   * SkipDB requires an IMDb ID and supports optional season, episode, and stream duration (seconds).
   */
  public async fetchSegmentsFromSkipDb(
    imdbId: string,
    isMovie: boolean,
    seasonNum?: number,
    episodeNum?: number,
    durationSec?: number
  ): Promise<{
    segments: PlaybackSegment[];
    noIntro?: boolean;
    noRecap?: boolean;
    noOutro?: boolean;
    noPreview?: boolean;
    isConfirmedEmpty?: boolean;
  } | null> {
    if (!imdbId || !imdbId.startsWith('tt')) return null;

    const params = new URLSearchParams();
    params.set('imdb_id', imdbId);

    if (!isMovie) {
      const s = seasonNum != null && seasonNum >= 0 ? seasonNum : 1;
      const e = episodeNum != null && episodeNum >= 0 ? episodeNum : 1;
      params.set('season', String(s));
      params.set('episode', String(e));
    }

    if (durationSec != null && durationSec > 60) {
      params.set('duration', String(Math.round(durationSec)));
    }

    const url = `${SKIPDB_BASE_URL}?${params.toString()}`;

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
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const response = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.status === 404) {
          return {
            segments: [],
            noIntro: true,
            noRecap: true,
            noOutro: true,
            noPreview: true,
            isConfirmedEmpty: true,
          };
        }

        if (!response.ok) {
          console.warn(`[PlaybackSegmentService] SkipDB HTTP status: ${response.status}`);
          return null;
        }

        raw = await response.json();
      }

      // SkipDB error handling
      if (raw?.error) {
        return null;
      }

      // Check if segments object exists
      if (!raw?.segments || typeof raw.segments !== 'object') {
        return null;
      }

      // Detect confirmed absence (all segment slots null)
      const segs = raw.segments;
      const allNull =
        segs.intro == null &&
        segs.recap == null &&
        segs.outro == null &&
        segs.credits == null &&
        segs.preview == null;

      if (allNull) {
        return {
          segments: [],
          noIntro: true,
          noRecap: true,
          noOutro: true,
          noPreview: true,
          isConfirmedEmpty: true,
        };
      }

      const segments = this.normalizeSkipDbSegments(segs, durationSec);

      const hasIntro = segments.some((s) => s.type === 'intro');
      const hasRecap = segments.some((s) => s.type === 'recap');
      const hasCredits = segments.some((s) => s.type === 'credits');
      const hasPreview = segments.some((s) => s.type === 'preview');

      return {
        segments,
        noIntro: !hasIntro,
        noRecap: !hasRecap,
        noOutro: !hasCredits,
        noPreview: !hasPreview,
        isConfirmedEmpty: segments.length === 0,
      };
    } catch (err) {
      console.warn('[PlaybackSegmentService] SkipDB request failed:', err);
      return null;
    }
  }

  /**
   * Normalizes segment records returned by SkipDB API into internal PlaybackSegment format.
   * Maps 'outro' -> 'credits', handles millisecond conversion, duration matching, and confidence.
   */
  public normalizeSkipDbSegments(
    rawSegments: any,
    fallbackDurationSec?: number
  ): PlaybackSegment[] {
    if (!rawSegments || typeof rawSegments !== 'object') return [];

    const segments: PlaybackSegment[] = [];

    const processItem = (type: PlaybackSegmentType, item: any) => {
      if (!item || typeof item !== 'object') return;
      const seg = this.validateSegment(type, item, fallbackDurationSec);
      if (seg) {
        seg.source = 'skipdb';
        if (seg.confidence == null) {
          seg.confidence = item.match === 'exact' ? 0.9 : 0.75;
        }
        segments.push(seg);
      }
    };

    const processEntries = (type: PlaybackSegmentType, data: any) => {
      if (!data) return;
      if (Array.isArray(data)) {
        for (const it of data) processItem(type, it);
      } else if (typeof data === 'object') {
        processItem(type, data);
      }
    };

    // SkipDB segment types: intro, recap, outro (credits), preview, post_credits
    processEntries('intro', rawSegments.intro);
    processEntries('recap', rawSegments.recap);
    processEntries('credits', rawSegments.outro);
    processEntries('credits', rawSegments.credits);
    processEntries('preview', rawSegments.preview);
    processEntries('post_credits', rawSegments.post_credits);

    segments.sort((a, b) => a.startTime - b.startTime);
    return segments;
  }

  /**
   * Merges primary (TheIntroDB) and secondary (SkipDB) segments individually by type.
   * TheIntroDB is preferred unless SkipDB provides a significantly higher confidence / exact duration match.
   * Never blindly overwrites a valid primary timestamp with a weaker secondary match.
   */
  public mergeSegments(
    primarySegments: PlaybackSegment[],
    secondarySegments: PlaybackSegment[],
    durationSec?: number
  ): PlaybackSegment[] {
    if (!secondarySegments || secondarySegments.length === 0) {
      return [...primarySegments];
    }
    if (!primarySegments || primarySegments.length === 0) {
      return [...secondarySegments];
    }

    const merged: PlaybackSegment[] = [];
    const allTypes: PlaybackSegmentType[] = ['intro', 'recap', 'credits', 'post_credits', 'preview'];

    for (const type of allTypes) {
      const pList = primarySegments.filter((s) => s.type === type);
      const sList = secondarySegments.filter((s) => s.type === type);

      if (pList.length > 0 && sList.length === 0) {
        merged.push(...pList);
      } else if (pList.length === 0 && sList.length > 0) {
        merged.push(...sList);
      } else if (pList.length > 0 && sList.length > 0) {
        // Both sources provide this segment type.
        // Compare reliability: confidence and duration compatibility.
        const pSeg = pList[0];
        const sSeg = sList[0];

        const pConf = typeof pSeg.confidence === 'number' ? pSeg.confidence : 0.7;
        const sConf = typeof sSeg.confidence === 'number' ? sSeg.confidence : 0.7;

        // Never blindly overwrite an existing valid timestamp with a weaker match.
        // Only prefer secondary if secondary confidence is significantly higher (>= 0.2 higher)
        // and has valid duration.
        if (sConf >= pConf + 0.2 && sSeg.endTime > sSeg.startTime + 4) {
          merged.push(...sList);
        } else {
          merged.push(...pList);
        }
      }
    }

    merged.sort((a, b) => a.startTime - b.startTime);
    return merged;
  }

  /**
   * Validates a single segment candidate.
   * Ensures start >= 0, end > start, duration >= 2s, and non-NaN timestamps.
   * Handles null start_ms for intro/recap/preview (defaults to 0) and null end_ms for credits/preview/post_credits.
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
      if (type === 'intro' || type === 'recap' || type === 'preview') {
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
      if (type === 'credits' || type === 'preview' || type === 'post_credits') {
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
    if (!enrichment && channel.series_id) {
      enrichment = this.cacheService.getEnrichmentSync(channel.series_id) || (await this.cacheService.getEnrichment(channel.series_id));
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
    if (!result.tvdbId || !result.imdbId) {
      const titleCandidates = [
        seriesTitle,
        seriesChannel?.name,
        channel.name,
      ].filter((t): t is string => !!t && t.trim().length > 0);

      for (const title of titleCandidates) {
        const cinemetaImdb = await this.resolveImdbIdFromCinemeta(title, 'tv');
        if (cinemetaImdb) {
          if (!result.imdbId) result.imdbId = cinemetaImdb;
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
          break;
        }
      }
    }

    // 5. Fallback: check if the episode itself has an IMDb ID and resolve its series via TMDB
    const episodeImdbId = extractImdbId(channel.name) || extractImdbId(channel.url);
    if (!result.tvdbId && episodeImdbId && episodeImdbId !== directImdb) {
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
        }
      } catch {}
    }

    // 6. Free keyless resolution of TVDB ID via Cinemeta meta endpoint if not yet resolved
    if (result.imdbId && !result.tvdbId) {
      try {
        const cinemetaIds = await this.resolveExternalIdsFromCinemeta(result.imdbId);
        if (cinemetaIds.tvdbId) {
          result.tvdbId = cinemetaIds.tvdbId;
        }
        if (cinemetaIds.tmdbId && !result.tmdbId) {
          result.tmdbId = cinemetaIds.tmdbId;
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
      const sMatch =
        name.match(/\b[Ss](\d{1,2})\s*[Ee]\d{1,3}\b/) ||
        name.match(/\b[Ss](\d{1,2})\b/) ||
        name.match(/\b(\d{1,2})x\d{1,3}\b/) ||
        name.match(/\bseason\s*(\d{1,2})\b/i);
      s = sMatch ? parseInt(sMatch[1], 10) : 1;
    }

    if (e == null) {
      const eMatch =
        name.match(/\b[Ss]\d{1,2}\s*[Ee](\d{1,3})\b/) ||
        name.match(/\b[Ee](\d{1,3})\b/) ||
        name.match(/\b\d{1,2}x(\d{1,3})\b/) ||
        name.match(/\b(?:episode|ep)[\s._-]*(\d{1,3})\b/i);
      e = eMatch ? parseInt(eMatch[1], 10) : 1;
    }

    return { seasonNum: s, episodeNum: e };
  }
}
