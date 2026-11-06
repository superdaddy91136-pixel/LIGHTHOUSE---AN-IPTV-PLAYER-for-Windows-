import { FavoritesService, FavoriteChangeEvent } from './favorites.service';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';

describe('FavoritesService', () => {
  let service: FavoritesService;
  let mockToastr: any;
  let mockMemory: any;

  beforeEach(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: jasmine.createSpy('invoke').and.returnValue(Promise.resolve()),
    };
    mockToastr = {
      error: jasmine.createSpy('error'),
      success: jasmine.createSpy('success'),
    };
    mockMemory = {
      clearCatalogPageCache: jasmine.createSpy('clearCatalogPageCache'),
      Sources: new Map(),
    };
    service = new FavoritesService(mockToastr, mockMemory);
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('toggleFavorite (Optimistic UI & Event dispatch)', () => {
    it('should immediately turn favorite to true when currently false', () => {
      const channel: Channel = {
        id: 101,
        name: 'Movie Alpha',
        favorite: false,
        media_type: MediaType.movie,
      };

      let emittedEvent: FavoriteChangeEvent | undefined;
      service.favoriteChanged$.subscribe((event) => {
        emittedEvent = event;
      });

      const result = service.toggleFavorite(channel);

      // 1. Returns new state immediately
      expect(result).toBeTrue();
      // 2. Modifies channel.favorite immediately
      expect(channel.favorite).toBeTrue();
      // 3. isFavorite lookup is immediately true
      expect(service.isFavorite(101)).toBeTrue();
      // 4. Cleared catalog cache
      expect(mockMemory.clearCatalogPageCache).toHaveBeenCalled();
      // 5. Emitted synchronous event to listeners
      expect(emittedEvent).toBeDefined();
      expect(emittedEvent?.channelId).toBe(101);
      expect(emittedEvent?.isFavorite).toBeTrue();
      expect(emittedEvent?.channel).toBe(channel);
    });

    it('should immediately turn favorite to false when currently true', () => {
      const channel: Channel = {
        id: 102,
        name: 'Show Bravo',
        favorite: true,
        media_type: MediaType.serie,
      };

      let emittedEvent: FavoriteChangeEvent | undefined;
      service.favoriteChanged$.subscribe((event) => {
        emittedEvent = event;
      });

      const result = service.toggleFavorite(channel);

      expect(result).toBeFalse();
      expect(channel.favorite).toBeFalse();
      expect(service.isFavorite(102)).toBeFalse();
      expect(emittedEvent?.channelId).toBe(102);
      expect(emittedEvent?.isFavorite).toBeFalse();
    });

    it('should return false safely if channel is undefined or has no id', () => {
      expect(service.toggleFavorite(undefined as any)).toBeFalse();
      expect(service.toggleFavorite({ name: 'Invalid' } as any)).toBeFalse();
    });
  });

  describe('setInitialFavorites', () => {
    it('should populate favoriteIds and cachedFavorites correctly', () => {
      const favs: Channel[] = [
        { id: 201, name: 'Fav 1', favorite: true, media_type: MediaType.movie },
        { id: 202, name: 'Fav 2', favorite: true, media_type: MediaType.serie },
      ];

      service.setInitialFavorites(favs);

      expect(service.isFavorite(201)).toBeTrue();
      expect(service.isFavorite(202)).toBeTrue();
      expect(service.isFavorite(999)).toBeFalse();

      const cached = service.getCachedFavorites();
      expect(cached?.length).toBe(2);
      expect(cached?.[0].id).toBe(201);
    });
  });

  describe('Rapid toggling and caching deduplication', () => {
    it('should maintain consistent in-memory state during rapid toggles', () => {
      service.setInitialFavorites([]);
      const channel: Channel = {
        id: 301,
        name: 'Rapid Movie',
        favorite: false,
        media_type: MediaType.movie,
      };

      const states: boolean[] = [];
      service.favoriteChanged$.subscribe((e) => {
        if (e.channelId === 301) states.push(e.isFavorite);
      });

      // Rapidly toggle 3 times: false -> true -> false -> true
      service.toggleFavorite(channel);
      service.toggleFavorite(channel);
      service.toggleFavorite(channel);

      expect(channel.favorite).toBeTrue();
      expect(service.isFavorite(301)).toBeTrue();
      expect(states).toEqual([true, false, true]);

      // Cached list should have exactly 1 entry for 301, not duplicates
      const cached = service.getCachedFavorites();
      const occurrences = (cached || []).filter((c) => c.id === 301);
      expect(occurrences.length).toBe(1);
    });

    it('should remove from cachedFavorites when unfavorited', () => {
      const channel: Channel = {
        id: 401,
        name: 'To Remove',
        favorite: true,
        media_type: MediaType.movie,
      };

      service.setInitialFavorites([channel]);
      expect(service.getCachedFavorites()?.length).toBe(1);

      service.toggleFavorite(channel);

      expect(channel.favorite).toBeFalse();
      expect(service.getCachedFavorites()?.length).toBe(0);
    });
  });

  describe('setFavorite', () => {
    it('should no-op if channel already has the desired state', () => {
      const channel: Channel = {
        id: 501,
        name: 'Already Fav',
        favorite: true,
        media_type: MediaType.movie,
      };

      let emitted = false;
      service.favoriteChanged$.subscribe(() => {
        emitted = true;
      });

      service.setFavorite(channel, true);
      expect(emitted).toBeFalse();
    });

    it('should toggle if state differs', () => {
      const channel: Channel = {
        id: 502,
        name: 'Not Fav Yet',
        favorite: false,
        media_type: MediaType.movie,
      };

      service.setFavorite(channel, true);
      expect(channel.favorite).toBeTrue();
      expect(service.isFavorite(502)).toBeTrue();
    });
  });

  describe('Persistence failure and rollback', () => {
    it('should roll back optimistic state and show toast when background persistence fails', async () => {
      (window as any).__TAURI_INTERNALS__.invoke.and.returnValue(Promise.reject(new Error('SQLite Busy')));

      const channel: Channel = {
        id: 601,
        name: 'Failing Channel',
        favorite: false,
        media_type: MediaType.movie,
      };

      service.toggleFavorite(channel);
      // Immediately optimistic
      expect(channel.favorite).toBeTrue();
      expect(service.isFavorite(601)).toBeTrue();

      // Wait for persistence loop failure handling
      await new Promise((r) => setTimeout(r, 60));

      // Rolled back to false
      expect(channel.favorite).toBeFalse();
      expect(service.isFavorite(601)).toBeFalse();
      expect(mockToastr.error).toHaveBeenCalled();
    });
  });
});
