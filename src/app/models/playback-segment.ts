export type PlaybackSegmentType = 'intro' | 'recap' | 'credits' | 'post_credits';

export interface PlaybackSegment {
  type: PlaybackSegmentType;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  confidence?: number;
}

export interface MediaSegmentsRecord {
  mediaKey: string;
  channelId?: number;
  imdbId?: string;
  tmdbId?: number;
  tvdbId?: number;
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
