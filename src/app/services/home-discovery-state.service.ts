import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Subject } from 'rxjs';
import { Channel } from '../models/channel';
import { DiscoveryRow, HeroItem } from '../models/discovery';

export type DiscoveryPipelineStatus = 'idle' | 'loading' | 'success' | 'refreshing' | 'error';

export interface DiscoverySourceInvalidation {
  type: 'refreshed' | 'deleted';
  sourceId?: number;
}

export interface HomeDiscoverySnapshot {
  recommendationSource: 'tmdb';
  tmdbRows: DiscoveryRow[];
  localRows?: DiscoveryRow[];
  masterHeroItems: HeroItem[];
  allRecommended: Channel[];
  allLoadedMovies: Channel[];
  allLoadedSeries: Channel[];
  timestamp: number;
  status: DiscoveryPipelineStatus;
}

export interface ContinueWatchingEntry {
  channel: Channel;
  identity_key: string;
  position_sec: number;
  duration_sec: number;
  progress_percent: number;
  completed: boolean;
  last_watched: number;
  updated_at: number;
  tmdb_id?: number | null;
  is_episode: boolean;
  show_title?: string | null;
  season_number?: number | null;
  episode_number?: number | null;
  next_episode?: Channel | null;
}

@Injectable({
  providedIn: 'root',
})
export class HomeDiscoveryStateService {
  /** Emits whenever new discovery rows or hero items are successfully updated/refreshed */
  public discoveryUpdated$ = new Subject<HomeDiscoverySnapshot>();

  /** Emits whenever underlying source catalogs are refreshed or deleted */
  public sourceDataInvalidated$ = new Subject<DiscoverySourceInvalidation>();

  private unlistenSourceRefreshComplete?: UnlistenFn;
  private unlistenSourceDeleted?: UnlistenFn;

  /** Five-minute freshness TTL for the Home discovery snapshot. */
  public readonly CACHE_TTL_MS = 5 * 60 * 1000;

  /** Stored in-memory snapshot surviving navigation across tabs and routes */
  private snapshot: HomeDiscoverySnapshot | null = null;
  private cachedContinueWatchingEntries: ContinueWatchingEntry[] | null = null;

  /** Active banner identity survives Home's tab-driven component recreation. */
  private activeHeroChannelId?: number;

  /** Fast in-memory cache of resolved catalog matches: `${isTv ? 'tv' : 'mv'}_${tmdbId}` -> Channel */
  private resolvedCatalogMatches: Map<string, Channel> = new Map();

  /** Concurrency & deduplication tracking */
  private inFlightPipelinePromise: Promise<void> | null = null;
  private currentRunId: number = 0;
  private lastSourceKey: string = '';

  constructor(private ngZone: NgZone) {
    this.hydrateFromStorage();
    this.setupSourceEventListeners();
  }

  ngOnDestroy(): void {
    this.unlistenSourceRefreshComplete?.();
    this.unlistenSourceDeleted?.();
  }

  private setupSourceEventListeners(): void {
    try {
      listen<number>('source-refresh-complete', (event) => {
        this.ngZone.run(() => {
          this.clearCache();
          this.sourceDataInvalidated$.next({
            type: 'refreshed',
            sourceId: event.payload ?? undefined,
          });
        });
      }).then((unlisten) => {
        this.unlistenSourceRefreshComplete = unlisten;
      }).catch(() => {});

      listen<number>('source-deleted', (event) => {
        this.ngZone.run(() => {
          this.clearCache();
          this.sourceDataInvalidated$.next({
            type: 'deleted',
            sourceId: event.payload ?? undefined,
          });
        });
      }).then((unlisten) => {
        this.unlistenSourceDeleted = unlisten;
      }).catch(() => {});
    } catch {
      // Ignore outside Tauri runtime (e.g. unit tests)
    }
  }

  private hydrateFromStorage(): void {
    try {
      const stored = localStorage.getItem('lighthouse_home_discovery_snapshot');
      if (stored) {
        const parsed = JSON.parse(stored) as HomeDiscoverySnapshot;
        if (
          parsed &&
          parsed.recommendationSource === 'tmdb' &&
          this.hasCachedContent(parsed)
        ) {
          this.snapshot = parsed;
        }
      }
    } catch {
      // ignore storage errors
    }
  }

  /**
   * Checks whether valid TMDB-generated discovery data exists in the in-memory cache.
   */
  public hasValidTmdbData(): boolean {
    if (!this.snapshot || this.snapshot.recommendationSource !== 'tmdb') return false;
    const hasRows =
      Array.isArray(this.snapshot.tmdbRows) &&
      this.snapshot.tmdbRows.length > 0 &&
      this.snapshot.tmdbRows.some((r) =>
        r.id === 'row-recommended' ||
        r.id === 'row-popular-movies' ||
        r.id === 'row-popular-series' ||
        r.id === 'row-trending-movies' ||
        r.id === 'row-trending-series' ||
        r.id === 'row-anime-animation' ||
        r.id === 'row-korean-series'
      );
    return hasRows;
  }

  public hasCachedContent(snapshot: HomeDiscoverySnapshot | null = this.snapshot): boolean {
    return !!snapshot && (
      (Array.isArray(snapshot.masterHeroItems) && snapshot.masterHeroItems.length > 0) ||
      (Array.isArray(snapshot.tmdbRows) && snapshot.tmdbRows.length > 0) ||
      (Array.isArray(snapshot.localRows) && snapshot.localRows.length > 0)
    );
  }

  /**
   * Checks if the cached TMDB data is within the freshness threshold.
   */
  public isFresh(maxAgeMs: number = this.CACHE_TTL_MS): boolean {
    const snapshot = this.snapshot;
    if (!snapshot || !this.hasCachedContent(snapshot)) return false;
    return Date.now() - snapshot.timestamp < maxAgeMs;
  }

  /**
   * Retrieves the current snapshot if available.
   */
  public getSnapshot(): HomeDiscoverySnapshot | null {
    return this.snapshot;
  }

  public setActiveHero(channelId?: number): void {
    this.activeHeroChannelId = channelId;
  }

  public getActiveHero(): number | undefined {
    return this.activeHeroChannelId;
  }

  public getActiveHeroIndex(heroItems: HeroItem[]): number {
    if (!this.activeHeroChannelId) return 0;
    const index = heroItems.findIndex(
      (hero) => hero.channel?.id === this.activeHeroChannelId
    );
    return index >= 0 ? index : 0;
  }

  /**
   * Retrieves cached TMDB rows (defensively copied).
   */
  public getCachedTmdbRows(): DiscoveryRow[] {
    if (!this.snapshot?.tmdbRows) return [];
    return this.snapshot.tmdbRows.map((r) => ({ ...r, items: [...r.items] }));
  }

  /**
   * Retrieves cached hero candidate items.
   */
  public getCachedHeroPool(): HeroItem[] {
    if (!this.snapshot?.masterHeroItems) return [];
    return [...this.snapshot.masterHeroItems];
  }

  public getAllRecommended(): Channel[] {
    return this.snapshot?.allRecommended ? [...this.snapshot.allRecommended] : [];
  }

  public getAllLoadedMovies(): Channel[] {
    return this.snapshot?.allLoadedMovies ? [...this.snapshot.allLoadedMovies] : [];
  }

  public getAllLoadedSeries(): Channel[] {
    return this.snapshot?.allLoadedSeries ? [...this.snapshot.allLoadedSeries] : [];
  }

  /**
   * Upserts or updates a single TMDB discovery row in the cached snapshot.
   */
  public upsertTmdbRow(row: DiscoveryRow): void {
    if (!this.snapshot) {
      this.snapshot = {
        recommendationSource: 'tmdb',
        tmdbRows: [row],
        masterHeroItems: [],
        allRecommended: [],
        allLoadedMovies: [],
        allLoadedSeries: [],
        timestamp: Date.now(),
        status: 'refreshing',
      };
      return;
    }

    const idx = this.snapshot.tmdbRows.findIndex((r) => r.id === row.id);
    if (idx !== -1) {
      this.snapshot.tmdbRows[idx] = row;
    } else {
      this.snapshot.tmdbRows.push(row);
    }
  }

  /**
   * Sets curated genre rows in the cached snapshot.
   */
  public setGenreRows(genreRows: DiscoveryRow[]): void {
    if (!this.snapshot) return;
    this.snapshot.tmdbRows = this.snapshot.tmdbRows.filter(
      (r) => !r.id.startsWith('row-genre-')
    );
    this.snapshot.tmdbRows.push(...genreRows);
  }

  /**
   * Updates hero candidate pool.
   */
  public setHeroPool(heroItems: HeroItem[]): void {
    if (!this.snapshot) {
      this.snapshot = {
        recommendationSource: 'tmdb',
        tmdbRows: [],
        masterHeroItems: [...heroItems],
        allRecommended: [],
        allLoadedMovies: [],
        allLoadedSeries: [],
        timestamp: Date.now(),
        status: 'refreshing',
      };
      this.debouncePersistSnapshot(800);
      return;
    }
    this.snapshot.masterHeroItems = [...heroItems];
    this.debouncePersistSnapshot(800);
  }

  public setLoadedPools(
    movies: Channel[],
    series: Channel[],
    recommended: Channel[]
  ): void {
    if (this.snapshot) {
      this.snapshot.allLoadedMovies = movies;
      this.snapshot.allLoadedSeries = series;
      this.snapshot.allRecommended = recommended;
    }
  }

  public setLocalRows(rows: DiscoveryRow[]): void {
    if (!this.snapshot) {
      this.snapshot = {
        recommendationSource: 'tmdb',
        tmdbRows: [],
        localRows: [],
        masterHeroItems: [],
        allRecommended: [],
        allLoadedMovies: [],
        allLoadedSeries: [],
        timestamp: Date.now(),
        status: 'refreshing',
      };
    }

    this.snapshot.localRows = rows.map((row) => ({ ...row, items: [...row.items] }));
    this.persistSnapshot();
  }

  /**
   * Commits a successful pipeline execution, updates the timestamp, and notifies subscribers.
   */
  public markPipelineSuccess(
    tmdbRows: DiscoveryRow[],
    heroPool: HeroItem[],
    recommended: Channel[],
    movies: Channel[],
    series: Channel[]
  ): void {
    this.snapshot = {
      recommendationSource: 'tmdb',
      tmdbRows: tmdbRows.map((r) => ({ ...r, items: [...r.items] })),
      localRows: this.snapshot?.localRows?.map((r) => ({ ...r, items: [...r.items] })) || [],
      masterHeroItems: [...heroPool],
      allRecommended: [...recommended],
      allLoadedMovies: [...movies],
      allLoadedSeries: [...series],
      timestamp: Date.now(),
      status: 'success',
    };
    this.persistSnapshot();
    this.discoveryUpdated$.next(this.snapshot);
  }

  private persistDebounceTimer?: any;

  public persistSnapshot(): void {
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = undefined;
    }
    if (!this.snapshot) return;
    try {
      localStorage.setItem('lighthouse_home_discovery_snapshot', JSON.stringify(this.snapshot));
    } catch {
      // ignore storage errors
    }
  }

  /**
   * Persists snapshot with debouncing to prevent excessive localStorage writes.
   */
  public debouncePersistSnapshot(delayMs: number = 800): void {
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
    }
    this.persistDebounceTimer = setTimeout(() => {
      this.persistSnapshot();
      this.persistDebounceTimer = undefined;
    }, delayMs);
  }

  /**
   * Updates hero item metadata (such as resolved logoUrl/imageUrl) in the cached snapshot
   * and debounces persistence to localStorage without restarting the pipeline.
   */
  public updateHeroItemMetadata(channelId: number, updates: Partial<HeroItem>): boolean {
    if (!this.snapshot?.masterHeroItems || !channelId) return false;
    let changed = false;
    for (const item of this.snapshot.masterHeroItems) {
      if (item.channel?.id === channelId) {
        if (updates.logoUrl !== undefined && item.logoUrl !== updates.logoUrl) {
          item.logoUrl = updates.logoUrl;
          changed = true;
        }
        if (updates.imageUrl !== undefined && item.imageUrl !== updates.imageUrl) {
          item.imageUrl = updates.imageUrl;
          changed = true;
        }
        if (updates.description !== undefined && item.description !== updates.description) {
          item.description = updates.description;
          changed = true;
        }
        if ('contentRating' in updates && item.contentRating !== updates.contentRating) {
          item.contentRating = updates.contentRating;
          changed = true;
        }
      }
    }
    if (changed) {
      this.debouncePersistSnapshot(800);
    }
    return changed;
  }

  /**
   * Pipeline in-flight status and deduplication.
   */
  public isPipelineRunning(): boolean {
    return this.inFlightPipelinePromise !== null;
  }

  public getInFlightPipeline(): Promise<void> | null {
    return this.inFlightPipelinePromise;
  }

  public setInFlightPipeline(promise: Promise<void> | null): void {
    this.inFlightPipelinePromise = promise;
  }

  public startNewRun(): number {
    return ++this.currentRunId;
  }

  public getCurrentRunId(): number {
    return this.currentRunId;
  }

  /**
   * Validates if active enabled source IDs match the cached source set.
   * If source configuration changed, automatically resets the cache.
   */
  public checkSourceConsistency(sourceIds: number[]): boolean {
    const key = [...sourceIds].sort((a, b) => a - b).join(',');
    if (this.lastSourceKey && this.lastSourceKey !== key) {
      this.clearCache();
    }
    this.lastSourceKey = key;
    return true;
  }

  /**
   * Catalog match fast memory lookup.
   */
  public getCachedCatalogMatch(tmdbId: number, isTv: boolean): Channel | undefined {
    return this.resolvedCatalogMatches.get(`${isTv ? 'tv' : 'mv'}_${tmdbId}`);
  }

  public setCachedCatalogMatch(tmdbId: number, isTv: boolean, channel: Channel): void {
    if (channel && channel.id) {
      this.resolvedCatalogMatches.set(`${isTv ? 'tv' : 'mv'}_${tmdbId}`, channel);
    }
  }

  public setContinueWatchingEntries(entries: ContinueWatchingEntry[]): void {
    this.cachedContinueWatchingEntries = entries ? [...entries] : null;
  }

  public getContinueWatchingEntries(): ContinueWatchingEntry[] | null {
    return this.cachedContinueWatchingEntries
      ? [...this.cachedContinueWatchingEntries]
      : null;
  }

  /**
   * Clears state on full catalog reload / source changes.
   */
  public clearCache(): void {
    if (this.persistDebounceTimer) {
      clearTimeout(this.persistDebounceTimer);
      this.persistDebounceTimer = undefined;
    }
    this.snapshot = null;
    this.cachedContinueWatchingEntries = null;
    this.activeHeroChannelId = undefined;
    this.resolvedCatalogMatches.clear();
    this.inFlightPipelinePromise = null;
    this.currentRunId++;
    try {
      localStorage.removeItem('lighthouse_home_discovery_snapshot');
    } catch {
      // ignore storage errors
    }
  }
}
