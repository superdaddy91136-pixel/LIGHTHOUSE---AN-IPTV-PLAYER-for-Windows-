export type PlaybackSegmentType = 'intro' | 'recap' | 'credits' | 'post_credits';

export interface PlaybackSegment {
  type: PlaybackSegmentType;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  confidence?: number;
}

export interface MediaSegmentsRecord {
  mediaKey: string;
  imdbId?: string;
  tmdbId?: number;
  season?: number;
  episode?: number;
  segments: PlaybackSegment[];
  hasIntro: boolean;
  hasRecap: boolean;
  hasCredits: boolean;
  hasPostCredits?: boolean;
  noIntro?: boolean;
  noRecap?: boolean;
  noOutro?: boolean;
  isConfirmedEmpty?: boolean;
  lastUpdated: number;
}
