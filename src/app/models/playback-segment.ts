export type PlaybackSegmentType = 'intro' | 'recap' | 'credits' | 'post_credits' | 'preview';

export interface PlaybackSegment {
  type: PlaybackSegmentType;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  confidence?: number;
  source?: 'theintrodb' | 'skipdb';
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
  hasPreview?: boolean;
  noIntro?: boolean;
  noRecap?: boolean;
  noOutro?: boolean;
  noPreview?: boolean;
  isConfirmedEmpty?: boolean;
  primarySource?: 'theintrodb';
  secondarySource?: 'skipdb';
  lastUpdated: number;
}
