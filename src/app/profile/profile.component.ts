import { AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, OnDestroy, OnInit, Optional, ViewChild } from "@angular/core";
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
import { MovieDetailService } from "../services/movie-detail.service";
import { TvDetailService } from "../services/tv-detail.service";
import { cleanMediaTitle } from "../utils/media-presentation";

type ProfileSection = "favorites" | "history" | "hidden";
type HistoryViewMode = "grid" | "list";
type ConfirmActionKind = "clearHistory" | "bulkUnfavorite" | "bulkRemoveHistory" | "bulkUnhide";

interface ConfirmModalState {
  kind: ConfirmActionKind;
  title: string;
  message: string;
  confirmLabel: string;
}

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
const BULK_IPC_BATCH_SIZE = 6;
const HISTORY_VIEW_MODE_STORAGE_KEY = "lh_profile_history_view";

interface HistoryCardEnrichment {
  timeLabel?: string;
  progressPercent?: number;
}

interface HistoryListRowMeta {
  cleanTitle: string;
  sourceName: string;
  typeLabel: string;
}

@Component({
  selector: "app-profile",
  templateUrl: "./profile.component.html",
  styleUrl: "./profile.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileComponent implements OnInit, AfterViewInit, OnDestroy {
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
  private suppressFavSync = false;
  private scrollCleanup?: () => void;
  private focusTimerId?: ReturnType<typeof setTimeout>;
  private stickyTimerId?: ReturnType<typeof setTimeout>;

  @ViewChild("controlsSentinel") controlsSentinel?: ElementRef<HTMLElement>;
  @ViewChild("clearHistoryTrigger") clearHistoryTrigger?: ElementRef<HTMLButtonElement>;
  @ViewChild("confirmCancelBtn") confirmCancelBtn?: ElementRef<HTMLButtonElement>;

  readonly skeletonPlaceholders = Array.from({ length: 12 }, (_, i) => i);
  isControlsScrolled: boolean = false;
  confirmModal: ConfirmModalState | null = null;
  confirmBusy: boolean = false;
  private confirmReturnFocusEl: HTMLElement | null = null;
  private historyEnrichmentById = new Map<number, HistoryCardEnrichment>();
  private brokenListImages = new Set<string>();

  // Precomputed template lookup maps (avoid method calls in Angular template expressions)
  selectedKeyMap: Record<string, boolean> = {};
  historyTimeMap: Record<number, string> = {};
  historyProgressMap: Record<number, number> = {};
  historyListMetaMap: Record<string, HistoryListRowMeta | undefined> = {};
  brokenListImageMap: Record<string, boolean> = {};

  // Bulk selection state (scoped to activeSection and cleared on tab/filter changes)
  selectionMode: boolean = false;
  selectedKeys = new Set<string>();
  bulkActionRunning: boolean = false;
  bulkStatusMessage?: string;
  bulkStatusIsError: boolean = false;

  // Watch History view toggle
  historyViewMode: HistoryViewMode = this.readHistoryViewMode();

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

  get selectedCount(): number {
    return this.selectedKeys.size;
  }

  get activeChannels(): Channel[] {
    if (this.activeSection === "favorites") return this.favoriteChannels;
    if (this.activeSection === "history") return this.historyChannels;
    return this.hiddenChannels;
  }

  get bulkActionLabel(): string {
    if (this.activeSection === "favorites") return "Unfavorite";
    if (this.activeSection === "history") return "Remove from history";
    return "Unhide";
  }

  constructor(
    private router: Router,
    public memory: MemoryService,
    public embeddedPlayer: EmbeddedPlayerService,
    private favoritesService: FavoritesService,
    private cdr: ChangeDetectorRef,
    @Optional() private movieDetailService?: MovieDetailService,
    @Optional() private tvDetailService?: TvDetailService,
    @Optional() private ngZone?: NgZone,
  ) {}

  isInputFocused(): boolean {
    const activeElement = document.activeElement;
    return (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement
    );
  }

  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    if (this.confirmModal) {
      if (event.key === "Escape") {
        this.cancelConfirmModal();
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (this.selectionMode && event.key === "Escape") {
      this.exitSelectionMode();
      event.preventDefault();
      event.stopPropagation();
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
      if (this.suppressFavSync) return;
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

  ngAfterViewInit(): void {
    this.setupScrollListenerOutsideZone();
  }

  ngOnDestroy(): void {
    this.playerSub?.unsubscribe();
    this.favSub?.unsubscribe();
    this.searchSubs.forEach((sub) => sub.unsubscribe());
    this.scrollCleanup?.();
    if (this.focusTimerId !== undefined) clearTimeout(this.focusTimerId);
    if (this.stickyTimerId !== undefined) clearTimeout(this.stickyTimerId);
    if (this.embeddedPlayer.isPlayingEmbedded) {
      this.embeddedPlayer.stopPlayer().catch(console.warn);
    }
  }

  private setupScrollListenerOutsideZone(): void {
    this.scrollCleanup?.();
    const attach = () => {
      const onScroll = () => this.updateStickyControlsState();
      window.addEventListener("scroll", onScroll, { passive: true });
      this.scrollCleanup = () => window.removeEventListener("scroll", onScroll);
    };
    if (this.ngZone) {
      this.ngZone.runOutsideAngular(attach);
    } else {
      attach();
    }
  }

  setSection(section: ProfileSection) {
    if (this.activeSection !== section) {
      this.exitSelectionMode(true);
    }
    this.activeSection = section;
    this.isControlsScrolled = false;
    if (this.stickyTimerId !== undefined) clearTimeout(this.stickyTimerId);
    this.stickyTimerId = setTimeout(() => this.updateStickyControlsState(), 0);
    if (section === "favorites" && !this.favLoaded && !this.loadingFavorites) {
      void this.loadFavorites(true);
    } else if (section === "history" && !this.historyLoaded && !this.loadingHistory) {
      void this.loadHistory(true);
    } else if (section === "hidden" && !this.hiddenLoaded && !this.loadingHidden) {
      void this.loadHidden(true);
    }
  }

  private readHistoryViewMode(): HistoryViewMode {
    try {
      const saved = localStorage.getItem(HISTORY_VIEW_MODE_STORAGE_KEY);
      return saved === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  }

  setHistoryViewMode(mode: HistoryViewMode): void {
    if (this.historyViewMode === mode) return;
    this.historyViewMode = mode;
    try {
      localStorage.setItem(HISTORY_VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors (private mode / quota)
    }
    this.cdr.markForCheck();
  }

  getChannelKey(channel: Channel, fallbackIndex?: number): string {
    return `${channel.media_type}:${channel.id ?? fallbackIndex ?? ""}`;
  }

  isSelected(channel: Channel): boolean {
    if (channel.id == null) return false;
    return this.selectedKeys.has(this.getChannelKey(channel));
  }

  toggleSelectionMode(): void {
    if (this.selectionMode) {
      this.exitSelectionMode();
      return;
    }
    this.selectionMode = true;
    this.selectedKeys.clear();
    this.syncSelectedKeyMap();
    this.bulkStatusMessage = undefined;
    this.bulkStatusIsError = false;
    this.cdr.markForCheck();
  }

  exitSelectionMode(clearStatus: boolean = false): void {
    this.selectionMode = false;
    this.selectedKeys.clear();
    this.syncSelectedKeyMap();
    if (clearStatus) {
      this.bulkStatusMessage = undefined;
      this.bulkStatusIsError = false;
    }
    this.cdr.markForCheck();
  }

  toggleItemSelection(channel: Channel): void {
    if (channel.id == null) return;
    const key = this.getChannelKey(channel);
    if (this.selectedKeys.has(key)) {
      this.selectedKeys.delete(key);
    } else {
      this.selectedKeys.add(key);
    }
    this.syncSelectedKeyMap();
    this.cdr.markForCheck();
  }

  selectAllLoaded(): void {
    for (const ch of this.activeChannels) {
      if (ch.id != null) {
        this.selectedKeys.add(this.getChannelKey(ch));
      }
    }
    this.syncSelectedKeyMap();
    this.cdr.markForCheck();
  }

  clearSelection(clearStatus: boolean = false): void {
    this.selectedKeys.clear();
    this.syncSelectedKeyMap();
    if (clearStatus) {
      this.bulkStatusMessage = undefined;
      this.bulkStatusIsError = false;
    }
    this.cdr.markForCheck();
  }

  private syncSelectedKeyMap(): void {
    const map: Record<string, boolean> = {};
    for (const key of this.selectedKeys) {
      map[key] = true;
    }
    this.selectedKeyMap = map;
  }

  dismissBulkStatus(): void {
    this.bulkStatusMessage = undefined;
    this.bulkStatusIsError = false;
    this.cdr.markForCheck();
  }

  private updateStickyControlsState(): void {
    const el = this.controlsSentinel?.nativeElement;
    const next = el ? el.getBoundingClientRect().top < 0 : window.scrollY > 96;
    if (next !== this.isControlsScrolled) {
      const apply = () => {
        this.isControlsScrolled = next;
        this.cdr.markForCheck();
      };
      if (this.ngZone) {
        this.ngZone.run(apply);
      } else {
        apply();
      }
    }
  }

  setFavMediaType(type: number) {
    if (this.favMediaType === type) return;
    this.favMediaType = type;
    this.clearSelection(true);
    void this.loadFavorites(true);
  }

  onFavSearchChange() {
    this.clearSelection(true);
    this.favSearch$.next();
  }

  clearFavFilters() {
    this.favMediaType = -1;
    this.favSearchQuery = "";
    this.clearSelection(true);
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
    this.clearSelection(true);
    void this.loadHistory(true);
  }

  onHistorySearchChange() {
    this.clearSelection(true);
    this.historySearch$.next();
  }

  clearHistoryFilters() {
    this.historyMediaType = -1;
    this.historySearchQuery = "";
    this.clearSelection(true);
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
        this.historyTimeMap = {};
        this.historyProgressMap = {};
      }
      this.rebuildHistoryListMetaMap();
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

      const timeMap: Record<number, string> = { ...this.historyTimeMap };
      const progressMap: Record<number, number> = { ...this.historyProgressMap };
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
          if (timeLabel) timeMap[rec.channel_id] = timeLabel;
          if (progressPercent !== undefined) progressMap[rec.channel_id] = progressPercent;
        }
      }
      this.historyTimeMap = timeMap;
      this.historyProgressMap = progressMap;
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

  getCleanTitle(channel: Channel): string {
    return cleanMediaTitle(channel.name || "");
  }

  getSourceName(channel: Channel): string {
    if (!channel.source_id) return "";
    return this.memory.Sources.get(channel.source_id)?.name || "";
  }

  getMediaTypeLabel(channel: Channel): string {
    if (channel.media_type === MediaType.livestream) return "Live";
    if (channel.media_type === MediaType.movie) return "Movie";
    if (channel.media_type === MediaType.serie) return "Series";
    if (channel.media_type === MediaType.group) return "Category";
    return "Item";
  }

  hasListImage(channel: Channel): boolean {
    return !!channel.image && !this.brokenListImages.has(channel.image);
  }

  private rebuildHistoryListMetaMap(): void {
    const map: Record<string, HistoryListRowMeta | undefined> = {};
    for (const ch of this.historyChannels) {
      map[this.getChannelKey(ch)] = {
        cleanTitle: this.getCleanTitle(ch),
        sourceName: this.getSourceName(ch),
        typeLabel: this.getMediaTypeLabel(ch),
      };
    }
    this.historyListMetaMap = map;
  }

  onListImageError(channel: Channel): void {
    if (channel.image) {
      this.brokenListImages.add(channel.image);
      this.brokenListImageMap = { ...this.brokenListImageMap, [channel.image]: true };
      this.cdr.markForCheck();
    }
  }

  onHistoryRowSpace(channel: Channel, event: Event): void {
    if (!this.selectionMode) return;
    event.preventDefault();
    this.toggleItemSelection(channel);
  }

  async openHistoryItem(channel: Channel): Promise<void> {
    if (this.selectionMode) {
      this.toggleItemSelection(channel);
      return;
    }
    if (channel.media_type === MediaType.serie) {
      this.tvDetailService?.openTvDetail(channel);
      return;
    }
    const isEpisode = !!(channel.season_id != null || channel.episode_num != null);
    if (channel.media_type === MediaType.movie && !isEpisode) {
      this.movieDetailService?.openMovieDetail(channel);
      return;
    }
    if (channel.id != null) {
      invoke("add_last_watched", { id: channel.id }).catch(console.error);
    }
    const mode = channel.media_type === MediaType.livestream ? "live" : isEpisode ? "episode" : "movie";
    const canvas = this.embeddedPlayer.resolveVideoCanvasId();
    await this.embeddedPlayer.startPlayer(
      { ...channel, favorite: !!channel.favorite },
      canvas,
      {
        title: cleanMediaTitle(channel.name || (mode === "live" ? "Live TV" : "Video")),
        mode,
      },
    );
  }

  async removeSingleHistoryRow(channel: Channel, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.selectionMode || channel.id == null) return;
    try {
      await invoke("remove_from_history", { id: channel.id });
      this.embeddedPlayer.clearWatchHistoryCaches([channel.id]);
      this.historyEnrichmentById.delete(channel.id);
      this.onRemovedFromHistory(channel);
    } catch (e) {
      console.error("Failed to remove history row", e);
    }
  }

  clearHistory() {
    this.openConfirmModal(
      {
        kind: "clearHistory",
        title: "Clear Watch History?",
        message: "This will permanently remove all watched movies, TV shows, and live channels from your watch history.",
        confirmLabel: "Clear History",
      },
      this.clearHistoryTrigger?.nativeElement,
    );
  }

  requestBulkAction(triggerEl?: HTMLElement | null): void {
    if (this.selectedKeys.size === 0 || this.bulkActionRunning) return;
    const count = this.selectedKeys.size;
    const noun = count === 1 ? "item" : "items";
    if (this.activeSection === "favorites") {
      this.openConfirmModal(
        {
          kind: "bulkUnfavorite",
          title: `Unfavorite ${count} ${noun}?`,
          message: `Remove ${count} selected ${noun} from your favorites?`,
          confirmLabel: `Unfavorite (${count})`,
        },
        triggerEl,
      );
    } else if (this.activeSection === "history") {
      this.openConfirmModal(
        {
          kind: "bulkRemoveHistory",
          title: `Remove ${count} ${noun} from history?`,
          message: `Remove ${count} selected ${noun} from your watch history?`,
          confirmLabel: `Remove (${count})`,
        },
        triggerEl,
      );
    } else {
      this.openConfirmModal(
        {
          kind: "bulkUnhide",
          title: `Unhide ${count} ${noun}?`,
          message: `Unhide ${count} selected ${noun} so they appear in your library again?`,
          confirmLabel: `Unhide (${count})`,
        },
        triggerEl,
      );
    }
  }

  private openConfirmModal(state: ConfirmModalState, returnFocusEl?: HTMLElement | null): void {
    this.confirmReturnFocusEl = returnFocusEl ?? (document.activeElement as HTMLElement | null);
    this.confirmModal = state;
    this.cdr.markForCheck();
    if (this.focusTimerId !== undefined) clearTimeout(this.focusTimerId);
    this.focusTimerId = setTimeout(() => {
      this.confirmCancelBtn?.nativeElement?.focus();
    }, 0);
  }

  cancelConfirmModal(): void {
    if (this.confirmBusy) return;
    this.confirmModal = null;
    const returnEl = this.confirmReturnFocusEl;
    this.confirmReturnFocusEl = null;
    this.cdr.markForCheck();
    if (this.focusTimerId !== undefined) clearTimeout(this.focusTimerId);
    this.focusTimerId = setTimeout(() => {
      returnEl?.focus?.();
    }, 0);
  }

  async executeConfirmModal(): Promise<void> {
    if (!this.confirmModal || this.confirmBusy) return;
    const kind = this.confirmModal.kind;
    this.confirmBusy = true;
    this.cdr.markForCheck();
    try {
      if (kind === "clearHistory") {
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
            this.historyTimeMap = {};
            this.historyProgressMap = {};
            this.historyListMetaMap = {};
            this.historyLoaded = true;
            this.historyHasMore = false;
            this.exitSelectionMode(true);
            this.profileCounts.history = emptySectionCounts();
            void this.loadProfileCounts();
          },
        );
        this.confirmModal = null;
      } else {
        this.confirmModal = null;
        await this.performBulkAction(kind);
      }
    } finally {
      this.confirmBusy = false;
      this.cdr.markForCheck();
    }
  }

  private async performBulkAction(
    kind: "bulkUnfavorite" | "bulkRemoveHistory" | "bulkUnhide",
  ): Promise<void> {
    const targets = this.activeChannels.filter(
      (c) => c.id != null && this.selectedKeys.has(this.getChannelKey(c)),
    );
    if (targets.length === 0) return;

    this.bulkActionRunning = true;
    this.bulkStatusMessage = undefined;
    this.bulkStatusIsError = false;
    this.cdr.markForCheck();

    const succeeded: Channel[] = [];
    const succeededKeys = new Set<string>();
    const failedKeys = new Set<string>();

    try {
      for (let i = 0; i < targets.length; i += BULK_IPC_BATCH_SIZE) {
        const batch = targets.slice(i, i + BULK_IPC_BATCH_SIZE);
        const settled = await Promise.allSettled(
          batch.map((ch) => {
            if (kind === "bulkUnfavorite") {
              return invoke("unfavorite_channel", { channelId: ch.id });
            }
            if (kind === "bulkRemoveHistory") {
              return invoke("remove_from_history", { id: ch.id });
            }
            const cmd = ch.media_type === MediaType.group ? "hide_group" : "hide_channel";
            return invoke(cmd, { id: ch.id, hidden: false });
          }),
        );
        settled.forEach((result, idx) => {
          const item = batch[idx];
          const key = this.getChannelKey(item);
          if (result.status === "fulfilled") {
            succeeded.push(item);
            succeededKeys.add(key);
          } else {
            failedKeys.add(key);
          }
        });
      }

      if (succeeded.length > 0) {
        if (kind === "bulkUnfavorite") {
          this.favoriteChannels = this.favoriteChannels.filter(
            (c) => !succeededKeys.has(this.getChannelKey(c)),
          );
          this.suppressFavSync = true;
          try {
            this.favoritesService.syncUnfavoritedChannels(succeeded);
          } finally {
            this.suppressFavSync = false;
          }
        } else if (kind === "bulkRemoveHistory") {
          const ids = succeeded.map((c) => c.id).filter((id): id is number => id != null);
          this.embeddedPlayer.clearWatchHistoryCaches(ids);
          for (const id of ids) {
            this.historyEnrichmentById.delete(id);
          }
          this.historyChannels = this.historyChannels.filter(
            (c) => !succeededKeys.has(this.getChannelKey(c)),
          );
          this.rebuildHistoryListMetaMap();
        } else {
          this.hiddenChannels = this.hiddenChannels.filter(
            (c) => !succeededKeys.has(this.getChannelKey(c)),
          );
          this.memory.clearCatalogPageCache();
        }
        await this.loadProfileCounts();
      }

      const actionDoneText =
        kind === "bulkUnfavorite"
          ? "removed from favorites"
          : kind === "bulkRemoveHistory"
            ? "removed from history"
            : "unhidden";

      if (failedKeys.size === 0) {
        this.selectionMode = false;
        this.selectedKeys.clear();
        this.syncSelectedKeyMap();
        this.bulkStatusMessage = `${succeeded.length} ${actionDoneText}`;
        this.bulkStatusIsError = false;
      } else {
        this.selectedKeys = failedKeys;
        this.syncSelectedKeyMap();
        this.bulkStatusIsError = true;
        this.bulkStatusMessage =
          succeeded.length > 0
            ? `${succeeded.length} ${actionDoneText}; ${failedKeys.size} failed`
            : `${failedKeys.size} failed to update`;
      }
    } finally {
      this.bulkActionRunning = false;
      this.cdr.markForCheck();
    }
  }

  setHiddenMediaType(type: number) {
    if (this.hiddenMediaType === type) return;
    this.hiddenMediaType = type;
    this.clearSelection(true);
    void this.loadHidden(true);
  }

  onHiddenSearchChange() {
    this.clearSelection(true);
    this.hiddenSearch$.next();
  }

  clearHiddenFilters() {
    this.hiddenMediaType = -1;
    this.hiddenSearchQuery = "";
    this.clearSelection(true);
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
    this.rebuildHistoryListMetaMap();
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
