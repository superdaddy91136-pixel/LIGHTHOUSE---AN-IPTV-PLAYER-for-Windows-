import { Injectable } from '@angular/core';
import {
  TmdbFailedMatch,
  TmdbMediaEnrichment,
  TmdbSeasonDetail,
} from '../models/tmdb';
import { MediaSegmentsRecord } from '../models/playback-segment';

const DB_NAME = 'fred_tv_tmdb_db';
const DB_VERSION = 2;
const STORE_MEDIA = 'media_enrichment';
const STORE_FAILED = 'failed_matches';
const STORE_SEASONS = 'season_details';
const STORE_SEGMENTS = 'playback_segments';

const DEFAULT_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_FAILED_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const CURRENT_LOGO_ALGO_VERSION = 2;
const LOGO_VERSION_STORAGE_KEY = 'lh_tmdb_logo_version';

@Injectable({
  providedIn: 'root',
})
export class TmdbCacheService {
  private dbPromise: Promise<IDBDatabase> | null = null;
  /** In-memory hot cache for instant zero-latency UI rendering */
  private memoryCache: Map<number, TmdbMediaEnrichment> = new Map();
  private tmdbIdMemoryCache: Map<number, TmdbMediaEnrichment> = new Map();
  private seasonMemoryCache: Map<string, TmdbSeasonDetail> = new Map();
  private segmentMemoryCache: Map<string, MediaSegmentsRecord> = new Map();
  private failedMemoryCache: Map<string, number> = new Map(); // searchKey -> retryAfter

  constructor() {
    this.initDb();
  }

  private initDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof window === 'undefined' || !window.indexedDB) {
        return reject(new Error('IndexedDB is not available in this environment'));
      }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = req.result;

        // 1. Media enrichment store keyed by IPTV channel id (providerItemId)
        if (!db.objectStoreNames.contains(STORE_MEDIA)) {
          const mediaStore = db.createObjectStore(STORE_MEDIA, {
            keyPath: 'providerItemId',
          });
          mediaStore.createIndex('tmdbId', 'tmdbId', { unique: false });
          mediaStore.createIndex('normalizedTitle', 'normalizedTitle', { unique: false });
          mediaStore.createIndex('lastUpdated', 'lastUpdated', { unique: false });
        }

        // 2. Failed match store (negative cache to avoid futile API calls)
        if (!db.objectStoreNames.contains(STORE_FAILED)) {
          db.createObjectStore(STORE_FAILED, { keyPath: 'searchKey' });
        }

        // 3. Season detail store keyed by composite string `${tmdbId}_s${seasonNumber}`
        if (!db.objectStoreNames.contains(STORE_SEASONS)) {
          db.createObjectStore(STORE_SEASONS, { keyPath: 'seasonKey' });
        }

        // 4. Playback segments store keyed by composite string `mediaKey`
        if (!db.objectStoreNames.contains(STORE_SEGMENTS)) {
          const segStore = db.createObjectStore(STORE_SEGMENTS, { keyPath: 'mediaKey' });
          segStore.createIndex('imdbId', 'imdbId', { unique: false });
          segStore.createIndex('lastUpdated', 'lastUpdated', { unique: false });
        }
      };

      req.onsuccess = async () => {
        const db = req.result;
        try {
          await this.cleanseLegacyLogos(db);
        } catch (e) {
          console.warn('Error during logo cleansing:', e);
        }
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });

    return this.dbPromise;
  }

  /**
   * One-time migration to cleanse legacy unverified logos (e.g. Spanish logos) from IndexedDB.
   */
  private async cleanseLegacyLogos(db: IDBDatabase): Promise<void> {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (localStorage.getItem(LOGO_VERSION_STORAGE_KEY) === String(CURRENT_LOGO_ALGO_VERSION)) {
      return;
    }

    try {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_MEDIA, 'readwrite');
        const store = tx.objectStore(STORE_MEDIA);
        const cursorReq = store.openCursor();

        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            const item = cursor.value as TmdbMediaEnrichment;
            if (item && item.logoPath && item.logoVersion !== CURRENT_LOGO_ALGO_VERSION) {
              const updated: TmdbMediaEnrichment = {
                ...item,
                logoPath: undefined,
                logoLanguage: undefined,
                logoVersion: undefined,
              };
              cursor.update(updated);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };

        cursorReq.onerror = () => resolve();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });

      localStorage.setItem(LOGO_VERSION_STORAGE_KEY, String(CURRENT_LOGO_ALGO_VERSION));
    } catch (e) {
      console.warn('Failed to cleanse legacy TMDB logos in IndexedDB:', e);
    }
  }

  private sanitizeEnrichment(item?: TmdbMediaEnrichment): TmdbMediaEnrichment | undefined {
    if (!item) return undefined;
    if (item.logoPath && item.logoVersion !== CURRENT_LOGO_ALGO_VERSION) {
      item.logoPath = undefined;
      item.logoLanguage = undefined;
      item.logoVersion = undefined;
    }
    return item;
  }

  /**
   * Synchronous check against hot in-memory cache.
   * Useful in high-frequency rendering pipelines without async overhead.
   */
  getEnrichmentSync(providerItemId?: number): TmdbMediaEnrichment | undefined {
    if (!providerItemId) return undefined;
    return this.sanitizeEnrichment(this.memoryCache.get(providerItemId));
  }

  /**
   * Synchronous check by TMDB ID against hot in-memory cache.
   */
  getEnrichmentByTmdbIdSync(tmdbId?: number): TmdbMediaEnrichment | undefined {
    if (!tmdbId) return undefined;
    return this.sanitizeEnrichment(this.tmdbIdMemoryCache.get(tmdbId));
  }

  /**
   * Retrieves enrichment for a provider channel from cache.
   * Checks hot memory first, then persistent IndexedDB.
   */
  async getEnrichment(providerItemId?: number): Promise<TmdbMediaEnrichment | undefined> {
    if (!providerItemId) return undefined;

    if (this.memoryCache.has(providerItemId)) {
      return this.sanitizeEnrichment(this.memoryCache.get(providerItemId));
    }

    try {
      const db = await this.initDb();
      return new Promise<TmdbMediaEnrichment | undefined>((resolve) => {
        const tx = db.transaction(STORE_MEDIA, 'readonly');
        const store = tx.objectStore(STORE_MEDIA);
        const req = store.get(providerItemId);

        req.onsuccess = () => {
          const result = this.sanitizeEnrichment(req.result as TmdbMediaEnrichment | undefined);
          if (result) {
            this.memoryCache.set(providerItemId, result);
            if (result.tmdbId) {
              this.tmdbIdMemoryCache.set(result.tmdbId, result);
            }
          }
          resolve(result);
        };

        req.onerror = () => resolve(undefined);
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Pre-warms the hot memory cache from persistent IndexedDB for a set of candidate channel IDs.
   * Enables immediate synchronous retrieval in initial hero pool computation.
   */
  async preloadChannels(channelIds: number[]): Promise<number> {
    if (!channelIds || channelIds.length === 0) return 0;
    const missingIds = channelIds.filter((id) => id && !this.memoryCache.has(id));
    if (missingIds.length === 0) return 0;

    try {
      const db = await this.initDb();
      return new Promise<number>((resolve) => {
        const tx = db.transaction(STORE_MEDIA, 'readonly');
        const store = tx.objectStore(STORE_MEDIA);
        let loaded = 0;

        for (const id of missingIds) {
          const req = store.get(id);
          req.onsuccess = () => {
            const result = this.sanitizeEnrichment(req.result as TmdbMediaEnrichment | undefined);
            if (result) {
              this.memoryCache.set(id, result);
              if (result.tmdbId) {
                this.tmdbIdMemoryCache.set(result.tmdbId, result);
              }
              loaded++;
            }
          };
        }

        tx.oncomplete = () => resolve(loaded);
        tx.onerror = () => resolve(0);
      });
    } catch {
      return 0;
    }
  }

  async getEnrichmentsByTmdbId(tmdbId: number): Promise<TmdbMediaEnrichment[]> {
    if (!tmdbId) return [];

    try {
      const db = await this.initDb();
      return new Promise<TmdbMediaEnrichment[]>((resolve) => {
        const tx = db.transaction(STORE_MEDIA, 'readonly');
        const store = tx.objectStore(STORE_MEDIA);
        const index = store.index('tmdbId');
        const req = index.getAll(tmdbId);

        req.onsuccess = () => {
          const rawResults = (req.result as TmdbMediaEnrichment[]) || [];
          const results = rawResults.map((r) => this.sanitizeEnrichment(r)!);
          for (const res of results) {
            if (res.providerItemId) {
              this.memoryCache.set(res.providerItemId, res);
            }
          }
          if (results.length > 0) {
            this.tmdbIdMemoryCache.set(tmdbId, results[0]);
          }
          resolve(results);
        };

        req.onerror = () => resolve([]);
      });
    } catch {
      return [];
    }
  }

  /**
   * Saves enrichment to both hot memory and persistent IndexedDB.
   */
  async saveEnrichment(enrichment: TmdbMediaEnrichment): Promise<void> {
    if (!enrichment.providerItemId) return;

    this.memoryCache.set(enrichment.providerItemId, enrichment);
    if (enrichment.tmdbId) {
      this.tmdbIdMemoryCache.set(enrichment.tmdbId, enrichment);
    }

    try {
      const db = await this.initDb();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_MEDIA, 'readwrite');
        const store = tx.objectStore(STORE_MEDIA);
        const req = store.put(enrichment);

        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('Failed to persist TMDB enrichment to IndexedDB', e);
    }
  }

  /**
   * Determines if cached metadata has expired and warrants background revalidation.
   */
  isStale(enrichment: TmdbMediaEnrichment, maxAgeMs = DEFAULT_STALE_MS): boolean {
    if (!enrichment.lastUpdated) return true;
    return Date.now() - enrichment.lastUpdated > maxAgeMs;
  }

  /**
   * Checks if a title search previously failed or had low confidence, and whether the retry window has expired.
   */
  async isFailedMatch(searchKey: string): Promise<boolean> {
    const memRetry = this.failedMemoryCache.get(searchKey);
    if (memRetry !== undefined) {
      if (Date.now() < memRetry) return true;
      this.failedMemoryCache.delete(searchKey);
    }

    try {
      const db = await this.initDb();
      return new Promise<boolean>((resolve) => {
        const tx = db.transaction(STORE_FAILED, 'readonly');
        const store = tx.objectStore(STORE_FAILED);
        const req = store.get(searchKey);

        req.onsuccess = () => {
          const item = req.result as TmdbFailedMatch | undefined;
          if (!item) {
            resolve(false);
            return;
          }

          if (Date.now() < item.retryAfter) {
            this.failedMemoryCache.set(searchKey, item.retryAfter);
            resolve(true);
          } else {
            resolve(false);
          }
        };

        req.onerror = () => resolve(false);
      });
    } catch {
      return false;
    }
  }

  /**
   * Records a negative match result to prevent repeated doomed queries.
   */
  async recordFailedMatch(
    searchKey: string,
    normalizedTitle: string,
    mediaType: 'movie' | 'tv',
    year?: string,
    ttlMs = DEFAULT_FAILED_TTL_MS,
  ): Promise<void> {
    const now = Date.now();
    const retryAfter = now + ttlMs;

    this.failedMemoryCache.set(searchKey, retryAfter);

    const record: TmdbFailedMatch = {
      searchKey,
      normalizedTitle,
      mediaType,
      year,
      attemptedAt: now,
      retryAfter,
    };

    try {
      const db = await this.initDb();
      return new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_FAILED, 'readwrite');
        const store = tx.objectStore(STORE_FAILED);
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    } catch {
      // Ignore background persistence errors
    }
  }

  /**
   * Synchronous check for TV season details in hot memory cache.
   */
  getSeasonDetailSync(tmdbId: number, seasonNumber: number): TmdbSeasonDetail | undefined {
    const seasonKey = `${tmdbId}_s${seasonNumber}`;
    return this.seasonMemoryCache.get(seasonKey);
  }

  /**
   * Retrieves TV season details from persistent cache (memory first, then IndexedDB).
   */
  async getSeasonDetail(tmdbId: number, seasonNumber: number): Promise<TmdbSeasonDetail | undefined> {
    const seasonKey = `${tmdbId}_s${seasonNumber}`;
    if (this.seasonMemoryCache.has(seasonKey)) {
      return this.seasonMemoryCache.get(seasonKey);
    }

    try {
      const db = await this.initDb();
      return new Promise<TmdbSeasonDetail | undefined>((resolve) => {
        const tx = db.transaction(STORE_SEASONS, 'readonly');
        const store = tx.objectStore(STORE_SEASONS);
        const req = store.get(seasonKey);
        req.onsuccess = () => {
          const res = req.result as TmdbSeasonDetail | undefined;
          if (res) {
            this.seasonMemoryCache.set(seasonKey, res);
          }
          resolve(res);
        };
        req.onerror = () => resolve(undefined);
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Saves TV season details to persistent cache and hot memory cache.
   */
  async saveSeasonDetail(detail: TmdbSeasonDetail): Promise<void> {
    const seasonKey = `${detail.tmdbId}_s${detail.seasonNumber}`;
    this.seasonMemoryCache.set(seasonKey, detail);
    const payload = { ...detail, seasonKey };

    try {
      const db = await this.initDb();
      return new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_SEASONS, 'readwrite');
        const store = tx.objectStore(STORE_SEASONS);
        const req = store.put(payload);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    } catch {
      // Ignore background persistence errors
    }
  }

  /**
   * Retrieves cached playback segments synchronously from in-memory cache.
   */
  public getPlaybackSegmentsSync(mediaKey: string): MediaSegmentsRecord | undefined {
    return this.segmentMemoryCache.get(mediaKey);
  }

  /**
   * Retrieves cached playback segments from memory or IndexedDB.
   */
  public async getPlaybackSegments(mediaKey: string): Promise<MediaSegmentsRecord | undefined> {
    const mem = this.segmentMemoryCache.get(mediaKey);
    if (mem) return mem;

    try {
      const db = await this.initDb();
      return new Promise<MediaSegmentsRecord | undefined>((resolve) => {
        const tx = db.transaction(STORE_SEGMENTS, 'readonly');
        const store = tx.objectStore(STORE_SEGMENTS);
        const req = store.get(mediaKey);
        req.onsuccess = () => {
          const res = req.result as MediaSegmentsRecord | undefined;
          if (res) {
            this.segmentMemoryCache.set(mediaKey, res);
          }
          resolve(res);
        };
        req.onerror = () => resolve(undefined);
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Stores playback segments in both in-memory cache and IndexedDB.
   */
  public async setPlaybackSegments(record: MediaSegmentsRecord): Promise<void> {
    this.segmentMemoryCache.set(record.mediaKey, record);
    if (record.channelId) {
      this.segmentMemoryCache.set(`mv_ch_${record.channelId}`, record);
      this.segmentMemoryCache.set(`tv_ch_${record.channelId}`, record);
    }
    try {
      const db = await this.initDb();
      return new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_SEGMENTS, 'readwrite');
        const store = tx.objectStore(STORE_SEGMENTS);
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    } catch {
      // Ignore background persistence errors
    }
  }

  /**
   * Clears the entire local TMDB cache.
   */
  async clearCache(): Promise<void> {
    this.memoryCache.clear();
    this.tmdbIdMemoryCache.clear();
    this.seasonMemoryCache.clear();
    this.failedMemoryCache.clear();
    this.segmentMemoryCache.clear();

    try {
      const db = await this.initDb();
      return new Promise<void>((resolve, reject) => {
        const storeNames = [STORE_MEDIA, STORE_FAILED, STORE_SEASONS];
        if (db.objectStoreNames.contains(STORE_SEGMENTS)) {
          storeNames.push(STORE_SEGMENTS);
        }
        const tx = db.transaction(storeNames, 'readwrite');
        tx.objectStore(STORE_MEDIA).clear();
        tx.objectStore(STORE_FAILED).clear();
        tx.objectStore(STORE_SEASONS).clear();
        if (db.objectStoreNames.contains(STORE_SEGMENTS)) {
          tx.objectStore(STORE_SEGMENTS).clear();
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('Failed to clear TMDB cache', e);
    }
  }

  /**
   * Returns statistics on cached titles.
   */
  async getCacheStats(): Promise<{ enrichedCount: number; failedCount: number }> {
    try {
      const db = await this.initDb();
      return new Promise<{ enrichedCount: number; failedCount: number }>((resolve) => {
        const tx = db.transaction([STORE_MEDIA, STORE_FAILED], 'readonly');
        const mediaReq = tx.objectStore(STORE_MEDIA).count();
        const failedReq = tx.objectStore(STORE_FAILED).count();

        tx.oncomplete = () => {
          resolve({
            enrichedCount: mediaReq.result || 0,
            failedCount: failedReq.result || 0,
          });
        };

        tx.onerror = () => resolve({ enrichedCount: 0, failedCount: 0 });
      });
    } catch {
      return { enrichedCount: 0, failedCount: 0 };
    }
  }
}
