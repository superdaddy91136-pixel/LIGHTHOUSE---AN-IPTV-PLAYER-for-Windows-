import { ChangeDetectorRef, Component, HostListener, OnDestroy, OnInit } from "@angular/core";
import { Router } from "@angular/router";
import { invoke } from "@tauri-apps/api/core";
import { ToastrService } from "ngx-toastr";
import { Subscription } from "rxjs";
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";
import { Filters } from "../models/filters";
import { MediaType } from "../models/mediaType";
import { NavTab } from "../models/navTab";
import { SortType } from "../models/sortType";
import { SourceType } from "../models/sourceType";
import { ViewMode } from "../models/viewMode";
import { EmbeddedPlayerService } from "../services/embedded-player.service";
import { FavoritesService } from "../services/favorites.service";

@Component({
  selector: "app-profile",
  templateUrl: "./profile.component.html",
  styleUrl: "./profile.component.css",
})
export class ProfileComponent implements OnInit, OnDestroy {
  activeSection: "favorites" | "history" | "hidden" = "favorites";
  private playerSub?: Subscription;
  private favSub?: Subscription;

  // Favorites state
  favoriteChannels: Channel[] = [];
  filteredFavorites: Channel[] = [];
  favSearchQuery: string = "";
  favMediaType: number = -1;
  loadingFavorites: boolean = false;

  // History state
  historyChannels: Channel[] = [];
  filteredHistory: Channel[] = [];
  historySearchQuery: string = "";
  historyMediaType: number = -1;
  loadingHistory: boolean = false;

  // Hidden state
  hiddenChannels: Channel[] = [];
  filteredHidden: Channel[] = [];
  hiddenSearchQuery: string = "";
  hiddenMediaType: number = -1;
  loadingHidden: boolean = false;

  mediaTypeEnum = MediaType;
  viewModeEnum = ViewMode;

  get favoriteMovies(): Channel[] {
    return this.filteredFavorites.filter((c) => c.media_type === MediaType.movie);
  }

  get favoriteTvShows(): Channel[] {
    return this.filteredFavorites.filter((c) => c.media_type === MediaType.serie);
  }

  get favoriteLiveTv(): Channel[] {
    return this.filteredFavorites.filter((c) => c.media_type === MediaType.livestream);
  }

  get historyMovies(): Channel[] {
    return this.filteredHistory.filter((c) => c.media_type === MediaType.movie);
  }

  get historyTvShows(): Channel[] {
    return this.filteredHistory.filter((c) => c.media_type === MediaType.serie);
  }

  get historyLiveTv(): Channel[] {
    return this.filteredHistory.filter((c) => c.media_type === MediaType.livestream);
  }

  get hiddenMovies(): Channel[] {
    return this.filteredHidden.filter((c) => c.media_type === MediaType.movie);
  }

  get hiddenTvShows(): Channel[] {
    return this.filteredHidden.filter((c) => c.media_type === MediaType.serie);
  }

  get hiddenLiveTv(): Channel[] {
    return this.filteredHidden.filter((c) => c.media_type === MediaType.livestream);
  }

  constructor(
    private router: Router,
    public memory: MemoryService,
    private toastr: ToastrService,
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

  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
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
          if (!this.favoriteChannels.some((c) => Number(c.id) === Number(channelId))) {
            this.favoriteChannels.unshift(targetChannel);
          }
        }
      } else {
        this.favoriteChannels = this.favoriteChannels.filter(
          (c) => Number(c.id) !== Number(channelId)
        );
      }
      this.filterFavorites();
      this.cdr.markForCheck();
    });

    this.loadFavorites();
    this.loadHistory();
    this.loadHidden();
  }

  ngOnDestroy(): void {
    this.playerSub?.unsubscribe();
    this.favSub?.unsubscribe();
    if (this.embeddedPlayer.isPlayingEmbedded) {
      this.embeddedPlayer.stopPlayer().catch(console.warn);
    }
  }

  setSection(section: "favorites" | "history" | "hidden") {
    this.activeSection = section;
    if (section === "favorites") {
      if (this.favoriteChannels.length === 0) {
        this.loadFavorites();
      } else {
        this.filterFavorites();
      }
    } else if (section === "history") {
      this.loadHistory();
    } else {
      this.loadHidden();
    }
  }

  setFavMediaType(type: number) {
    this.favMediaType = type;
    this.filterFavorites();
  }

  filterFavorites() {
    let list = this.favoriteChannels;
    if (this.favMediaType !== -1) {
      list = list.filter((c) => c.media_type === this.favMediaType);
    }
    if (this.favSearchQuery && this.favSearchQuery.trim() !== "") {
      const q = this.favSearchQuery.toLowerCase().trim();
      list = list.filter((c) => (c.name || "").toLowerCase().includes(q));
    }
    this.filteredFavorites = list;
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

  async loadFavorites(forceRefresh: boolean = false) {
    const cached = this.favoritesService.getCachedFavorites();
    if (cached && !forceRefresh) {
      this.favoriteChannels = cached;
      this.filterFavorites();
      return;
    }

    this.loadingFavorites = true;
    try {
      this.favoriteChannels = await this.favoritesService.loadFavorites(forceRefresh);
      this.filterFavorites();
    } catch (e) {
      console.error("Failed to load favorites", e);
    } finally {
      this.loadingFavorites = false;
      this.cdr.markForCheck();
    }
  }

  setHistoryMediaType(type: number) {
    this.historyMediaType = type;
    this.filterHistory();
  }

  filterHistory() {
    let list = this.historyChannels;
    if (this.historyMediaType !== -1) {
      list = list.filter((c) => c.media_type === this.historyMediaType);
    }
    if (this.historySearchQuery && this.historySearchQuery.trim() !== "") {
      const q = this.historySearchQuery.toLowerCase().trim();
      list = list.filter((c) => (c.name || "").toLowerCase().includes(q));
    }
    this.filteredHistory = list;
  }

  async loadHistory() {
    this.loadingHistory = true;
    try {
      const sources = (await invoke("get_sources")) as any[];
      this.populateSourceMaps(sources);
      const enabledSources = sources.filter((s) => s.enabled);
      if (enabledSources.length === 0) {
        this.historyChannels = [];
        this.filteredHistory = [];
        this.loadingHistory = false;
        return;
      }
      const sourceIds = enabledSources.map((s) => s.id);
      const filters: Filters = {
        source_ids: sourceIds,
        view_type: ViewMode.History,
        media_types: [MediaType.livestream, MediaType.movie, MediaType.serie],
        page: 1,
        use_keywords: false,
        sort: SortType.alphabeticalAscending,
      };
      let allHistory: Channel[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 25) {
        filters.page = page;
        const res = (await invoke("search", { filters })) as Channel[];
        if (res && res.length > 0) {
          allHistory = allHistory.concat(res);
          hasMore = res.length === 36;
          page++;
        } else {
          hasMore = false;
        }
      }
      this.historyChannels = allHistory;
      this.filterHistory();
    } catch (e) {
      console.error("Failed to load history", e);
    }
    this.loadingHistory = false;
  }

  async clearHistory() {
    await this.memory.tryIPC(
      "History cleared successfully",
      "Failed to clear history",
      async () => {
        await invoke("clear_history");
        this.historyChannels = [];
        this.filteredHistory = [];
      }
    );
  }

  setHiddenMediaType(type: number) {
    this.hiddenMediaType = type;
    this.filterHidden();
  }

  filterHidden() {
    let list = this.hiddenChannels;
    if (this.hiddenMediaType !== -1) {
      list = list.filter((c) => c.media_type === this.hiddenMediaType);
    }
    if (this.hiddenSearchQuery && this.hiddenSearchQuery.trim() !== "") {
      const q = this.hiddenSearchQuery.toLowerCase().trim();
      list = list.filter((c) => (c.name || "").toLowerCase().includes(q));
    }
    this.filteredHidden = list;
  }

  async loadHidden() {
    this.loadingHidden = true;
    try {
      const sources = (await invoke("get_sources")) as any[];
      this.populateSourceMaps(sources);
      const enabledSources = sources.filter((s) => s.enabled);
      if (enabledSources.length === 0) {
        this.hiddenChannels = [];
        this.filteredHidden = [];
        this.loadingHidden = false;
        return;
      }
      const sourceIds = enabledSources.map((s) => s.id);
      const filters: Filters = {
        source_ids: sourceIds,
        view_type: ViewMode.Hidden,
        media_types: [MediaType.livestream, MediaType.movie, MediaType.serie],
        page: 1,
        use_keywords: false,
        sort: SortType.alphabeticalAscending,
      };
      let allHidden: Channel[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 25) {
        filters.page = page;
        const res = (await invoke("search", { filters })) as Channel[];
        if (res && res.length > 0) {
          allHidden = allHidden.concat(res);
          hasMore = res.length === 36;
          page++;
        } else {
          hasMore = false;
        }
      }
      this.hiddenChannels = allHidden;
      this.filterHidden();
    } catch (e) {
      console.error("Failed to load hidden items", e);
    }
    this.loadingHidden = false;
  }

  async unhideChannel(channel: Channel) {
    const isGroup = channel.media_type === MediaType.group;
    const command = isGroup ? "hide_group" : "hide_channel";
    try {
      await invoke(command, { id: channel.id, hidden: false });
      channel.hidden = false;
      this.hiddenChannels = this.hiddenChannels.filter((c) => c.id !== channel.id);
      this.filterHidden();
      this.toastr.success(`Unhidden "${channel.name}"`);
    } catch (e) {
      this.toastr.error(`Failed to unhide "${channel.name}"`);
    }
  }

  onChannelUnhidden(channel: Channel) {
    this.hiddenChannels = this.hiddenChannels.filter((c) => c.id !== channel.id);
    this.filterHidden();
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
