import { Injectable } from '@angular/core';
import {
  TmdbCastMember,
  TmdbEpisodeDetail,
  TmdbMediaEnrichment,
  TmdbSeasonDetail,
  TmdbVideo,
} from '../models/tmdb';
import { TmdbConfigService } from './tmdb-config.service';

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const REQUEST_TIMEOUT_MS = 10000;

@Injectable({
  providedIn: 'root',
})
export class TmdbService {
  constructor(private configService: TmdbConfigService) {}

  private getAuthHeader(): { Authorization: string; Accept: string } | null {
    const token = this.configService.getToken()?.trim();
    if (!token) return null;
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
  }

  /**
   * Safe fetch wrapper with timeout, bearer token auth, and error handling.
   */
  private async safeGet<T>(endpoint: string, params?: Record<string, string | number | undefined>): Promise<T | null> {
    const headers = this.getAuthHeader();
    if (!headers) return null;

    let url = `${TMDB_API_BASE}${endpoint}`;
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') {
          searchParams.append(k, String(v));
        }
      }
      const qs = searchParams.toString();
      if (qs) url += `?${qs}`;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.status === 401) {
        console.warn('TMDB API Token is invalid or expired (401)');
        return null;
      }

      if (res.status === 404) {
        return null;
      }

      if (res.status === 429) {
        console.warn('TMDB API rate limit reached (429)');
        return null;
      }

      if (!res.ok) {
        console.warn(`TMDB request failed with HTTP ${res.status} for ${endpoint}`);
        return null;
      }

      return (await res.json()) as T;
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.warn(`TMDB fetch error for ${endpoint}:`, err?.message || err);
      }
      return null;
    }
  }

  /**
   * Search for movies matching query and optional release year.
   */
  async searchMovie(query: string, year?: string): Promise<any[]> {
    if (!query || query.trim().length === 0) return [];
    const data = await this.safeGet<any>('/search/movie', {
      query: query.trim(),
      primary_release_year: year,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Search for TV shows matching query and optional first air date year.
   */
  async searchTv(query: string, year?: string): Promise<any[]> {
    if (!query || query.trim().length === 0) return [];
    const data = await this.safeGet<any>('/search/tv', {
      query: query.trim(),
      first_air_date_year: year,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Fetch trending movies for discovery from TMDB.
   */
  async getTrendingMovies(timeWindow: 'day' | 'week' = 'week'): Promise<any[]> {
    const data = await this.safeGet<any>(`/trending/movie/${timeWindow}`);
    return data?.results || [];
  }

  /**
   * Fetch trending TV shows for discovery from TMDB.
   */
  async getTrendingTv(timeWindow: 'day' | 'week' = 'week'): Promise<any[]> {
    const data = await this.safeGet<any>(`/trending/tv/${timeWindow}`);
    return data?.results || [];
  }

  /**
   * Fetch Korean TV shows from TMDB discover.
   */
  async getKoreanTv(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams: Record<string, string | number | undefined> = {}
  ): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/tv', {
      with_original_language: 'ko',
      sort_by: sortBy,
      page,
      include_adult: 'false',
      ...extraParams,
    });
    return data?.results || [];
  }

  /**
   * Fetch Anime TV shows from TMDB discover (genre 16, Japanese original language).
   */
  async getAnimeTv(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams: Record<string, string | number | undefined> = {}
  ): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/tv', {
      with_genres: 16,
      with_original_language: 'ja',
      sort_by: sortBy,
      page,
      include_adult: 'false',
      ...extraParams,
    });
    return data?.results || [];
  }

  /**
   * Fetch Anime movies from TMDB discover (genre 16, Japanese original language).
   */
  async getAnimeMovies(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams: Record<string, string | number | undefined> = {}
  ): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/movie', {
      with_genres: 16,
      with_original_language: 'ja',
      sort_by: sortBy,
      page,
      include_adult: 'false',
      ...extraParams,
    });
    return data?.results || [];
  }

  /**
   * Fetch animated TV shows from TMDB discover (genre 16).
   */
  async getAnimationTv(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams: Record<string, string | number | undefined> = {}
  ): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/tv', {
      with_genres: 16,
      sort_by: sortBy,
      page,
      include_adult: 'false',
      ...extraParams,
    });
    return data?.results || [];
  }

  /**
   * Fetch animated movies from TMDB discover (genre 16).
   */
  async getAnimationMovies(
    page: number = 1,
    sortBy: string = 'popularity.desc',
    extraParams: Record<string, string | number | undefined> = {}
  ): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/movie', {
      with_genres: 16,
      sort_by: sortBy,
      page,
      include_adult: 'false',
      ...extraParams,
    });
    return data?.results || [];
  }

  /**
   * Fetch popular movies from TMDB.
   */
  async getPopularMovies(page: number = 1): Promise<any[]> {
    const data = await this.safeGet<any>('/movie/popular', {
      page,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Fetch popular TV shows from TMDB.
   */
  async getPopularTv(page: number = 1): Promise<any[]> {
    const data = await this.safeGet<any>('/tv/popular', {
      page,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Fetch top rated movies from TMDB.
   */
  async getTopRatedMovies(page: number = 1): Promise<any[]> {
    const data = await this.safeGet<any>('/movie/top_rated', {
      page,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Fetch top rated TV shows from TMDB.
   */
  async getTopRatedTv(page: number = 1): Promise<any[]> {
    const data = await this.safeGet<any>('/tv/top_rated', {
      page,
      include_adult: 'false',
    });
    return data?.results || [];
  }

  /**
   * Custom discover query for movies (e.g. genre filter, minimum votes, sorting).
   */
  async discoverMovies(params: Record<string, string | number | undefined> = {}): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/movie', {
      include_adult: 'false',
      sort_by: 'popularity.desc',
      ...params,
    });
    return data?.results || [];
  }

  /**
   * Custom discover query for TV shows (e.g. genre filter, minimum votes, sorting).
   */
  async discoverTv(params: Record<string, string | number | undefined> = {}): Promise<any[]> {
    const data = await this.safeGet<any>('/discover/tv', {
      include_adult: 'false',
      sort_by: 'popularity.desc',
      ...params,
    });
    return data?.results || [];
  }

  /**
   * Get movie recommendations based on a seed movie ID.
   */
  async getMovieRecommendations(movieId: number, page: number = 1): Promise<any[]> {
    if (!movieId) return [];
    const data = await this.safeGet<any>(`/movie/${movieId}/recommendations`, { page });
    return data?.results || [];
  }

  /**
   * Get TV show recommendations based on a seed TV show ID.
   */
  async getTvRecommendations(tvId: number, page: number = 1): Promise<any[]> {
    if (!tvId) return [];
    const data = await this.safeGet<any>(`/tv/${tvId}/recommendations`, { page });
    return data?.results || [];
  }

  /**
   * Get similar movies based on a seed movie ID.
   */
  async getSimilarMovies(movieId: number, page: number = 1): Promise<any[]> {
    if (!movieId) return [];
    const data = await this.safeGet<any>(`/movie/${movieId}/similar`, { page });
    return data?.results || [];
  }

  /**
   * Get similar TV shows based on a seed TV show ID.
   */
  async getSimilarTv(tvId: number, page: number = 1): Promise<any[]> {
    if (!tvId) return [];
    const data = await this.safeGet<any>(`/tv/${tvId}/similar`, { page });
    return data?.results || [];
  }

  /**
   * Find media by external ID (e.g. IMDb ID 'tt1234567').
   */
  async findByExternalId(externalId: string, externalSource: 'imdb_id' = 'imdb_id'): Promise<any | null> {
    if (!externalId) return null;
    return await this.safeGet<any>(`/find/${encodeURIComponent(externalId)}`, {
      external_source: externalSource,
    });
  }

  /**
   * Fetch full movie details including credits and videos (trailers).
   */
  async getMovieDetails(movieId: number): Promise<any | null> {
    return await this.safeGet<any>(`/movie/${movieId}`, {
      append_to_response: 'credits,videos,images',
      include_image_language: 'en,hi,null,ja,ko,es,fr,de,it,pt,zh',
    });
  }

  /**
   * Fetch full TV show details including credits and videos.
   */
  async getTvDetails(tvId: number): Promise<any | null> {
    return await this.safeGet<any>(`/tv/${tvId}`, {
      append_to_response: 'credits,videos,images',
      include_image_language: 'en,hi,null,ja,ko,es,fr,de,it,pt,zh',
    });
  }

  /**
   * Fetch season details for a TV show, including episode metadata.
   */
  async getTvSeasonDetails(tvId: number, seasonNumber: number): Promise<any | null> {
    return await this.safeGet<any>(`/tv/${tvId}/season/${seasonNumber}`);
  }

  /**
   * Fetch external IDs for a TV show (IMDb ID, TVDB ID, etc.).
   */
  async getTvExternalIds(tvId: number): Promise<any | null> {
    if (!tvId) return null;
    return await this.safeGet<any>(`/tv/${tvId}/external_ids`);
  }

  /**
   * Fetch external IDs for a specific TV episode (episode-specific IMDb ID, etc.).
   */
  async getTvEpisodeExternalIds(tvId: number, seasonNumber: number, episodeNumber: number): Promise<any | null> {
    if (!tvId || seasonNumber == null || episodeNumber == null) return null;
    return await this.safeGet<any>(`/tv/${tvId}/season/${seasonNumber}/episode/${episodeNumber}/external_ids`);
  }

  /**
   * Parses raw TMDB movie details into our normalized detail-screen ready model.
   */
  parseMovieDetails(
    raw: any,
    matchConfidence: number,
    normalizedTitle: string,
    providerItemId?: number,
  ): TmdbMediaEnrichment {
    const cast: TmdbCastMember[] = (raw.credits?.cast || [])
      .slice(0, 10)
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
      }));

    const directorMember = (raw.credits?.crew || []).find(
      (cr: any) => cr.job === 'Director',
    );

    const trailers: TmdbVideo[] = (raw.videos?.results || [])
      .filter((v: any) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .slice(0, 3)
      .map((v: any) => ({
        id: v.id,
        key: v.key,
        name: v.name,
        site: v.site,
        type: v.type,
        official: v.official,
      }));

    const genres: string[] = (raw.genres || []).map((g: any) => g.name);
    const releaseYear = raw.release_date && raw.release_date.length >= 4 ? raw.release_date.substring(0, 4) : undefined;
    const logoResult = extractBestLogo(raw.images, raw.original_language);
    const logoPath = logoResult?.path;
    const logoLanguage = logoResult?.language;
    const backdropResult = extractBestBackdropPath(raw.backdrop_path, raw.poster_path, raw.images);
    const backdropPath = backdropResult.best;
    const backdropPaths = backdropResult.all.length > 0 ? backdropResult.all : undefined;

    return {
      providerItemId,
      tmdbId: raw.id,
      mediaType: 'movie',
      normalizedTitle,
      matchedTitle: raw.title || raw.original_title || normalizedTitle,
      originalTitle: raw.original_title,
      matchConfidence,
      overview: raw.overview?.trim() || undefined,
      posterPath: raw.poster_path || undefined,
      backdropPath,
      backdropPaths,
      backdropVersion: 1,
      logoPath,
      logoLanguage,
      logoVersion: 2,
      releaseDate: raw.release_date || undefined,
      releaseYear,
      genres: genres.length > 0 ? genres : undefined,
      rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : undefined,
      voteCount: raw.vote_count,
      runtime: raw.runtime || undefined,
      tagline: raw.tagline?.trim() || undefined,
      cast: cast.length > 0 ? cast : undefined,
      director: directorMember?.name,
      imdbId: raw.imdb_id,
      originalLanguage: raw.original_language || undefined,
      originCountry: Array.isArray(raw.origin_country)
        ? raw.origin_country
        : (raw.production_countries || []).map((p: any) => p.iso_3166_1).filter(Boolean),
      trailers: trailers.length > 0 ? trailers : undefined,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Parses raw TMDB TV show details into our normalized detail-screen ready model.
   */
  parseTvDetails(
    raw: any,
    matchConfidence: number,
    normalizedTitle: string,
    providerItemId?: number,
  ): TmdbMediaEnrichment {
    const cast: TmdbCastMember[] = (raw.credits?.cast || [])
      .slice(0, 14)
      .map((c: any) => ({
        id: c.id,
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
      }));

    const trailers: TmdbVideo[] = (raw.videos?.results || [])
      .filter((v: any) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .sort((a: any, b: any) => {
        if (a.type === 'Trailer' && b.type !== 'Trailer') return -1;
        if (b.type === 'Trailer' && a.type !== 'Trailer') return 1;
        if (a.official && !b.official) return -1;
        if (b.official && !a.official) return 1;
        return 0;
      })
      .slice(0, 3)
      .map((v: any) => ({
        id: v.id,
        key: v.key,
        name: v.name,
        site: v.site,
        type: v.type,
        official: v.official,
      }));

    const genres: string[] = (raw.genres || []).map((g: any) => g.name);
    const releaseYear = raw.first_air_date && raw.first_air_date.length >= 4 ? raw.first_air_date.substring(0, 4) : undefined;
    const runtime = raw.episode_run_time && raw.episode_run_time.length > 0 ? raw.episode_run_time[0] : undefined;
    const logoResult = extractBestLogo(raw.images, raw.original_language);
    const logoPath = logoResult?.path;
    const logoLanguage = logoResult?.language;
    const backdropResult = extractBestBackdropPath(raw.backdrop_path, raw.poster_path, raw.images);
    const backdropPath = backdropResult.best;
    const backdropPaths = backdropResult.all.length > 0 ? backdropResult.all : undefined;

    return {
      providerItemId,
      tmdbId: raw.id,
      mediaType: 'tv',
      normalizedTitle,
      matchedTitle: raw.name || raw.original_name || normalizedTitle,
      originalTitle: raw.original_name,
      matchConfidence,
      overview: raw.overview?.trim() || undefined,
      posterPath: raw.poster_path || undefined,
      backdropPath,
      backdropPaths,
      backdropVersion: 1,
      logoPath,
      logoLanguage,
      logoVersion: 2,
      releaseDate: raw.first_air_date || undefined,
      releaseYear,
      genres: genres.length > 0 ? genres : undefined,
      rating: raw.vote_average ? Math.round(raw.vote_average * 10) / 10 : undefined,
      voteCount: raw.vote_count,
      runtime,
      tagline: raw.tagline?.trim() || undefined,
      cast: cast.length > 0 ? cast : undefined,
      trailers: trailers.length > 0 ? trailers : undefined,
      numberOfSeasons: raw.number_of_seasons,
      numberOfEpisodes: raw.number_of_episodes,
      lastAirDate: raw.last_air_date || undefined,
      status: raw.status || undefined,
      creator: (raw.created_by && raw.created_by.length > 0)
        ? raw.created_by.map((c: any) => c.name).join(', ')
        : undefined,
      originalLanguage: raw.original_language || undefined,
      originCountry: Array.isArray(raw.origin_country)
        ? raw.origin_country
        : (raw.production_countries || []).map((p: any) => p.iso_3166_1).filter(Boolean),
      lastUpdated: Date.now(),
    };
  }

  /**
   * Parses raw TMDB season details into normalized model.
   */
  parseSeasonDetails(raw: any, tmdbId: number): TmdbSeasonDetail {
    const episodes: TmdbEpisodeDetail[] = (raw.episodes || []).map((ep: any) => ({
      id: ep.id,
      episodeNumber: ep.episode_number,
      seasonNumber: ep.season_number,
      name: ep.name,
      overview: ep.overview?.trim() || undefined,
      stillPath: ep.still_path || undefined,
      airDate: ep.air_date || undefined,
      voteAverage: ep.vote_average ? Math.round(ep.vote_average * 10) / 10 : undefined,
      runtime: ep.runtime || undefined,
    }));

    return {
      id: raw.id,
      tmdbId,
      seasonNumber: raw.season_number,
      name: raw.name,
      overview: raw.overview?.trim() || undefined,
      posterPath: raw.poster_path || undefined,
      airDate: raw.air_date || undefined,
      episodeCount: episodes.length,
      episodes,
      lastUpdated: Date.now(),
    };
  }
}

export interface ExtractedLogo {
  path: string;
  language?: string;
}

/**
 * Selects the best title logo artwork from TMDB raw.images?.logos.
 *
 * Strict Localization Policy:
 * 1. English ("en")
 * 2. Hindi ("hi")
 * 3. Language-neutral artwork (no language specified / null)
 * 4. Sensible fallback: Authentic original language of the title (if neither en, hi, nor neutral exists)
 *
 * Unrelated foreign language versions (such as Spanish "es" for non-Spanish titles)
 * are disqualified to prevent displaying inappropriate localized artwork.
 */
function extractBestLogo(images: any, originalLanguage?: string): ExtractedLogo | undefined {
  const logos: any[] = images?.logos;
  if (!logos || !Array.isArray(logos) || logos.length === 0) {
    return undefined;
  }
  const valid = logos.filter(
    (l) => l && typeof l.file_path === 'string' && l.file_path.trim() !== '',
  );
  if (valid.length === 0) return undefined;

  const normalizeLang = (val: unknown): string => {
    if (typeof val !== 'string') return '';
    const trimmed = val.trim().toLowerCase();
    if (trimmed === 'null' || trimmed === 'undefined' || trimmed === 'xx') return '';
    return trimmed.split(/[-_]/)[0];
  };

  const normOrigLang = normalizeLang(originalLanguage);

  const getLanguageTier = (logo: any): number => {
    const lang = normalizeLang(logo.iso_639_1);
    // 1. English ("en")
    if (lang === 'en') return 4;
    // 2. Hindi ("hi")
    if (lang === 'hi') return 3;
    // 3. Language-neutral (no language specified, e.g. null, empty, "null")
    if (!lang) return 2;
    // 4. Sensible fallback: authentic original language of the title
    if (normOrigLang && lang === normOrigLang) return 1;
    // Disqualified: unrelated foreign language (e.g. Spanish for Hindi/English titles)
    return 0;
  };

  const eligible = valid.filter((logo) => getLanguageTier(logo) > 0);
  if (eligible.length === 0) {
    return undefined;
  }

  const scored = [...eligible].sort((a, b) => {
    const aTier = getLanguageTier(a);
    const bTier = getLanguageTier(b);
    if (aTier !== bTier) return bTier - aTier;

    // Within the same tier, sort by community rating quality (vote_average * vote_count)
    const aScore = (Number(a.vote_average) || 0) * (Number(a.vote_count) || 1);
    const bScore = (Number(b.vote_average) || 0) * (Number(b.vote_count) || 1);
    if (aScore !== bScore) return bScore - aScore;

    // Then prefer higher resolution (width)
    return (Number(b.width) || 0) - (Number(a.width) || 0);
  });

  const best = scored[0];
  if (!best?.file_path) return undefined;

  return {
    path: best.file_path,
    language: normalizeLang(best.iso_639_1) || undefined,
  };
}

function extractBestLogoPath(images: any, originalLanguage?: string): string | undefined {
  return extractBestLogo(images, originalLanguage)?.path;
}

/**
 * Selects cinematic landscape backdrops from TMDB's backdrop collection starting strictly from index 1.
 * Index 0 (TMDB's default/first backdrop, often identical to or derived from the poster/thumbnail)
 * is strictly excluded from selection and rotation.
 * If only 1 backdrop is available (or <= 1 remaining), returns undefined to trigger the clean fallback behaviour.
 */
function extractBestBackdropPath(
  primaryBackdrop: any,
  posterPath: any,
  images: any,
): { best: string | undefined; all: string[] } {
  const normPath = (p: unknown): string => {
    if (typeof p !== 'string') return '';
    const trimmed = p.trim();
    if (!trimmed) return '';
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  };

  // Build a comprehensive set of excluded poster paths from primary poster and all poster collections
  const excludedPosterPaths = new Set<string>();
  const primaryPoster = normPath(posterPath);
  if (primaryPoster) {
    excludedPosterPaths.add(primaryPoster);
  }
  if (Array.isArray(images?.posters)) {
    for (const p of images.posters) {
      const pPath = normPath(p?.file_path);
      if (pPath) excludedPosterPaths.add(pPath);
    }
  }

  const rawBackdrops: any[] = Array.isArray(images?.backdrops) ? images.backdrops : [];

  // Exclude index 0 from TMDB's backdrops collection and primary backdrop
  const excludedBackdropPaths = new Set<string>();
  if (rawBackdrops.length > 0) {
    const firstBackdropPath = normPath(rawBackdrops[0]?.file_path);
    if (firstBackdropPath) excludedBackdropPaths.add(firstBackdropPath);
  }
  const primary = normPath(primaryBackdrop);
  if (primary) {
    excludedBackdropPaths.add(primary);
  }

  // Never select index 0; start selection strictly from index 1
  // If there is only 1 (or 0) backdrop available, remaining entries are empty
  const remainingCandidates = rawBackdrops.length > 1 ? rawBackdrops.slice(1) : [];

  if (remainingCandidates.length === 0) {
    return { best: undefined, all: [] };
  }

  // Filter candidates: strictly require landscape aspect ratio, non-poster paths, and non-index-0 paths
  const valid = remainingCandidates.filter((b) => {
    const filePath = normPath(b?.file_path);
    if (!filePath || excludedPosterPaths.has(filePath) || excludedBackdropPaths.has(filePath)) {
      return false;
    }

    const width = Number(b.width);
    const height = Number(b.height);
    if (width > 0 && height > 0) {
      // Must be cinematic landscape (reject 2:3 portraits ~0.67 and near-square artwork)
      if (width / height < 1.33) return false;
    }
    const aspectRatio = Number(b.aspect_ratio);
    if (aspectRatio > 0 && aspectRatio < 1.33) return false;

    return true;
  });

  if (valid.length === 0) {
    return { best: undefined, all: [] };
  }

  const scored = [...valid].sort((a, b) => {
    // 1. Cinematic 16:9 aspect ratio proximity (16/9 ~ 1.778)
    const aAspect = Number(a.width) && Number(a.height) ? Number(a.width) / Number(a.height) : Number(a.aspect_ratio) || 0;
    const bAspect = Number(b.width) && Number(b.height) ? Number(b.width) / Number(b.height) : Number(b.aspect_ratio) || 0;
    const aAspectScore = aAspect ? -Math.abs(aAspect - (16 / 9)) : -1;
    const bAspectScore = bAspect ? -Math.abs(bAspect - (16 / 9)) : -1;
    if (Math.abs(aAspectScore - bAspectScore) > 0.05) return bAspectScore - aAspectScore;

    // 2. Community vote quality
    const aScore = (Number(a.vote_average) || 0) * (Number(a.vote_count) || 1);
    const bScore = (Number(b.vote_average) || 0) * (Number(b.vote_count) || 1);
    if (aScore !== bScore) return bScore - aScore;

    // 3. Prefer higher resolution
    const aPixels = (Number(a.width) || 0) * (Number(a.height) || 0);
    const bPixels = (Number(b.width) || 0) * (Number(b.height) || 0);
    if (aPixels !== bPixels) return bPixels - aPixels;

    // 4. Prefer language-neutral or English
    const aLang = !a.iso_639_1 ? 2 : (a.iso_639_1 === 'en' ? 1 : 0);
    const bLang = !b.iso_639_1 ? 2 : (b.iso_639_1 === 'en' ? 1 : 0);
    return bLang - aLang;
  });

  // Extract unique paths in sorted priority order
  const seenPaths = new Set<string>();
  const allPaths: string[] = [];
  for (const s of scored) {
    const p = normPath(s.file_path);
    if (p && !seenPaths.has(p) && !excludedPosterPaths.has(p) && !excludedBackdropPaths.has(p)) {
      seenPaths.add(p);
      allPaths.push(p);
    }
  }

  return { best: allPaths[0] || undefined, all: allPaths };
}

