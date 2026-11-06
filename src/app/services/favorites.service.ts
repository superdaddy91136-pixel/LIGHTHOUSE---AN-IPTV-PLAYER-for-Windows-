import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { ToastrService } from 'ngx-toastr';
import { invoke } from '@tauri-apps/api/core';
import { Channel } from '../models/channel';
import { Filters } from '../models/filters';
import { ViewMode } from '../models/viewMode';
import { MediaType } from '../models/mediaType';
import { SortType } from '../models/sortType';
import { MemoryService } from '../memory.service';

export interface FavoriteChangeEvent {
  channelId: number;
  isFavorite: boolean;
  channel?: Channel;
}

@Injectable({
  providedIn: 'root',
})
export class FavoritesService {
  private favoriteChangedSubject = new Subject<FavoriteChangeEvent>();
  public favoriteChanged$: Observable<FavoriteChangeEvent> = this.favoriteChangedSubject.asObservable();

  // Fast in-memory lookup set of known favorited channel IDs
  private favoriteIds = new Set<number>();

  // Cached list of favorite channels for the dedicated Favorites tab and cross-screen sync
  private cachedFavorites: Channel[] | null = null;
  private isFetchingFavorites = false;

  // Concurrency and rapid-click safety:
  // Tracks in-flight SQLite persistence operations per channel ID
  private inFlightOps = new Map<number, Promise<void>>();
  private desiredState = new Map<number, boolean>();
  private lastPersistedState = new Map<number, boolean>();

  constructor(
    private toastr: ToastrService,
    private memory: MemoryService,
  ) {}

  /**
   * Fast synchronous check if a channel is marked as favorite in memory.
   */
  public isFavorite(channelId: number): boolean {
    return this.favoriteIds.has(channelId);
  }

  /**
   * Seeds initial favorite channel IDs and cached list from startup / discovery queries.
   */
  public setInitialFavorites(favorites: Channel[]): void {
    if (!favorites) return;
    for (const f of favorites) {
      if (f && f.id != null) {
        this.favoriteIds.add(f.id);
      }
    }
    if (!this.cachedFavorites) {
      this.cachedFavorites = [...favorites];
    }
  }

  /**
   * Optimistically toggles favorite status for a channel.
   * UI updates synchronously (0ms delay), broadcasting to all listening components.
   * Persistence to SQLite is executed safely in the background.
   */
  public toggleFavorite(channel: Channel): boolean {
    if (!channel || channel.id == null) return false;

    const channelId = channel.id;
    const currentFav = !!channel.favorite;
    const nextFav = !currentFav;

    // 1. Immediate optimistic in-memory update
    channel.favorite = nextFav;
    if (nextFav) {
      this.favoriteIds.add(channelId);
      // Prepend to cached list if cached list is loaded
      if (this.cachedFavorites && !this.cachedFavorites.some((c) => c.id === channelId)) {
        this.cachedFavorites.unshift(channel);
      }
    } else {
      this.favoriteIds.delete(channelId);
      // Remove from cached list if cached list is loaded
      if (this.cachedFavorites) {
        this.cachedFavorites = this.cachedFavorites.filter((c) => c.id !== channelId);
      }
    }

    // Clear stale catalog pages in MemoryService
    this.memory.clearCatalogPageCache();

    // 2. Immediately notify all components, tabs, cards, and detail views
    this.favoriteChangedSubject.next({
      channelId,
      isFavorite: nextFav,
      channel,
    });

    // 3. Asynchronously persist state to SQLite
    this.schedulePersistence(channel, nextFav, currentFav);

    return nextFav;
  }

  /**
   * Explicitly sets the favorite state for a channel with optimistic update and async persistence.
   */
  public setFavorite(channel: Channel, nextFav: boolean): void {
    if (!channel || channel.id == null) return;
    if (!!channel.favorite === nextFav) return;
    this.toggleFavorite(channel);
  }

  /**
   * Serializes background SQLite persistence per channel ID.
   * Handles rapid toggling safely: debounces/merges redundant calls so older async results
   * never overwrite newer user clicks, and SQLite transactions are never bombarded.
   */
  private schedulePersistence(channel: Channel, targetFav: boolean, originalFav: boolean): void {
    const channelId = channel.id!;
    this.desiredState.set(channelId, targetFav);
    if (!this.lastPersistedState.has(channelId)) {
      this.lastPersistedState.set(channelId, originalFav);
    }

    // If an operation is already in-flight for this channel, the running loop will pick up desiredState
    if (this.inFlightOps.has(channelId)) {
      return;
    }

    const runPersistenceLoop = async (): Promise<void> => {
      while (true) {
        const desired = this.desiredState.get(channelId);
        const persisted = this.lastPersistedState.get(channelId);

        if (desired === undefined || desired === persisted) {
          // Desired state already matches persisted state
          break;
        }

        const call = desired ? 'favorite_channel' : 'unfavorite_channel';
        try {
          await invoke(call, { channelId });
          this.lastPersistedState.set(channelId, desired);
        } catch (err) {
          console.error(`Failed to persist favorite state for channel ${channelId}:`, err);

          // Revert optimistic state back to last persisted state
          const rollbackState = this.lastPersistedState.get(channelId) ?? originalFav;
          channel.favorite = rollbackState;
          if (rollbackState) {
            this.favoriteIds.add(channelId);
            if (this.cachedFavorites && !this.cachedFavorites.some((c) => c.id === channelId)) {
              this.cachedFavorites.unshift(channel);
            }
          } else {
            this.favoriteIds.delete(channelId);
            if (this.cachedFavorites) {
              this.cachedFavorites = this.cachedFavorites.filter((c) => c.id !== channelId);
            }
          }
          this.desiredState.set(channelId, rollbackState);

          // Broadcast rollback to all components
          this.favoriteChangedSubject.next({
            channelId,
            isFavorite: rollbackState,
            channel,
          });

          this.toastr.error(`Failed to update favorite status for "${channel.name || 'channel'}"`);
          break;
        }
      }
    };

    const opPromise = runPersistenceLoop().finally(() => {
      this.inFlightOps.delete(channelId);
    });
    this.inFlightOps.set(channelId, opPromise);
  }

  /**
   * Retrieves all favorite channels with caching.
   * Returns cached list immediately (0ms) if available and not forced to refresh.
   */
  public async loadFavorites(forceRefresh: boolean = false): Promise<Channel[]> {
    if (this.cachedFavorites && !forceRefresh) {
      return [...this.cachedFavorites];
    }

    if (this.isFetchingFavorites && this.cachedFavorites) {
      return [...this.cachedFavorites];
    }

    this.isFetchingFavorites = true;
    try {
      let enabledSourceIds: number[] = [];
      if (this.memory.Sources.size > 0) {
        enabledSourceIds = Array.from(this.memory.Sources.values())
          .filter((s) => s.enabled && s.id != null)
          .map((s) => s.id!);
      } else {
        const sources = (await invoke('get_sources')) as any[];
        enabledSourceIds = (sources || [])
          .filter((s) => s.enabled && s.id != null)
          .map((s) => s.id);
      }

      if (enabledSourceIds.length === 0) {
        this.cachedFavorites = [];
        return [];
      }

      const filters: Filters = {
        source_ids: enabledSourceIds,
        view_type: ViewMode.Favorites,
        media_types: [MediaType.livestream, MediaType.movie, MediaType.serie],
        page: 1,
        use_keywords: false,
        sort: SortType.alphabeticalAscending,
      };

      let allFavs: Channel[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 25) {
        filters.page = page;
        const res = (await invoke('search', { filters })) as Channel[];
        if (res && res.length > 0) {
          allFavs = allFavs.concat(res);
          hasMore = res.length === 36;
          page++;
        } else {
          hasMore = false;
        }
      }

      this.cachedFavorites = allFavs;
      this.favoriteIds.clear();
      for (const f of allFavs) {
        if (f && f.id != null) {
          this.favoriteIds.add(f.id);
        }
      }
      return [...this.cachedFavorites];
    } catch (e) {
      console.error('Failed to load favorites from database:', e);
      return this.cachedFavorites || [];
    } finally {
      this.isFetchingFavorites = false;
    }
  }

  /**
   * Synchronously returns cached favorite channels if loaded.
   */
  public getCachedFavorites(): Channel[] | null {
    return this.cachedFavorites ? [...this.cachedFavorites] : null;
  }
}
