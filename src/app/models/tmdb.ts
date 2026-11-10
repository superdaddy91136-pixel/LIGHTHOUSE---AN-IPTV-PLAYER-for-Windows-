export interface TmdbConfig {
  enabled: boolean;
  token?: string;
}

export type TmdbConnectionStatus =
  | 'not_configured'
  | 'testing'
  | 'connected'
  | 'invalid_token'
  | 'error';

export interface TmdbCastMember {
  id: number;
  name: string;
  character?: string;
  profilePath?: string;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job: string;
  department?: string;
}

export interface TmdbVideo {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official?: boolean;
}

export interface TmdbEpisodeDetail {
  id: number;
  episodeNumber: number;
  seasonNumber: number;
  name: string;
  overview?: string;
  stillPath?: string;
  airDate?: string;
  voteAverage?: number;
  runtime?: number;
}

export interface TmdbSeasonDetail {
  id?: number;
  tmdbId: number;
  seasonNumber: number;
  name?: string;
  overview?: string;
  posterPath?: string;
  airDate?: string;
  episodeCount?: number;
  episodes?: TmdbEpisodeDetail[];
  lastUpdated: number;
}

/**
 * Enriched metadata model linked to an IPTV provider channel.
 * Designed to power Home discovery as well as future Movie & TV detail screens.
 */
export interface TmdbMediaEnrichment {
  /** The local IPTV channel ID linking this metadata to the provider stream */
  providerItemId?: number;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  normalizedTitle: string;
  matchedTitle: string;
  originalTitle?: string;
  /** Match confidence level between 0.0 and 1.0 */
  matchConfidence: number;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  /** All valid landscape backdrop paths starting from index 1, quality-sorted (best first). Used for detail-screen rotation. */
  backdropPaths?: string[];
  backdropVersion?: number;
  logoPath?: string;
  logoLanguage?: string;
  logoVersion?: number;
  releaseDate?: string;
  releaseYear?: string;
  genres?: string[];
  rating?: number;
  voteCount?: number;
  runtime?: number;
  tagline?: string;
  cast?: TmdbCastMember[];
  director?: string;
  imdbId?: string;
  originalLanguage?: string;
  originCountry?: string[];
  trailers?: TmdbVideo[];
  numberOfSeasons?: number;
  numberOfEpisodes?: number;
  lastAirDate?: string;
  status?: string;
  creator?: string;
  lastUpdated: number;
}

/**
 * Negative cache record to avoid repeating futile searches for unmatched items.
 */
export interface TmdbFailedMatch {
  searchKey: string;
  normalizedTitle: string;
  mediaType: 'movie' | 'tv';
  year?: string;
  attemptedAt: number;
  retryAfter: number;
}
