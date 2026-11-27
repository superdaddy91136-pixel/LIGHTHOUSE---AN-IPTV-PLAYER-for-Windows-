import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from "@angular/core";
import { Router } from "@angular/router";
import { invoke } from "@tauri-apps/api/core";
import { Subject, Subscription } from "rxjs";
import { debounceTime } from "rxjs/operators";
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";
import { Filters } from "../models/filters";
import { MediaType } from "../models/mediaType";
import { NavTab } from "../models/navTab";
import { SourceType } from "../models/sourceType";
import { ViewMode } from "../models/viewMode";
import { EmbeddedPlayerService, WatchProgressRecord } from "../services/embedded-player.service";
import { FavoritesService } from "../services/favorites.service";

type ProfileSection = "favorites" | "history" | "hidden";

export interface ProfileSectionCounts {
  total: number;
  live: number;
  movies: number;
  series: number;
  groups: number;
}

export interface ProfileCounts {
  favorites: ProfileSectionCounts;
  history: ProfileSectionCounts;
  hidden: ProfileSectionCounts;
}

const emptySectionCounts = (): ProfileSectionCounts => ({
  total: 0,
  live: 0,
  movies: 0,
  series: 0,
  groups: 0,
});

// Kept in sync with the existing Rust search page size until that command exposes pagination metadata.
const PROFILE_PAGE_SIZE = 36;
const SEARCH_DEBOUNCE_MS = 300;

interface HistoryCardEnrichment {
  timeLabel?: string;
  progressPercent?: number;
}

@Component({
  selector: "app-profile",
  templateUrl: "./profile.component.html",
  styleUrl: "./profile.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileComponent implements OnInit, OnDestroy {
  activeSection: ProfileSection = "favorites";
  private playerSub?: Subscription;
  private favSub?: Subscription;
  private searchSubs: Subscription[] = [];
  private favSearch$ = new Subject<void>();
  private historySearch$ = new Subject<void>();
  private hiddenSearch$ = new Subject<void>();
  private enabledSourceIds?: number[];
  private favRequestId = 0;
  private historyRequestId = 0;
  private hiddenRequestId = 0;
  private countsRequestId = 0;
  private historyProgressRequestId = 0;

  @ViewChild("controlsSentinel") controlsSentinel?: ElementRef<HTMLElement>;
  @ViewChild("clearHistoryTrigger") clearHistoryTrigger?: ElementRef<HTMLButtonElement>;
  @ViewChild("clearHistoryCancelBtn") clearHistoryCancelBtn?: ElementRef<HTMLButtonElement>;

  readonly skeletonPlaceholders = Array.from({ length: 12 }, (_, i) => i);
  isControlsScrolled: boolean = false;
  showClearHistoryConfirm: boolean = false;
  clearingHistory: boolean = false;
  private historyEnrichmentById = new Map<number, HistoryCardEnrichment>();

  countsLoaded: boolean = false;
  profileCounts: ProfileCounts = {
    favorites: emptySectionCounts(),
    history: emptySectionCounts(),
    hidden: emptySectionCounts(),
  };

  // Favorites state
  favoriteChannels: Channel[] = [];
  favSearchQuery: string = "";
  favMediaType: number = -1;
  loadingFavorites: boolean = false;
  favLoaded: boolean = false;
  favHasMore: boolean = false;
  favError?: string;
  private favPage = 0;

  // History state
  historyChannels: Channel[] = [];
  historySearchQuery: string = "";
  historyMediaType: number = -1;
  loadingHistory: boolean = false;
  historyLoaded: boolean = false;
  historyHasMore: boolean = false;
  historyError?: string;
  private historyPage = 0;

  // Hidden state
  hiddenChannels: Channel[] = [];
  hiddenSearchQuery: string = "";
  hiddenMediaType: number = -1;
  loadingHidden: boolean = false;
  hiddenLoaded: boolean = false;
  hiddenHasMore: boolean = false;
  hiddenError?: string;
  private hiddenPage = 0;

  viewModeEnum = ViewMode;

  get hasFavFilters(): boolean {
    return this.favMediaType !== -1 || this.favSearchQuery.trim().length > 0;
  }

  get hasHistoryFilters(): boolean {
    return this.historyMediaType !== -1 || this.historySearchQuery.trim().length > 0;
  }

  get hasHiddenFilters(): boolean {
    return this.hiddenMediaType !== -1 || this.hiddenSearchQuery.trim().length > 0;
  }

  constructor(
    private router: Router,
    public memory: MemoryService,
    public embeddedPlayer: EmbeddedPlayerService,
    private favoritesService: FavoritesService,
    private cdr: ChangeDetectorRef,
  ) {}

  isInputFocused(): boolean {
    const activeElement = document.activeElement;
    return (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement
    );
  }

  @HostListener("window:scroll")
  onWindowScroll() {
    this.updateStickyControlsState();
  }

  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    if (this.showClearHistoryConfirm) {
      if (event.key === "Escape") {
        this.cancelClearHistory();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (this.embeddedPlayer.isPlayingEmbedded) {
      // Key events during embedded playback are handled directly by EmbeddedPlayerService
      return;
    }
    if (
      event.key === "Escape" ||
      event.key === "BrowserBack" ||
      (event.key === "Backspace" && !this.isInputFocused())
    ) {
      if (this.memory.ModalRef) {
        this.memory.ModalRef.close("close");
      } else {
        this.goBack();
      }
      event.preventDefault();
    }
  }

  ngOnInit(): void {
    this.memory.activeNavTab.next(NavTab.Profile);
    this.playerSub = this.embeddedPlayer.isPlayingEmbedded$.subscribe(() => {
      this.cdr.detectChanges();
    });

    // Subscribe to real-time favorites synchronization across screens
    this.favSub = this.favoritesService.favoriteChanged$.subscribe((event) => {
      const channelId = event.channelId;
      if (event.isFavorite) {
        const targetChannel =
          event.channel || this.favoriteChannels.find((c) => Number(c.id) === Number(channelId));
        if (targetChannel) {
          targetChannel.favorite = true;
          const matchesType =
            this.favMediaType === -1 || targetChannel.media_type === this.favMediaType;
          const q = this.favSearchQuery.trim().toLowerCase();
          const matchesQuery = !q || (targetChannel.name || "").toLowerCase().includes(q);
          if (
            matchesType &&
            matchesQuery &&
            !this.favoriteChannels.some(
              (c) => Number(c.id) === Number(channelId) && c.media_type === targetChannel.media_type
            )
          ) {
            this.favoriteChannels = [targetChannel, ...this.favoriteChannels];
          }
        }
      } else {
        const beforeLen = this.favoriteChannels.length;
        this.favoriteChannels = this.favoriteChannels.filter((c) =>
          event.channel
            ? !(Number(c.id) === Number(channelId) && c.media_type === event.channel.media_type)
            : Number(c.id) !== Number(channelId)
        );
        if (this.favoriteChannels.length < beforeLen) {
          const mediaType = event.channel?.media_type;
          this.decrementSectionCount(this.profileCounts.favorites, mediaType);
        }
      }
      void this.loadProfileCounts();
      this.cdr.markForCheck();
    });

    this.searchSubs.push(
      this.favSearch$.pipe(debounceTime(SEARCH_DEBOUNCE_MS)).subscribe(() => {
        void this.loadFavorites(true);
      }),
      this.historySearch$.pipe(debounceTime(SEARCH_DEBOUNCE_MS)).subscribe(() => {
        void this.loadHistory(true);
      }),
      this.hiddenSearch$.pipe(debounceTime(SEARCH_DEBOUNCE_MS)).subscribe(() => {
        void this.loadHidden(true);
      }),
    );

    void this.loadProfileCounts();
    void this.loadFavorites(true);
  }

  ngOnDestroy(): void {
    this.playerSub?.unsubscribe();
    this.favSub?.unsubscribe();
    this.searchSubs.forEach((sub) => sub.unsubscribe());
    if (this.embeddedPlayer.isPlayingEmbedded) {
      this.embeddedPlayer.stopPlayer().catch(console.warn);
    }
  }

  setSection(section: ProfileSection) {
    this.activeSection = section;
    this.isControlsScrolled = false;
    setTimeout(() => this.updateStickyControlsState(), 0);
    if (section === "favorites" && !this.favLoaded && !this.loadingFavorites) {
      void this.loadFavorites(true);
    } else if (section === "history" && !this.historyLoaded && !this.loadingHistory) {
      void this.loadHistory(true);
    } else if (section === "hidden" && !this.hiddenLoaded && !this.loadingHidden) {
      void this.loadHidden(true);
    }
  }

  private updateStickyControlsState(): void {
    const el = this.controlsSentinel?.nativeElement;
    const next = el ? el.getBoundingClientRect().top < 0 : window.scrollY > 96;
    if (next !== this.isControlsScrolled) {
      this.isControlsScrolled = next;
      this.cdr.markForCheck();
    }
  }

  setFavMediaType(type: number) {
    if (this.favMediaType === type) return;
    this.favMediaType = type;
    void this.loadFavorites(true);
  }

  onFavSearchChange() {
    this.favSearch$.next();
  }

  clearFavFilters() {
    this.favMediaType = -1;
    this.favSearchQuery = "";
    void this.loadFavorites(true);
  }

  private populateSourceMaps(sources: any[]): void {
    for (const s of sources) {
      if (s.id && !this.memory.Sources.has(s.id)) {
        this.memory.Sources.set(s.id, s);
      }
      if (s.source_type === SourceType.Xtream && s.id) {
        this.memory.XtreamSourceIds.add(s.id);
      }
    }
  }

  trackByChannelId(index: number, channel: Channel): string {
    return `${channel.media_type}:${channel.id ?? index}`;
  }

  private async getEnabledSourceIds(forceRefresh: boolean = false): Promise<number[]> {
    if (this.enabledSourceIds && !forceRefresh) {
      return this.enabledSourceIds;
    }

    const sources = (await invoke("get_sources")) as any[];
    this.populateSourceMaps(sources || []);
    this.enabledSourceIds = (sources || [])
      .filter((source) => source.enabled && source.id != null)
      .map((source) => source.id);
    return this.enabledSourceIds;
  }

  private decrementSectionCount(counts: ProfileSectionCounts, mediaType?: number): void {
    if (counts.total > 0) {
      counts.total--;
    }
    if (mediaType === MediaType.livestream && counts.live > 0) counts.live--;
    else if (mediaType === MediaType.movie && counts.movies > 0) counts.movies--;
    else if (mediaType === MediaType.serie && counts.series > 0) counts.series--;
    else if (mediaType === MediaType.group && counts.groups > 0) counts.groups--;
  }

  private mergePageChannels(existing: Channel[], incoming: Channel[]): Channel[] {
    const seen = new Set(existing.map((c) => `${c.media_type}:${c.id}`));
    const merged = [...existing];
    for (const item of incoming) {
      const key = `${item.media_type}:${item.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
    return merged;
  }

  async loadProfileCounts(): Promise<void> {
    const requestId = ++this.countsRequestId;
    try {
      const counts = (await invoke("get_profile_counts")) as ProfileCounts;
      if (requestId !== this.countsRequestId || !counts) return;
      this.profileCounts = counts;
      this.countsLoaded = true;
      this.cdr.markForCheck();
    } catch (e) {
      console.error("Failed to load profile counts", e);
    }
  }

  private async loadPage(
    viewType: ViewMode,
    page: number,
    mediaType: number,
    query: string,
    forceSources: boolean
  ): Promise<Channel[]> {
    const sourceIds = await this.getEnabledSourceIds(forceSources);
    if (sourceIds.length === 0) return [];

    const mediaTypes =
      mediaType !== -1
        ? [mediaType]
        : viewType === ViewMode.Hidden
          ? [MediaType.livestream, MediaType.movie, MediaType.serie, MediaType.group]
          : [MediaType.livestream, MediaType.movie, MediaType.serie];
    const trimmedQuery = query.trim();

    const filters: Filters = {
      source_ids: sourceIds,
      view_type: viewType,
      media_types: mediaTypes,
      page,
      query: trimmedQuery.length > 0 ? trimmedQuery : undefined,
      use_keywords: trimmedQuery.length > 0,
    };
    return (await invoke("search", { filters })) as Channel[];
  }

  async loadFavorites(reset: boolean = true, refreshCounts: boolean = false) {
    if (!reset && this.loadingFavorites) return;
    const requestId = ++this.favRequestId;
    this.loadingFavorites = true;
    this.favError = undefined;
    this.cdr.markForCheck();
    try {
      const page = reset ? 1 : this.favPage + 1;
      const results = await this.loadPage(
        ViewMode.Favorites,
        page,
        this.favMediaType,
        this.favSearchQuery,
        reset
      );
      if (requestId !== this.favRequestId) return;
      this.favoriteChannels = reset
        ? results
        : this.mergePageChannels(this.favoriteChannels, results);
      this.favPage = page;
      this.favHasMore = results.length === PROFILE_PAGE_SIZE;
      this.favLoaded = true;
      if (refreshCounts) {
        void this.loadProfileCounts();
      }
    } catch (e) {
      console.error("Failed to load favorites", e);
      if (requestId === this.favRequestId) {
        this.favError = "Favorites could not be loaded. Please try again.";
      }
    } finally {
      if (requestId === this.favRequestId) {
        this.loadingFavorites = false;
        this.cdr.markForCheck();
      }
    }
  }

  loadMoreFavorites() {
    void this.loadFavorites(false);
  }

  setHistoryMediaType(type: number) {
    if (this.historyMediaType === type) return;
    this.historyMediaType = type;
    void this.loadHistory(true);
  }

  onHistorySearchChange() {
    this.historySearch$.next();
  }

  clearHistoryFilters() {
    this.historyMediaType = -1;
    this.historySearchQuery = "";
    void this.loadHistory(true);
  }

  async loadHistory(reset: boolean = true, refreshCounts: boolean = false) {
    if (!reset && this.loadingHistory) return;
    const requestId = ++this.historyRequestId;
    this.loadingHistory = true;
    this.historyError = undefined;
    this.cdr.markForCheck();
    try {
      const page = reset ? 1 : this.historyPage + 1;
      const results = await this.loadPage(
        ViewMode.History,
        page,
        this.historyMediaType,
        this.historySearchQuery,
        reset
      );
      if (requestId !== this.historyRequestId) return;
      this.historyChannels = reset
        ? results
        : this.mergePageChannels(this.historyChannels, results);
      this.historyPage = page;
      this.historyHasMore = results.length === PROFILE_PAGE_SIZE;
      this.historyLoaded = true;
      if (reset) {
        this.historyEnrichmentById.clear();
      }
      void this.enrichHistoryProgress(results, reset);
      if (refreshCounts) {
        void this.loadProfileCounts();
      }
    } catch (e) {
      console.error("Failed to load history", e);
      if (requestId === this.historyRequestId) {
        this.historyError = "Watch History could not be loaded. Please try again.";
      }
    } finally {
      if (requestId === this.historyRequestId) {
        this.loadingHistory = false;
        this.cdr.markForCheck();
      }
    }
  }

  loadMoreHistory() {
    void this.loadHistory(false);
  }

  getHistoryTimeLabel(channel: Channel): string | undefined {
    if (channel.id == null) return undefined;
    return this.historyEnrichmentById.get(channel.id)?.timeLabel;
  }

  getHistoryProgressPercent(channel: Channel): number | undefined {
    if (channel.id == null) return undefined;
    return this.historyEnrichmentById.get(channel.id)?.progressPercent;
  }

  private async enrichHistoryProgress(channels: Channel[], reset: boolean): Promise<void> {
    const requestId = reset ? ++this.historyProgressRequestId : this.historyProgressRequestId;
    const ids = channels
      .filter((c) => c.media_type !== MediaType.livestream && c.id != null && c.id > 0)
      .map((c) => c.id as number);
    if (ids.length === 0) return;

    try {
      const records = (await invoke("get_watch_progress_batch", {
        channelIds: ids.slice(0, 200),
      })) as WatchProgressRecord[];
      if (requestId !== this.historyProgressRequestId || !Array.isArray(records)) return;

      for (const rec of records) {
        if (rec?.channel_id == null) continue;
        const pos = Number.isFinite(rec.position_sec) && rec.position_sec > 0 ? rec.position_sec : 0;
        const dur = Number.isFinite(rec.duration_sec) && rec.duration_sec > 0 ? rec.duration_sec : 0;
        const rawPct =
          Number.isFinite(rec.progress_percent) && rec.progress_percent >= 0
            ? rec.progress_percent
            : dur > 0
              ? (pos / dur) * 100
              : 0;
        const isCompleted =
          rec.completed === true ||
          rawPct >= 95 ||
          (dur > 30 && pos >= dur - 30) ||
          (dur > 0 && pos / dur >= 0.95);
        const isPartial = !isCompleted && (pos > 10 || rawPct > 1);
        const progressPercent = isPartial ? Math.min(95, Math.max(2, Math.round(rawPct))) : undefined;
        const timeLabel = rec.last_watched > 0 ? this.formatRelativeWatchedTime(rec.last_watched) : undefined;
        if (timeLabel || progressPercent !== undefined) {
          this.historyEnrichmentById.set(rec.channel_id, { timeLabel, progressPercent });
        }
      }
      this.cdr.markForCheck();
    } catch {
      // Non-critical enrichment: leave cards without extra metadata on failure
    }
  }

  private formatRelativeWatchedTime(timestamp: number): string {
    const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
    const now = Date.now();
    const diffMs = Math.max(0, now - ms);
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;

    const watchedDate = new Date(ms);
    const today = new Date(now);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (
      watchedDate.getFullYear() === yesterday.getFullYear() &&
      watchedDate.getMonth() === yesterday.getMonth() &&
      watchedDate.getDate() === yesterday.getDate()
    ) {
      return "Yesterday";
    }

    const sameYear = watchedDate.getFullYear() === today.getFullYear();
    return watchedDate.toLocaleDateString(undefined, sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" });
  }

  clearHistory() {
    this.showClearHistoryConfirm = true;
    this.cdr.markForCheck();
    setTimeout(() => {
      this.clearHistoryCancelBtn?.nativeElement?.focus();
    }, 0);
  }

  cancelClearHistory() {
    if (this.clearingHistory) return;
    this.showClearHistoryConfirm = false;
    this.cdr.markForCheck();
    setTimeout(() => {
      this.clearHistoryTrigger?.nativeElement?.focus();
    }, 0);
  }

  async confirmClearHistory() {
    if (this.clearingHistory) return;
    this.clearingHistory = true;
    this.cdr.markForCheck();
    try {
      await this.memory.tryIPC(
        "History cleared successfully",
        "Failed to clear history",
        async () => {
          await invoke("clear_history");
          this.embeddedPlayer.clearWatchHistoryCaches();
          this.historyRequestId++;
          this.historyProgressRequestId++;
          this.historyChannels = [];
          this.historyEnrichmentById.clear();
          this.historyLoaded = true;
          this.historyHasMore = false;
          this.profileCounts.history = emptySectionCounts();
          void this.loadProfileCounts();
        }
      );
      this.showClearHistoryConfirm = false;
    } finally {
      this.clearingHistory = false;
      this.cdr.markForCheck();
    }
  }

  setHiddenMediaType(type: number) {
    if (this.hiddenMediaType === type) return;
    this.hiddenMediaType = type;
    void this.loadHidden(true);
  }

  onHiddenSearchChange() {
    this.hiddenSearch$.next();
  }

  clearHiddenFilters() {
    this.hiddenMediaType = -1;
    this.hiddenSearchQuery = "";
    void this.loadHidden(true);
  }

  async loadHidden(reset: boolean = true, refreshCounts: boolean = false) {
    if (!reset && this.loadingHidden) return;
    const requestId = ++this.hiddenRequestId;
    this.loadingHidden = true;
    this.hiddenError = undefined;
    this.cdr.markForCheck();
    try {
      const page = reset ? 1 : this.hiddenPage + 1;
      const results = await this.loadPage(
        ViewMode.Hidden,
        page,
        this.hiddenMediaType,
        this.hiddenSearchQuery,
        reset
      );
      if (requestId !== this.hiddenRequestId) return;
      this.hiddenChannels = reset
        ? results
        : this.mergePageChannels(this.hiddenChannels, results);
      this.hiddenPage = page;
      this.hiddenHasMore = results.length === PROFILE_PAGE_SIZE;
      this.hiddenLoaded = true;
      if (refreshCounts) {
        void this.loadProfileCounts();
      }
    } catch (e) {
      console.error("Failed to load hidden items", e);
      if (requestId === this.hiddenRequestId) {
        this.hiddenError = "Hidden items could not be loaded. Please try again.";
      }
    } finally {
      if (requestId === this.hiddenRequestId) {
        this.loadingHidden = false;
        this.cdr.markForCheck();
      }
    }
  }

  loadMoreHidden() {
    void this.loadHidden(false);
  }

  onRemovedFromHistory(channel: Channel) {
    this.historyChannels = this.historyChannels.filter(
      (c) => !(c.id === channel.id && c.media_type === channel.media_type)
    );
    this.decrementSectionCount(this.profileCounts.history, channel.media_type);
    void this.loadProfileCounts();
    this.cdr.markForCheck();
  }

  onChannelUnhidden(channel: Channel) {
    this.hiddenChannels = this.hiddenChannels.filter(
      (c) => !(c.id === channel.id && c.media_type === channel.media_type)
    );
    this.decrementSectionCount(this.profileCounts.hidden, channel.media_type);
    void this.loadProfileCounts();
    this.cdr.markForCheck();
  }

  goBack() {
    if (this.embeddedPlayer.isPlayingEmbedded) {
      this.embeddedPlayer.stopPlayer().catch(console.warn);
      return;
    }
    this.memory.activeNavTab.next(NavTab.Home);
    this.router.navigateByUrl("");
  }
}
