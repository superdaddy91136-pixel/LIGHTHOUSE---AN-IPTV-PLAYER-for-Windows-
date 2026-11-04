import { PlaybackSegmentService } from './playback-segment.service';

describe('PlaybackSegmentService', () => {
  let service: PlaybackSegmentService;
  const mockTmdbEnrichment: any = { getEnrichmentSync: () => undefined, getEnrichment: () => Promise.resolve(undefined) };
  const mockTmdbService: any = { findByExternalId: () => Promise.resolve(null), getTvExternalIds: () => Promise.resolve(null) };
  const mockCacheService: any = {
    getPlaybackSegmentsSync: () => undefined,
    getPlaybackSegments: () => Promise.resolve(undefined),
    setPlaybackSegments: () => Promise.resolve(),
    getEnrichment: () => Promise.resolve(undefined),
  };

  beforeEach(() => {
    service = new PlaybackSegmentService(mockTmdbEnrichment, mockTmdbService, mockCacheService);
  });

  describe('normalizeSegments', () => {
    it('should correctly normalize and validate TheIntroDB v4 array segment payloads', () => {
      const v4Payload = {
        tvdb_id: 71663,
        type: 'tv',
        season: 1,
        episode: 1,
        group_duration_ms: 1400000,
        intro: [
          {
            start_ms: null,
            end_ms: 24724,
            confidence: 0.88,
          },
        ],
        recap: [
          {
            start_ms: 0,
            end_ms: 0, // 0-length no-recap marker
          },
        ],
        credits: [
          {
            start_ms: 1332112,
            end_ms: null, // Runs until group_duration_ms
            confidence: 0.6,
          },
        ],
      };

      const segments = service.normalizeSegments(v4Payload);

      expect(segments.length).toBe(2);
      // Intro: start null -> 0, end 24724ms -> 24.7s
      expect(segments[0].type).toBe('intro');
      expect(segments[0].startTime).toBe(0);
      expect(segments[0].endTime).toBe(24.7);
      expect(segments[0].confidence).toBe(0.88);

      // Credits: start 1332112ms -> 1332.1s, end null -> group_duration_ms (1400s)
      expect(segments[1].type).toBe('credits');
      expect(segments[1].startTime).toBe(1332.1);
      expect(segments[1].endTime).toBe(1400);
      expect(segments[1].confidence).toBe(0.6);
    });

    it('should handle multiple intro ranges in TheIntroDB v4 format', () => {
      const payload = {
        intro: [
          { start_ms: 30000, end_ms: 90000 },
          { start_ms: 120000, end_ms: 150000 },
        ],
      };

      const segments = service.normalizeSegments(payload);
      expect(segments.length).toBe(2);
      expect(segments[0].type).toBe('intro');
      expect(segments[0].startTime).toBe(30);
      expect(segments[0].endTime).toBe(90);

      expect(segments[1].type).toBe('intro');
      expect(segments[1].startTime).toBe(120);
      expect(segments[1].endTime).toBe(150);
    });

    it('should correctly normalize and validate legacy/single-object segment payloads', () => {
      const rawPayload = {
        imdb_id: 'tt0944947',
        media_type: 'tv',
        season: 1,
        episode: 1,
        intro: {
          start_sec: 437.2,
          end_sec: 531.8,
          confidence: 0.95,
        },
        recap: {
          start_sec: 0,
          end_sec: 45,
          confidence: 0.88,
        },
        outro: {
          start_sec: 3631.5,
          end_sec: 3699.5,
          confidence: 1.0,
        },
      };

      const segments = service.normalizeSegments(rawPayload);

      expect(segments.length).toBe(3);
      // Sorted by startTime ascending: recap (0), intro (437.2), credits (3631.5)
      expect(segments[0].type).toBe('recap');
      expect(segments[0].startTime).toBe(0);
      expect(segments[0].endTime).toBe(45);

      expect(segments[1].type).toBe('intro');
      expect(segments[1].startTime).toBe(437.2);
      expect(segments[1].endTime).toBe(531.8);
      expect(segments[1].confidence).toBe(0.95);

      expect(segments[2].type).toBe('credits');
      expect(segments[2].startTime).toBe(3631.5);
      expect(segments[2].endTime).toBe(3699.5);
      expect(segments[2].confidence).toBe(1.0);
    });

    it('should filter out invalid timestamps (negative, start >= end, < 2s duration)', () => {
      const invalidPayload = {
        intro: { start_sec: 50, end_sec: 51 }, // only 1 second duration
        recap: { start_sec: 100, end_sec: 90 }, // end < start
        outro: { start_sec: -5, end_sec: 20 },  // negative start
      };

      const segments = service.normalizeSegments(invalidPayload);
      expect(segments.length).toBe(0);
    });

    it('should handle millisecond timestamps if seconds are omitted', () => {
      const msPayload = {
        intro: { start_ms: 30000, end_ms: 90000, confidence: 1 },
      };

      const segments = service.normalizeSegments(msPayload);
      expect(segments.length).toBe(1);
      expect(segments[0].type).toBe('intro');
      expect(segments[0].startTime).toBe(30);
      expect(segments[0].endTime).toBe(90);
    });

    it('should correctly map outro and credits and handle post_credits', () => {
      const payload = {
        outro: { start_sec: 1800, end_sec: 1860 },
        post_credits: [{ start_sec: 1900, end_sec: 1920 }],
      };

      const segments = service.normalizeSegments(payload);
      expect(segments.length).toBe(2);
      expect(segments[0].type).toBe('credits');
      expect(segments[0].startTime).toBe(1800);
      expect(segments[1].type).toBe('post_credits');
      expect(segments[1].startTime).toBe(1900);
    });
  });

  describe('buildMediaKey', () => {
    it('should generate consistent TV media keys', () => {
      const channel: any = { id: 101, name: 'Show S02E05', series_id: 50 };
      const key = service.buildMediaKey(channel, false, 2, 5, 'tvdb_71663');
      expect(key).toBe('tv_tvdb_71663_s2_e5');
    });

    it('should generate consistent Movie media keys with IMDb ID', () => {
      const channel: any = { id: 202, name: 'The Matrix (1999) [tt0133093]' };
      const key = service.buildMediaKey(channel, true);
      expect(key).toBe('mv_tt0133093');
    });
  });
});
