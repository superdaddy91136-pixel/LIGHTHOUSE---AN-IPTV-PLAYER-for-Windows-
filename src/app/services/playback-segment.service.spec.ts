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

  describe('normalizeSkipDbSegments', () => {
    it('should correctly parse SkipDB format and map outro to credits', () => {
      const skipDbPayload = {
        intro: { start_ms: 229500, end_ms: 246500, confidence: 0.9, match: 'exact' },
        recap: null,
        outro: { start_ms: 3434000, end_ms: 3500000, confidence: 0.85, match: 'exact' },
        preview: { start_ms: 3501000, end_ms: 3530000, confidence: 0.75 },
      };

      const segments = service.normalizeSkipDbSegments(skipDbPayload);

      expect(segments.length).toBe(3);

      expect(segments[0].type).toBe('intro');
      expect(segments[0].startTime).toBe(229.5);
      expect(segments[0].endTime).toBe(246.5);
      expect(segments[0].confidence).toBe(0.9);
      expect(segments[0].source).toBe('skipdb');

      expect(segments[1].type).toBe('credits');
      expect(segments[1].startTime).toBe(3434);
      expect(segments[1].endTime).toBe(3500);
      expect(segments[1].confidence).toBe(0.85);
      expect(segments[1].source).toBe('skipdb');

      expect(segments[2].type).toBe('preview');
      expect(segments[2].startTime).toBe(3501);
      expect(segments[2].endTime).toBe(3530);
      expect(segments[2].source).toBe('skipdb');
    });

    it('should handle movie outro from SkipDB', () => {
      const moviePayload = {
        intro: null,
        recap: null,
        outro: { start_ms: 8455400, end_ms: 8888300, confidence: 0.77 },
        preview: null,
      };

      const segments = service.normalizeSkipDbSegments(moviePayload);

      expect(segments.length).toBe(1);
      expect(segments[0].type).toBe('credits');
      expect(segments[0].startTime).toBe(8455.4);
      expect(segments[0].endTime).toBe(8888.3);
      expect(segments[0].source).toBe('skipdb');
    });

    it('should return empty array for all-null SkipDB segments', () => {
      const emptyPayload = {
        intro: null,
        recap: null,
        outro: null,
        preview: null,
      };

      const segments = service.normalizeSkipDbSegments(emptyPayload);
      expect(segments.length).toBe(0);
    });
  });

  describe('mergeSegments', () => {
    it('should preserve primary segments when secondary is empty', () => {
      const primary: any[] = [{ type: 'intro', startTime: 10, endTime: 30, confidence: 0.8, source: 'theintrodb' }];
      const secondary: any[] = [];

      const result = service.mergeSegments(primary, secondary);
      expect(result.length).toBe(1);
      expect(result[0].type).toBe('intro');
      expect(result[0].startTime).toBe(10);
      expect(result[0].source).toBe('theintrodb');
    });

    it('should use secondary segments when primary is empty', () => {
      const primary: any[] = [];
      const secondary: any[] = [
        { type: 'intro', startTime: 15, endTime: 35, confidence: 0.85, source: 'skipdb' },
        { type: 'credits', startTime: 1200, endTime: 1250, confidence: 0.85, source: 'skipdb' },
      ];

      const result = service.mergeSegments(primary, secondary);
      expect(result.length).toBe(2);
      expect(result[0].type).toBe('intro');
      expect(result[1].type).toBe('credits');
      expect(result[0].source).toBe('skipdb');
    });

    it('should merge missing segment types from secondary without overwriting primary', () => {
      // Primary has intro, but no credits
      const primary: any[] = [{ type: 'intro', startTime: 100, endTime: 130, confidence: 0.9, source: 'theintrodb' }];
      // Secondary has intro and credits
      const secondary: any[] = [
        { type: 'intro', startTime: 102, endTime: 132, confidence: 0.8, source: 'skipdb' },
        { type: 'credits', startTime: 2500, endTime: 2560, confidence: 0.85, source: 'skipdb' },
      ];

      const result = service.mergeSegments(primary, secondary);

      expect(result.length).toBe(2);
      // Intro: preserved from primary (0.9 vs 0.8)
      expect(result[0].type).toBe('intro');
      expect(result[0].startTime).toBe(100);
      expect(result[0].source).toBe('theintrodb');

      // Credits: filled from secondary
      expect(result[1].type).toBe('credits');
      expect(result[1].startTime).toBe(2500);
      expect(result[1].source).toBe('skipdb');
    });

    it('should prefer secondary only when secondary confidence is significantly higher', () => {
      // Primary has weak match (0.4), secondary has strong verified match (0.95)
      const primary: any[] = [{ type: 'intro', startTime: 10, endTime: 40, confidence: 0.4, source: 'theintrodb' }];
      const secondary: any[] = [{ type: 'intro', startTime: 12, endTime: 42, confidence: 0.95, source: 'skipdb' }];

      const result = service.mergeSegments(primary, secondary);
      expect(result.length).toBe(1);
      expect(result[0].startTime).toBe(12);
      expect(result[0].source).toBe('skipdb');
    });

    it('should not overwrite primary when confidences are comparable', () => {
      const primary: any[] = [{ type: 'intro', startTime: 50, endTime: 80, confidence: 0.85, source: 'theintrodb' }];
      const secondary: any[] = [{ type: 'intro', startTime: 52, endTime: 82, confidence: 0.88, source: 'skipdb' }];

      const result = service.mergeSegments(primary, secondary);
      expect(result.length).toBe(1);
      expect(result[0].startTime).toBe(50);
      expect(result[0].source).toBe('theintrodb');
    });

    it('should correctly merge all four segment types (recap, intro, credits, preview)', () => {
      // Primary provides intro and credits
      const primary: any[] = [
        { type: 'intro', startTime: 30, endTime: 60, confidence: 0.9, source: 'theintrodb' },
        { type: 'credits', startTime: 2500, endTime: 2550, confidence: 0.9, source: 'theintrodb' },
      ];
      // Secondary provides recap and preview
      const secondary: any[] = [
        { type: 'recap', startTime: 0, endTime: 28, confidence: 0.85, source: 'skipdb' },
        { type: 'preview', startTime: 2555, endTime: 2580, confidence: 0.8, source: 'skipdb' },
      ];

      const result = service.mergeSegments(primary, secondary);

      expect(result.length).toBe(4);
      // Correct chronological order: recap -> intro -> credits -> preview
      expect(result[0].type).toBe('recap');
      expect(result[0].startTime).toBe(0);
      expect(result[0].source).toBe('skipdb');

      expect(result[1].type).toBe('intro');
      expect(result[1].startTime).toBe(30);
      expect(result[1].source).toBe('theintrodb');

      expect(result[2].type).toBe('credits');
      expect(result[2].startTime).toBe(2500);
      expect(result[2].source).toBe('theintrodb');

      expect(result[3].type).toBe('preview');
      expect(result[3].startTime).toBe(2555);
      expect(result[3].source).toBe('skipdb');
    });
  });

  describe('SkipDB Configuration', () => {
    it('should default to enabled and allow toggling', () => {
      expect(service.isSkipDbEnabled()).toBe(true);

      service.setSkipDbEnabled(false);
      expect(service.isSkipDbEnabled()).toBe(false);

      service.setSkipDbEnabled(true);
      expect(service.isSkipDbEnabled()).toBe(true);
    });
  });
});
