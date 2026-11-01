import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  ViewChild,
} from "@angular/core";
import { Router } from "@angular/router";
import { AllowIn, ShortcutInput } from "ng-keyboard-shortcuts";
import {
  Subject,
  Subscription,
  debounceTime,
  distinctUntilChanged,
  filter,
  fromEvent,
  map,
  skip,
  takeUntil,
} from "rxjs";
import { MemoryService } from "../memory.service";
import { Channel } from "../models/channel";
import { EPG } from "../models/epg";
import { ViewMode } from "../models/viewMode";
import { MediaType } from "../models/mediaType";
import { ToastrService } from "ngx-toastr";
import { FocusArea, FocusAreaPrefix } from "../models/focusArea";
import { invoke } from "@tauri-apps/api/core";
import { Source } from "../models/source";
import { Filters } from "../models/filters";
import { SourceType } from "../models/sourceType";
import { animate, state, style, transition, trigger } from "@angular/animations";
import { ErrorService } from "../error.service";
import { Settings } from "../models/settings";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { SortType } from "../models/sortType";
import { TvDetailService } from "../services/tv-detail.service";
import { isInputFocused } from "../utils";
import { Node } from "../models/node";
import { NodeType, fromMediaType } from "../models/nodeType";
import { Stack } from "../models/stack";

import { BulkActionType } from '../models/bulkActionType';
import { NavTab } from '../models/navTab';
import {
  cleanMediaTitle,
  extractYear,
  sanitizeShowTitle,
  formatPlayerEpisodeLabel,
  isEpisodicOrTvContent,
} from '../utils/media-presentation';
import { ChannelSwitcherComponent } from '../channel-switcher/channel-switcher.component';
import { EpgQueueManager } from '../channel-tile/channel-tile.component';
import { PinService } from '../services/pin.service';
import { EmbeddedPlayerService } from '../services/embedded-player.service';
import { MovieDetailService } from '../services/movie-detail.service';
import { AmbientBackgroundService } from '../services/ambient-background.service';
import { SearchStateService, UniversalSearchResults, TabSearchState } from '../services/search-state.service';
import { VersionMatchingService } from '../services/version-matching.service';

export interface CategoryOption {
  id: number;
  name: string;
  sourceId: number;
  sourceName?: string;
  channelCount?: number;
  cleanName?: string;
  cleanNameLower?: string;
  isPinned?: boolean;
}

export type SortOption = 'default' | 'title-asc' | 'title-desc' | 'year-desc' | 'year-asc';

export type LiveFolderSort = 'default' | 'name-asc' | 'name-desc' | 'count-desc' | 'count-asc';

export interface TabFilterSortState {
  sourceId: number | 'all';
  categoryId?: number;
  sort: SortOption;
}

export { UniversalSearchResults, TabSearchState };

@Component({
  selector: "app-home",
  templateUrl: "./home.component.html",
  styleUrl: "./home.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [
    trigger("fadeInOut", [
      transition(":enter", [
        style({ opacity: 0, height: 0, padding: "0", margin: "0" }),
        animate("250ms", style({ opacity: 1, height: "*", padding: "*", margin: "*" })),
      ]),
      transition(":leave", [
        style({ opacity: 1, height: "*", padding: "*", margin: "*" }),
        animate("250ms", style({ opacity: 0, height: 0, padding: "0", margin: "0" })),
      ]),
    ]),
    trigger("fade", [
      state(
        "visible",
        style({
          opacity: 1,
        }),
      ),
      state(
        "hidden",
        style({
          opacity: 0,
        }),
      ),
      transition("visible => hidden", [animate("250ms ease-out")]),
      transition("hidden => visible", [animate("250ms ease-in")]),
    ]),
  ],
})
export class HomeComponent implements AfterViewInit, OnDestroy {
  channels: Channel[] = [];
  readonly viewModeEnum = ViewMode;
  bulkActionType = BulkActionType;
  readonly mediaTypeEnum = MediaType;
  @ViewChild("search") search!: ElementRef;
  shortcuts: ShortcutInput[] = [];
  focus: number = 0;
  focusArea = FocusArea.Tiles;
  viewType = ViewMode.All;
  currentWindowSize: number = window.innerWidth;
  subscriptions: Subscription[] = [];
  filters?: Filters;
  chkLiveStream = true;
  chkMovie = true;
  chkSerie = true;
  reachedMax = false;
  readonly PAGE_SIZE = 36;
  private catalogLoadRequestId = 0;
  channelsVisible = true;
  prevSearchValue: String = "";
  loading = false;
  get nodeStack(): Stack {
    return this.memory.nodeStack;
  }
  showScrollTop = false;
  @ViewChild(ChannelSwitcherComponent) channelSwitcher?: ChannelSwitcherComponent;
  livePlayingChannel?: Channel;

  searchResults: UniversalSearchResults = {
    channels: [],
    movies: [],
    tvShows: [],
    categories: [],
  };
  rawSearchResults: UniversalSearchResults = {
    channels: [],
    movies: [],
    tvShows: [],
    categories: [],
  };
  searchKeyword = "";
  isSearchExpanded = false;
  searchTypeFilter: 'all' | 'movies' | 'tv' | 'live' = 'all';
  searchSortBy: 'provider' | 'alphabetical' = 'provider';
  searchSortOrder: 'asc' | 'desc' = 'asc';
  private searchRequestId = 0;
  private pendingTabClick?: NavTab;
  private currentScrollPosition: number = 0;
  @ViewChild('searchRowMovies') searchRowMovies?: ElementRef<HTMLElement>;
  @ViewChild('searchRowTvShows') searchRowTvShows?: ElementRef<HTMLElement>;
  @ViewChild('searchRowChannels') searchRowChannels?: ElementRef<HTMLElement>;
  @ViewChild('searchRowCategories') searchRowCategories?: ElementRef<HTMLElement>;
  searchHorizontalScrollPositions: Record<string, number> = {};

  @ViewChild('filterSortWrapper') filterSortWrapper?: ElementRef;
  @ViewChild('liveFolderFilterWrapper') liveFolderFilterWrapper?: ElementRef;
  @ViewChild('liveSearchInput') liveSearchInput?: ElementRef;
  @ViewChild('liveTvContent') set liveTvContentRef(ref: ElementRef<HTMLElement> | undefined) {
    if (ref) {
      this.liveTvContent = ref;
      this.setupLiveContentScroll();
    } else {
      this.liveScrollSub?.unsubscribe();
      this.liveTvContent = undefined;
    }
  }
  liveTvContent?: ElementRef<HTMLElement>;
  liveFolderSort: LiveFolderSort = 'default';
  liveFolderSearchQuery = '';
  isFolderFilterMenuOpen = false;
  liveSearchSubject = new Subject<string>();
  liveSidebarSelection: {
    type: 'favorites' | 'category' | 'all';
    id?: number;
    name?: string;
    sourceId?: number;
  } | null = null;
  selectedSourceId: number | 'all' = 'all';
  selectedCategoryId?: number;
  selectedSort: SortOption = 'default';
  isFilterMenuOpen = false;
  availableCategories: CategoryOption[] = [];
  displayedLiveCategories: CategoryOption[] = [];
  categorySearchTerm = '';
  categoryLoading = false;
  private categoryLoadingInFlight = new Set<string>();
  private categoryCache: Map<string, CategoryOption[]> = new Map();
  private tabFilterStates: Map<NavTab, TabFilterSortState> = new Map();

  get isSearching(): boolean {
    return !!(this.filters?.query && this.filters.query.trim().length > 0);
  }

  currentPinnedItems: Channel[] = [];
  regularChannels: Channel[] = [];
  renderedRegularChannels: Channel[] = [];
  liveContentPinnedItems: Channel[] = [];
  private renderLimit: number = 48;
  private destroy$ = new Subject<void>();
  private liveScrollSub?: Subscription;

  updateRegularChannels(preserveLimit = false): void {
    let list = this.channels;
    if (this.currentPinnedItems.length > 0) {
      const pinnedIds = new Set(this.currentPinnedItems.map((p) => p.id));
      list = list.filter((c) => c.id != null && !pinnedIds.has(c.id));
    }
    this.regularChannels = this.applySortToChannels(list);
    if (!preserveLimit) {
      this.renderLimit = 48;
    }
    this.renderedRegularChannels = this.regularChannels.slice(0, this.renderLimit);
    this.cdr.markForCheck();
  }

  trackChannelById(_index: number, channel: Channel): number | string {
    return channel.id ?? channel.name ?? _index;
  }

  trackPinnedChannelById(_index: number, channel: Channel): number | string {
    return `pin_${channel.id ?? channel.name ?? _index}`;
  }

  get totalSearchResultsCount(): number {
    return (
      this.rawSearchResults.channels.length +
      this.rawSearchResults.movies.length +
      this.rawSearchResults.tvShows.length +
      this.rawSearchResults.categories.length
    );
  }

  get visibleSearchResultsCount(): number {
    return (
      this.searchResults.channels.length +
      this.searchResults.movies.length +
      this.searchResults.tvShows.length +
      this.searchResults.categories.length
    );
  }

  setSearchTypeFilter(filter: 'all' | 'movies' | 'tv' | 'live'): void {
    this.searchTypeFilter = filter;
    this.applySearchSortAndFilter();
    this.saveCurrentTabSearchState();
  }

  setSearchSortBy(sortBy: 'provider' | 'alphabetical'): void {
    this.searchSortBy = sortBy;
    this.applySearchSortAndFilter();
    this.saveCurrentTabSearchState();
  }

  setSearchSortOrder(order: 'asc' | 'desc'): void {
    this.searchSortOrder = order;
    this.applySearchSortAndFilter();
    this.saveCurrentTabSearchState();
  }

  onSearchRowScroll(category: string, event: Event): void {
    const el = event.target as HTMLElement;
    if (el) {
      this.searchHorizontalScrollPositions[category] = el.scrollLeft;
    }
  }

  private captureHorizontalScrollPositions(): void {
    if (this.searchRowMovies?.nativeElement) {
      this.searchHorizontalScrollPositions['movies'] = this.searchRowMovies.nativeElement.scrollLeft;
    }
    if (this.searchRowTvShows?.nativeElement) {
      this.searchHorizontalScrollPositions['tvShows'] = this.searchRowTvShows.nativeElement.scrollLeft;
    }
    if (this.searchRowChannels?.nativeElement) {
      this.searchHorizontalScrollPositions['channels'] = this.searchRowChannels.nativeElement.scrollLeft;
    }
    if (this.searchRowCategories?.nativeElement) {
      this.searchHorizontalScrollPositions['categories'] = this.searchRowCategories.nativeElement.scrollLeft;
    }
  }

  private restoreHorizontalScrollPositions(positions: Record<string, number>): void {
    if (!positions) return;
    this.cdr.detectChanges();
    const applyScrolls = () => {
      if (this.searchRowMovies?.nativeElement && positions['movies'] != null) {
        this.searchRowMovies.nativeElement.scrollLeft = positions['movies'];
      }
      if (this.searchRowTvShows?.nativeElement && positions['tvShows'] != null) {
        this.searchRowTvShows.nativeElement.scrollLeft = positions['tvShows'];
      }
      if (this.searchRowChannels?.nativeElement && positions['channels'] != null) {
        this.searchRowChannels.nativeElement.scrollLeft = positions['channels'];
      }
      if (this.searchRowCategories?.nativeElement && positions['categories'] != null) {
        this.searchRowCategories.nativeElement.scrollLeft = positions['categories'];
      }
    };

    requestAnimationFrame(() => {
      applyScrolls();
      requestAnimationFrame(() => {
        applyScrolls();
        setTimeout(applyScrolls, 60);
        setTimeout(applyScrolls, 150);
      });
    });
  }

  private saveCurrentTabSearchState(): void {
    const tab = this.memory.activeNavTab.value;
    if (this.isSearching) {
      const scrollPos =
        (window.scrollY || document.documentElement.scrollTop || window.pageYOffset || 0) ||
        this.currentScrollPosition ||
        0;
      this.captureHorizontalScrollPositions();
      this.searchStateService.setSearchState(tab, {
        query: this.filters?.query || "",
        searchKeyword: this.searchKeyword,
        rawSearchResults: this.rawSearchResults,
        searchResults: this.searchResults,
        searchTypeFilter: this.searchTypeFilter,
        searchSortBy: this.searchSortBy,
        searchSortOrder: this.searchSortOrder,
        isSearchExpanded: this.isSearchExpanded,
        scrollPosition: scrollPos,
        horizontalScrollPositions: { ...this.searchHorizontalScrollPositions },
      });
      this.memory.searchScrollPositions.set(tab, scrollPos);
      this.memory.searchHorizontalScrollPositions.set(tab, { ...this.searchHorizontalScrollPositions });
    } else {
      this.searchStateService.clearSearchState(tab);
      this.memory.searchScrollPositions.delete(tab);
      this.memory.searchHorizontalScrollPositions.delete(tab);
      this.searchHorizontalScrollPositions = {};
    }
  }

  saveOriginatingScrollPosition(): void {
    const currentScroll =
      (window.scrollY || document.documentElement.scrollTop || window.pageYOffset || 0) ||
      this.currentScrollPosition ||
      0;
    const tab = this.memory.activeNavTab.value;

    if (this.isSearching) {
      this.memory.searchScrollPositions.set(tab, currentScroll);
      this.captureHorizontalScrollPositions();
      this.memory.searchHorizontalScrollPositions.set(tab, { ...this.searchHorizontalScrollPositions });
      const searchState = this.searchStateService.getSearchState(tab);
      if (searchState) {
        searchState.scrollPosition = currentScroll;
        searchState.horizontalScrollPositions = { ...this.searchHorizontalScrollPositions };
      }
    } else if (this.filters?.group_id) {
      const key = `${tab}_${this.filters.group_id}`;
      this.memory.folderScrollPositions.set(key, currentScroll);
    } else if (this.isHomeDiscoveryMode) {
      this.memory.homeDiscoveryScrollPosition = currentScroll;
    } else if (this.filters?.view_type === ViewMode.All || !this.filters?.group_id) {
      this.memory.allScrollPositions.set(tab, currentScroll);
    }
  }

  private sortList(list: Channel[]): Channel[] {
    const copy = [...list];
    if (this.searchSortBy === 'provider') {
      if (this.searchSortOrder === 'desc') {
        copy.reverse();
      }
      return copy;
    } else {
      copy.sort((a, b) => {
        const nameA = cleanMediaTitle(a.name || '').toLowerCase();
        const nameB = cleanMediaTitle(b.name || '').toLowerCase();
        const cmp = nameA.localeCompare(nameB, undefined, { numeric: true });
        return this.searchSortOrder === 'asc' ? cmp : -cmp;
      });
      return copy;
    }
  }

  get isHomeSearchTab(): boolean {
    return this.memory.activeNavTab.value === NavTab.Home;
  }

  get isLiveTvSearch(): boolean {
    return (
      this.memory.activeNavTab.value === NavTab.LiveTV ||
      this.memory.activeNavTab.value === NavTab.Home
    );
  }

  applySearchSortAndFilter(): void {
    const currentTab = this.memory.activeNavTab.value;
    const isCatalogScoped =
      currentTab === NavTab.LiveTV ||
      currentTab === NavTab.Movies ||
      currentTab === NavTab.TVShows;

    if (isCatalogScoped) {
      let filteredChannels = this.rawSearchResults.channels;
      let filteredMovies = this.rawSearchResults.movies;
      let filteredTvShows = this.rawSearchResults.tvShows;
      let filteredCategories = this.rawSearchResults.categories;

      if (this.selectedCategoryId != null && currentTab !== NavTab.LiveTV) {
        filteredChannels = filteredChannels.filter((c) => c.group_id === this.selectedCategoryId);
        filteredMovies = filteredMovies.filter((c) => c.group_id === this.selectedCategoryId);
        filteredTvShows = filteredTvShows.filter((c) => c.group_id === this.selectedCategoryId);
        filteredCategories = filteredCategories.filter((c) => c.id === this.selectedCategoryId);
      }

      this.searchResults = {
        channels: this.applySortToChannels(this.sortList(filteredChannels)),
        movies: this.applySortToChannels(this.sortList(filteredMovies)),
        tvShows: this.applySortToChannels(this.sortList(filteredTvShows)),
        categories: this.applySortToChannels(this.sortList(filteredCategories)),
      };
      return;
    }

    const showAll = this.searchTypeFilter === 'all';
    const showLive = showAll || this.searchTypeFilter === 'live';
    const showMovies = showAll || this.searchTypeFilter === 'movies';
    const showTv = showAll || this.searchTypeFilter === 'tv';

    this.searchResults = {
      channels: showLive ? this.sortList(this.rawSearchResults.channels) : [],
      movies: showMovies ? this.sortList(this.rawSearchResults.movies) : [],
      tvShows: showTv ? this.sortList(this.rawSearchResults.tvShows) : [],
      categories: showLive ? this.sortList(this.rawSearchResults.categories) : [],
    };
  }

  get isLiveTvTab(): boolean {
    return this.memory.activeNavTab.value === NavTab.LiveTV;
  }

  get liveSelectedTitle(): string {
    if (this.isSearching) {
      return `Search: "${this.searchKeyword}"`;
    }
    if (!this.liveSidebarSelection) {
      return '';
    }
    if (this.liveSidebarSelection.type === 'favorites') {
      return 'Favorites';
    }
    if (this.liveSidebarSelection.type === 'all') {
      return 'All Channels';
    }
    if (this.liveSidebarSelection.type === 'category') {
      return cleanMediaTitle(this.liveSidebarSelection.name || 'Category');
    }
    return '';
  }

  get liveEmptyStateMessage(): string {
    if (!this.liveSidebarSelection) {
      return '';
    }
    if (this.liveSidebarSelection.type === 'favorites') {
      return 'No favorite channels yet. Click the heart on any channel to favorite it.';
    }
    if (this.liveSidebarSelection.type === 'all') {
      return 'No channels found.';
    }
    if (this.liveSidebarSelection.type === 'category') {
      return `No channels found in ${cleanMediaTitle(this.liveSidebarSelection.name || 'this folder')}.`;
    }
    return 'No channels found.';
  }

  get hasActiveFolderSort(): boolean {
    return this.liveFolderSort !== 'default';
  }

  toggleFolderFilterMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.isFolderFilterMenuOpen = !this.isFolderFilterMenuOpen;
  }

  closeFolderFilterMenu(): void {
    this.isFolderFilterMenuOpen = false;
  }

  setFolderSort(sort: LiveFolderSort): void {
    this.liveFolderSort = sort;
    localStorage.setItem('lighthouse_live_folder_sort', sort);
    this.updateDisplayedLiveCategories();
    this.cdr.markForCheck();
  }

  resetFolderSort(): void {
    this.liveFolderSort = 'default';
    localStorage.setItem('lighthouse_live_folder_sort', 'default');
    this.updateDisplayedLiveCategories();
    this.cdr.markForCheck();
  }

  private sortFolders(list: CategoryOption[]): CategoryOption[] {
    if (!list || list.length <= 1) return list;
    const copy = [...list];
    switch (this.liveFolderSort) {
      case 'name-asc':
        return copy.sort((a, b) => {
          const nameA = (a.cleanName || a.name || '').toLowerCase();
          const nameB = (b.cleanName || b.name || '').toLowerCase();
          return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
        });
      case 'name-desc':
        return copy.sort((a, b) => {
          const nameA = (a.cleanName || a.name || '').toLowerCase();
          const nameB = (b.cleanName || b.name || '').toLowerCase();
          return nameB.localeCompare(nameA, undefined, { numeric: true, sensitivity: 'base' });
        });
      case 'count-desc':
        return copy.sort((a, b) => {
          const countDiff = (b.channelCount ?? 0) - (a.channelCount ?? 0);
          if (countDiff !== 0) return countDiff;
          const nameA = (a.cleanName || a.name || '').toLowerCase();
          const nameB = (b.cleanName || b.name || '').toLowerCase();
          return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
        });
      case 'count-asc':
        return copy.sort((a, b) => {
          const countDiff = (a.channelCount ?? 0) - (b.channelCount ?? 0);
          if (countDiff !== 0) return countDiff;
          const nameA = (a.cleanName || a.name || '').toLowerCase();
          const nameB = (b.cleanName || b.name || '').toLowerCase();
          return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
        });
      case 'default':
      default:
        return copy;
    }
  }

  updateDisplayedLiveCategories(): void {
    const list = this.availableCategories;
    if (!list || list.length === 0) {
      this.displayedLiveCategories = [];
      return;
    }

    const pinnedGroupIds = new Set(
      this.pinService
        .getPinnedChannelsForTab(NavTab.LiveTV)
        .filter((item) => item.media_type === MediaType.group)
        .map((item) => item.id),
    );

    for (const cat of list) {
      cat.isPinned = pinnedGroupIds.has(cat.id);
    }

    let filtered = list;
    if (this.liveFolderSearchQuery && this.liveFolderSearchQuery.trim().length > 0) {
      const q = this.liveFolderSearchQuery.trim().toLowerCase();
      filtered = list.filter((cat) => (cat.cleanName || cat.name || '').toLowerCase().includes(q));
    }

    const sorted = this.sortFolders(filtered);
    const pinnedFolders: CategoryOption[] = [];
    const unpinnedFolders: CategoryOption[] = [];

    for (const category of sorted) {
      if (category.isPinned) {
        pinnedFolders.push(category);
      } else {
        unpinnedFolders.push(category);
      }
    }

    this.displayedLiveCategories = [...pinnedFolders, ...unpinnedFolders];
  }

  trackCategoryById(_index: number, item: CategoryOption): number {
    return item.id;
  }

  toCategoryChannel(cat: CategoryOption): Channel {
    return {
      id: cat.id,
      name: cat.name,
      media_type: MediaType.group,
      source_id: cat.sourceId,
    };
  }

  isCategoryPinned(cat: CategoryOption): boolean {
    return this.pinService.isPinned(this.toCategoryChannel(cat), NavTab.LiveTV);
  }

  toggleCategoryPin(cat: CategoryOption, event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    this.pinService.togglePin(this.toCategoryChannel(cat), NavTab.LiveTV);
    this.updatePinnedItems();
    this.updateDisplayedLiveCategories();
    this.cdr.markForCheck();
  }

  selectLiveSidebarFavorites(): void {
    EpgQueueManager.clearQueue();
    this.liveSidebarSelection = { type: 'favorites' };
    this.selectedCategoryId = undefined;
    if (this.filters) {
      this.filters.group_id = undefined;
      this.filters.view_type = ViewMode.Favorites;
      this.filters.page = 1;
    }
    this.nodeStack.clear();
    this.saveTabFilterState();
    this.updatePinnedItems();
    this.load();
    if (this.liveTvContent?.nativeElement) {
      this.liveTvContent.nativeElement.scrollTop = 0;
    }
  }

  selectLiveSidebarCategory(cat: CategoryOption): void {
    EpgQueueManager.clearQueue();
    this.liveSidebarSelection = {
      type: 'category',
      id: cat.id,
      name: cat.name,
      sourceId: cat.sourceId,
    };
    this.selectedCategoryId = cat.id;
    if (this.filters) {
      this.filters.group_id = cat.id;
      this.filters.view_type = ViewMode.All;
      this.filters.page = 1;
    }
    this.nodeStack.clear();
    this.saveTabFilterState();
    this.updatePinnedItems();
    this.load();
    if (this.liveTvContent?.nativeElement) {
      this.liveTvContent.nativeElement.scrollTop = 0;
    }
  }

  selectLiveSidebarAll(): void {
    EpgQueueManager.clearQueue();
    this.liveSidebarSelection = { type: 'all' };
    this.selectedCategoryId = undefined;
    if (this.filters) {
      this.filters.group_id = undefined;
      this.filters.view_type = ViewMode.All;
      this.filters.page = 1;
    }
    this.nodeStack.clear();
    this.saveTabFilterState();
    this.updatePinnedItems();
    this.load();
    if (this.liveTvContent?.nativeElement) {
      this.liveTvContent.nativeElement.scrollTop = 0;
    }
  }

  cleanCategoryTitle(name: string): string {
    return cleanMediaTitle(name || '');
  }

  onLiveFolderSearchInput(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this.liveFolderSearchQuery = val;
    this.updateDisplayedLiveCategories();
    this.cdr.markForCheck();
  }

  onLiveFolderSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.clearLiveFolderSearch();
    }
  }

  clearLiveFolderSearch(): void {
    this.liveFolderSearchQuery = '';
    if (this.liveSearchInput?.nativeElement) {
      this.liveSearchInput.nativeElement.value = '';
    }
    this.updateDisplayedLiveCategories();
    this.cdr.markForCheck();
  }

  private setupLiveContentScroll(): void {
    if (!this.liveTvContent?.nativeElement) return;
    this.liveScrollSub?.unsubscribe();
    this.ngZone.runOutsideAngular(() => {
      this.liveScrollSub = fromEvent(this.liveTvContent!.nativeElement, 'scroll')
        .pipe(takeUntil(this.destroy$))
        .subscribe((event: any) => {
          const el = event.target as HTMLElement;
          if (!el) return;
          const scrollHeight = el.scrollHeight;
          const scrollTop = el.scrollTop;
          const clientHeight = el.clientHeight;
          const isScrollTop = scrollTop > 300;
          if (this.showScrollTop !== isScrollTop) {
            this.ngZone.run(() => {
              this.showScrollTop = isScrollTop;
              this.cdr.markForCheck();
            });
          }
          if (this.loading) return;
          if (scrollTop + clientHeight >= scrollHeight * 0.75) {
            this.ngZone.run(() => {
              this.onLiveContentScrolledNearBottom();
            });
          }
        });
    });
  }

  onLiveContentScrolledNearBottom(): void {
    if (this.renderedRegularChannels.length < this.regularChannels.length) {
      this.renderLimit += 36;
      this.renderedRegularChannels = this.regularChannels.slice(0, this.renderLimit);
      this.cdr.markForCheck();
    } else if (this.reachedMax === false && this.loading === false) {
      this.loadMore();
    }
  }

  get isHomeDiscoveryMode(): boolean {
    return (
      this.memory.activeNavTab.value === NavTab.Home &&
      !this.nodeStack.hasNodes() &&
      !this.filters?.series_id &&
      !this.filters?.group_id &&
      !this.isSearching
    );
  }

  get isCatalogTab(): boolean {
    const tab = this.memory.activeNavTab.value;
    return tab === NavTab.LiveTV || tab === NavTab.Movies || tab === NavTab.TVShows;
  }

  get isCardGridMode(): boolean {
    const tab = this.memory.activeNavTab.value;
    if (tab === NavTab.Settings || this.isHomeDiscoveryMode) {
      return false;
    }
    return tab === NavTab.LiveTV || tab === NavTab.Movies || tab === NavTab.TVShows || this.filters?.view_type === ViewMode.Favorites;
  }

  getActiveCategoryName(): string {
    if (this.nodeStack.hasNodes()) {
      return this.nodeStack.get()?.name || '';
    }
    return '';
  }

  get enabledSourcesList(): Source[] {
    return Array.from(this.memory.Sources.values()).filter((s) => s.enabled !== false && s.id != null);
  }

  get displayedCategories(): CategoryOption[] {
    if (!this.categorySearchTerm) {
      return this.availableCategories;
    }
    const term = this.categorySearchTerm.toLowerCase().trim();
    return this.availableCategories.filter((c) => (c.name || '').toLowerCase().includes(term));
  }

  get hasActiveFilters(): boolean {
    return (
      this.selectedSourceId !== 'all' ||
      this.selectedCategoryId !== undefined ||
      this.selectedSort !== 'default'
    );
  }

  get activeFilterCount(): number {
    let count = 0;
    if (this.selectedSourceId !== 'all') count++;
    if (this.selectedCategoryId !== undefined) count++;
    if (this.selectedSort !== 'default') count++;
    return count;
  }

  getSelectedSourceName(): string {
    if (this.selectedSourceId === 'all') return 'All Sources';
    const s = this.memory.Sources.get(this.selectedSourceId);
    return s?.name || `Source ${this.selectedSourceId}`;
  }

  getSelectedCategoryName(): string {
    if (this.selectedCategoryId == null) return 'All Categories';
    const cat = this.availableCategories.find((c) => c.id === this.selectedCategoryId);
    return cat?.name || this.getActiveCategoryName() || 'Selected Category';
  }

  getSelectedSortLabel(): string {
    switch (this.selectedSort) {
      case 'title-asc':
        return 'Title: A–Z';
      case 'title-desc':
        return 'Title: Z–A';
      case 'year-desc':
        return 'Year: Newest';
      case 'year-asc':
        return 'Year: Oldest';
      case 'default':
      default:
        return 'Default';
    }
  }

  toggleFilterMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.isFilterMenuOpen = !this.isFilterMenuOpen;
    if (this.isFilterMenuOpen && this.availableCategories.length === 0) {
      this.loadAvailableCategories();
    }
  }

  closeFilterMenu(): void {
    this.isFilterMenuOpen = false;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.isFilterMenuOpen && this.filterSortWrapper?.nativeElement) {
      if (!this.filterSortWrapper.nativeElement.contains(event.target)) {
        this.isFilterMenuOpen = false;
      }
    }
    if (this.isFolderFilterMenuOpen && this.liveFolderFilterWrapper?.nativeElement) {
      if (!this.liveFolderFilterWrapper.nativeElement.contains(event.target)) {
        this.isFolderFilterMenuOpen = false;
      }
    }
  }

  private saveTabFilterState(): void {
    const tab = this.memory.activeNavTab.value;
    if (tab === NavTab.LiveTV || tab === NavTab.Movies || tab === NavTab.TVShows) {
      this.tabFilterStates.set(tab, {
        sourceId: this.selectedSourceId,
        categoryId: this.selectedCategoryId,
        sort: this.selectedSort,
      });
    }
  }

  async loadAvailableCategories(forceReload = false): Promise<void> {
    const tab = this.memory.activeNavTab.value;
    if (tab !== NavTab.LiveTV && tab !== NavTab.Movies && tab !== NavTab.TVShows) {
      this.availableCategories = [];
      this.updateDisplayedLiveCategories();
      return;
    }

    let mediaTypes: MediaType[] = [];
    if (tab === NavTab.LiveTV) mediaTypes = [MediaType.livestream];
    else if (tab === NavTab.Movies) mediaTypes = [MediaType.movie];
    else if (tab === NavTab.TVShows) mediaTypes = [MediaType.serie];

    const sourceIds = this.selectedSourceId === 'all'
      ? Array.from(this.memory.Sources.keys())
      : [this.selectedSourceId];

    if (sourceIds.length === 0) {
      this.availableCategories = [];
      this.updateDisplayedLiveCategories();
      return;
    }

    const cacheKey = `${tab}_${sourceIds.slice().sort().join(',')}`;
    if (!forceReload && this.categoryCache.has(cacheKey)) {
      this.availableCategories = this.categoryCache.get(cacheKey)!;
      this.updateDisplayedLiveCategories();
      return;
    }

    if (this.categoryLoadingInFlight.has(cacheKey)) {
      return;
    }
    this.categoryLoadingInFlight.add(cacheKey);

    this.categoryLoading = true;
    try {
      const collected: CategoryOption[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        if (this.memory.activeNavTab.value !== tab) {
          break;
        }

        const catFilters: Filters = {
          source_ids: sourceIds,
          media_types: mediaTypes,
          view_type: ViewMode.Categories,
          page,
          use_keywords: false,
          sort: SortType.provider,
        };
        const groups = (await invoke('search', { filters: catFilters })) as Channel[];
        if (groups && groups.length > 0) {
          for (const g of groups) {
            if (g.media_type === MediaType.group && g.id != null && g.name) {
              const clean = cleanMediaTitle(g.name);
              collected.push({
                id: g.id,
                name: g.name,
                cleanName: clean,
                cleanNameLower: (clean || g.name).toLowerCase(),
                sourceId: g.source_id ?? 0,
                sourceName: g.source_id ? this.memory.Sources.get(g.source_id)?.name : undefined,
                channelCount: g.stream_id ?? 0,
              });
            }
          }

          if (page === 1 && collected.length > 0 && this.memory.activeNavTab.value === tab) {
            this.availableCategories = [...collected];
            this.updateDisplayedLiveCategories();
            this.categoryLoading = false;
            this.cdr.markForCheck();
          }

          if (groups.length < this.PAGE_SIZE) {
            hasMore = false;
          } else {
            page++;
            if (page > 30) hasMore = false;
            else {
              await new Promise((r) => setTimeout(r, 60));
            }
          }
        } else {
          hasMore = false;
        }
      }
      this.categoryCache.set(cacheKey, collected);
      if (this.memory.activeNavTab.value === tab) {
        this.availableCategories = collected;
        this.updateDisplayedLiveCategories();
      }
    } catch (e) {
      console.error('Failed to load categories:', e);
    } finally {
      this.categoryLoadingInFlight.delete(cacheKey);
      this.categoryLoading = false;
      this.cdr.markForCheck();
    }
  }

  preloadLiveCategories(): void {
    const sourceIds = Array.from(this.memory.Sources.keys());
    if (sourceIds.length === 0) return;
    const cacheKey = `${NavTab.LiveTV}_${sourceIds.slice().sort().join(',')}`;
    if (this.categoryCache.has(cacheKey) || this.categoryLoadingInFlight.has(cacheKey)) {
      return;
    }
    this.categoryLoadingInFlight.add(cacheKey);

    (async () => {
      try {
        const collected: CategoryOption[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          const catFilters: Filters = {
            source_ids: sourceIds,
            media_types: [MediaType.livestream],
            view_type: ViewMode.Categories,
            page,
            use_keywords: false,
            sort: SortType.provider,
          };
          const groups = (await invoke('search', { filters: catFilters })) as Channel[];
          if (groups && groups.length > 0) {
            for (const g of groups) {
              if (g.media_type === MediaType.group && g.id != null && g.name) {
                const clean = cleanMediaTitle(g.name);
                collected.push({
                  id: g.id,
                  name: g.name,
                  cleanName: clean,
                  cleanNameLower: (clean || g.name).toLowerCase(),
                  sourceId: g.source_id ?? 0,
                  sourceName: g.source_id ? this.memory.Sources.get(g.source_id)?.name : undefined,
                  channelCount: g.stream_id ?? 0,
                });
              }
            }
            if (groups.length < this.PAGE_SIZE) {
              hasMore = false;
            } else {
              page++;
              if (page > 30) hasMore = false;
              else {
                await new Promise((r) => setTimeout(r, 60));
              }
            }
          } else {
            hasMore = false;
          }
        }
        this.categoryCache.set(cacheKey, collected);
        if (this.memory.activeNavTab.value === NavTab.LiveTV && this.availableCategories.length === 0) {
          this.availableCategories = collected;
          this.updateDisplayedLiveCategories();
          this.cdr.markForCheck();
        }
      } catch (err) {
        console.error('Failed to preload live categories:', err);
      } finally {
        this.categoryLoadingInFlight.delete(cacheKey);
      }
    })();
  }

  applySortToChannels(channels: Channel[]): Channel[] {
    if (!channels || channels.length <= 1) return channels;
    const copy = [...channels];
    switch (this.selectedSort) {
      case 'title-asc':
        return copy.sort((a, b) => {
          const nameA = cleanMediaTitle(a.name || '').toLowerCase();
          const nameB = cleanMediaTitle(b.name || '').toLowerCase();
          return nameA.localeCompare(nameB, undefined, { numeric: true });
        });
      case 'title-desc':
        return copy.sort((a, b) => {
          const nameA = cleanMediaTitle(a.name || '').toLowerCase();
          const nameB = cleanMediaTitle(b.name || '').toLowerCase();
          return nameB.localeCompare(nameA, undefined, { numeric: true });
        });
      case 'year-desc': {
        const withYear: { ch: Channel; yr: number }[] = [];
        const withoutYear: Channel[] = [];
        for (const ch of copy) {
          const y = extractYear(ch.name);
          const yr = y ? parseInt(y, 10) : NaN;
          if (!isNaN(yr) && yr > 1900 && yr < 2100) {
            withYear.push({ ch, yr });
          } else {
            withoutYear.push(ch);
          }
        }
        withYear.sort((a, b) => b.yr - a.yr || cleanMediaTitle(a.ch.name || '').localeCompare(cleanMediaTitle(b.ch.name || '')));
        return [...withYear.map((w) => w.ch), ...withoutYear];
      }
      case 'year-asc': {
        const withYear: { ch: Channel; yr: number }[] = [];
        const withoutYear: Channel[] = [];
        for (const ch of copy) {
          const y = extractYear(ch.name);
          const yr = y ? parseInt(y, 10) : NaN;
          if (!isNaN(yr) && yr > 1900 && yr < 2100) {
            withYear.push({ ch, yr });
          } else {
            withoutYear.push(ch);
          }
        }
        withYear.sort((a, b) => a.yr - b.yr || cleanMediaTitle(a.ch.name || '').localeCompare(cleanMediaTitle(b.ch.name || '')));
        return [...withYear.map((w) => w.ch), ...withoutYear];
      }
      case 'default':
      default:
        return copy;
    }
  }

  async selectSource(sourceId: number | 'all'): Promise<void> {
    this.selectedSourceId = sourceId;
    if (this.filters) {
      if (sourceId === 'all') {
        this.filters.source_ids = Array.from(this.memory.Sources.keys());
      } else {
        this.filters.source_ids = [sourceId];
      }
      this.filters.page = 1;
    }

    if (this.selectedCategoryId != null && sourceId !== 'all') {
      const selectedCat = this.availableCategories.find((c) => c.id === this.selectedCategoryId);
      if (selectedCat && selectedCat.sourceId !== sourceId) {
        this.selectedCategoryId = undefined;
        if (this.filters) {
          this.filters.group_id = undefined;
        }
        this.nodeStack.clear();
      }
    }

    this.saveTabFilterState();
    await this.loadAvailableCategories();
    await this.load();
    this.cdr.markForCheck();
  }

  async selectCategory(cat?: CategoryOption): Promise<void> {
    if (!cat) {
      this.selectedCategoryId = undefined;
      if (this.filters) {
        this.filters.group_id = undefined;
        this.filters.page = 1;
      }
      this.nodeStack.clear();
    } else {
      this.selectedCategoryId = cat.id;
      if (this.filters) {
        this.filters.group_id = cat.id;
        this.filters.view_type = ViewMode.Categories;
        this.filters.page = 1;
      }
      this.nodeStack.clear();
      this.nodeStack.add(
        new Node(
          cat.id,
          cat.name,
          NodeType.Category,
          this.filters?.query,
          ViewMode.Categories,
          this.filters?.media_types ? [...this.filters.media_types] : undefined,
          0,
        ),
      );
    }
    this.saveTabFilterState();
    await this.load();
    this.cdr.markForCheck();
  }

  async selectSort(sort: SortOption): Promise<void> {
    this.selectedSort = sort;
    if (this.filters) {
      if (sort === 'title-asc') {
        this.filters.sort = SortType.alphabeticalAscending;
      } else if (sort === 'title-desc') {
        this.filters.sort = SortType.alphabeticalDescending;
      } else {
        this.filters.sort = SortType.provider;
      }
      this.filters.page = 1;
    }
    this.saveTabFilterState();
    if (this.isSearching) {
      this.applySearchSortAndFilter();
    } else {
      await this.load();
    }
    this.cdr.markForCheck();
  }

  async resetFilters(): Promise<void> {
    this.selectedSourceId = 'all';
    this.selectedCategoryId = undefined;
    this.selectedSort = 'default';
    this.categorySearchTerm = '';
    if (this.filters) {
      this.filters.source_ids = Array.from(this.memory.Sources.keys());
      this.filters.group_id = undefined;
      this.filters.sort = SortType.provider;
      this.filters.page = 1;
    }
    this.nodeStack.clear();
    this.saveTabFilterState();
    await this.loadAvailableCategories();
    await this.load();
    this.cdr.markForCheck();
  }

  scrollToTop() {
    if (this.isLiveTvTab && this.liveTvContent?.nativeElement) {
      this.liveTvContent.nativeElement.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async playMedia(channel: Channel) {
    if (channel.media_type === MediaType.serie) {
      this.saveOriginatingScrollPosition();
      await this.openSeries(channel);
      return;
    }
    if (channel.media_type === MediaType.movie) {
      this.saveOriginatingScrollPosition();
      this.movieDetailService.openMovieDetail(channel);
      return;
    }
    const isLive = channel.media_type === MediaType.livestream;
    const playChannel: Channel = {
      ...channel,
      media_type: channel.media_type,
      favorite: !!channel.favorite,
    };
    if (isLive) {
      this.livePlayingChannel = channel;
      invoke("add_last_watched", { id: channel.id }).catch(console.error);
      if (this.embeddedPlayer.isPlayingEmbedded) {
        await this.embeddedPlayer.switchChannel(playChannel, cleanMediaTitle(channel.name || 'Live TV'));
        return;
      }
      try {
        await this.embeddedPlayer.startPlayer(playChannel, 'home-video-canvas', {
          title: cleanMediaTitle(channel.name || 'Live TV'),
          mode: 'live',
          currentGroupId: channel.group_id ?? this.filters?.group_id,
          channels: this.channels.map((c) => ({
            id: c.id!,
            name: cleanMediaTitle(c.name || ''),
            logo: c.image,
            group_id: c.group_id,
            channel: c,
          })),
          onSwitchChannel: (ch) => this.onSwitchChannel(ch),
        });
        return;
      } catch (err) {
        console.warn('Failed to start embedded live player:', err);
        this.livePlayingChannel = undefined;
        this.error.handleError(err);
      }
      return;
    }

    try {
      invoke("add_last_watched", { id: channel.id }).catch(console.error);
      const savedPos = this.embeddedPlayer.getSavedPosition(channel.id, channel);
      await this.embeddedPlayer.startPlayer(playChannel, 'home-video-canvas', {
        title: cleanMediaTitle(channel.name || 'Video'),
        mode: 'movie',
        startTime: savedPos,
      });
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async resumeMedia(channel: Channel): Promise<void> {
    if (!channel || channel.id == null) return;
    const isTv =
      channel.media_type === MediaType.serie ||
      channel.season_id != null ||
      channel.series_id != null ||
      channel.episode_num != null ||
      /\b(?:s\d{1,2}\s*e\d{1,2}|season\s*\d+|\b\d{1,2}x\d{1,2}\b)/i.test(channel.name || "");

    const playChannel: Channel = {
      ...channel,
      media_type: isTv ? MediaType.serie : (channel.media_type || MediaType.movie),
      favorite: !!channel.favorite,
    };

    const seriesTitle = isTv ? (this.embeddedPlayer.extractSeriesTitle(channel) || sanitizeShowTitle(channel.name)) : undefined;
    const seasonNum = isTv ? this.embeddedPlayer.extractSeasonNumber(channel) : undefined;
    const epNum = isTv ? this.embeddedPlayer.extractEpisodeNumber(channel.name) : undefined;
    const title = isTv
      ? formatPlayerEpisodeLabel(seriesTitle, channel.name, epNum, seasonNum).full
      : cleanMediaTitle(channel.name || 'Movie');

    invoke("add_last_watched", { id: channel.id }).catch(console.error);

    const savedPos = this.embeddedPlayer.getSavedPosition(channel.id, channel);

    try {
      await this.embeddedPlayer.startPlayer(playChannel, 'home-video-canvas', {
        title,
        mode: isTv ? 'episode' : 'movie',
        startTime: savedPos,
        currentSeasonNum: seasonNum,
        seriesTitle: seriesTitle || undefined,
      });
    } catch (e) {
      console.error('Failed to resume media:', e);
      this.error.handleError(e);
    }
  }

  async onSwitchChannel(channel: Channel): Promise<void> {
    this.livePlayingChannel = channel;
    if (channel.id) {
      invoke("add_last_watched", { id: channel.id }).catch(console.error);
    }
    if (!this.embeddedPlayer.isPlayingEmbedded) {
      this.playMedia(channel);
    }
  }

  onChannelSwitcherClose(): void {
    // No-op, panel closes itself
  }

  async openSeries(channel: Channel) {
    this.saveOriginatingScrollPosition();
    this.tvDetailService.openTvDetail(channel);
  }

  navigateToTab(tab: NavTab) {
    this.memory.activeNavTab.next(tab);
    if (tab === NavTab.Profile) {
      this.router.navigateByUrl("profile");
    } else if (tab === NavTab.Settings) {
      this.router.navigateByUrl("settings");
    } else {
      this.handleNavTabClick(tab);
    }
  }

  constructor(
    private router: Router,
    public memory: MemoryService,
    public toast: ToastrService,
    private error: ErrorService,
    private tvDetailService: TvDetailService,
    private movieDetailService: MovieDetailService,
    public pinService: PinService,
    public embeddedPlayer: EmbeddedPlayerService,
    private searchStateService: SearchStateService,
    private versionMatching: VersionMatchingService,
    private ambientBackground: AmbientBackgroundService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
  ) {
    const savedFolderSort = localStorage.getItem('lighthouse_live_folder_sort') as LiveFolderSort;
    if (savedFolderSort && ['default', 'name-asc', 'name-desc', 'count-desc', 'count-asc'].includes(savedFolderSort)) {
      this.liveFolderSort = savedFolderSort;
    }
    if (this.memory.activeNavTab.value === NavTab.LiveTV) {
      this.liveSidebarSelection = { type: 'favorites' };
    }
    this.getSources();
    this.updatePinnedItems();
  }

  updatePinnedItems(): void {
    const tab = this.memory.activeNavTab.value;
    if (tab !== NavTab.LiveTV && tab !== NavTab.Movies && tab !== NavTab.TVShows) {
      this.currentPinnedItems = [];
      this.liveContentPinnedItems = [];
      return;
    }
    if (tab === NavTab.LiveTV && !this.liveSidebarSelection) {
      this.currentPinnedItems = [];
      this.liveContentPinnedItems = [];
      return;
    }
    const groupId = this.filters?.group_id;
    this.currentPinnedItems = this.pinService.getPinnedChannelsForTab(tab, groupId);
    if (tab === NavTab.LiveTV) {
      this.liveContentPinnedItems = this.applySortToChannels(this.currentPinnedItems);
      this.updateRegularChannels(true);
    }
  }

  getSources() {
    let get_settings = invoke("get_settings");
    let get_sources = invoke("get_sources");
    Promise.all([get_settings, get_sources])
      .then((data) => {
        let settings = data[0] as Settings;
        let sources = data[1] as Source[];
        if (settings.zoom) getCurrentWebview().setZoom(Math.trunc(settings.zoom! * 100) / 10000);
        this.memory.trayEnabled = settings.enable_tray_icon ?? true;
        this.memory.AlwaysAskSave = settings.always_ask_save ?? false;
        this.memory.Sources = new Map(sources.filter((x) => x.enabled).map(s => [s.id!, s]));
        if (sources.length == 0) this.reset();
        else {
          sources
            .filter((x) => x.source_type == SourceType.Custom)
            .map((x) => x.id!)
            .forEach((x) => this.memory.CustomSourceIds?.add(x));
          sources
            .filter((x) => x.source_type == SourceType.Xtream)
            .map((x) => x.id!)
            .forEach((x) => this.memory.XtreamSourceIds.add(x));
          if (
            this.memory.XtreamSourceIds.size > 0 &&
            !sessionStorage.getItem("epgCheckedOnStart")
          ) {
            sessionStorage.setItem("epgCheckedOnStart", "true");
            invoke("on_start_check_epg");
          }
          const currentTab = this.memory.activeNavTab.value;
          let initialMediaTypes = [MediaType.livestream, MediaType.movie, MediaType.serie];
          let initialViewType = settings.default_view ?? ViewMode.All;
          if (currentTab === NavTab.LiveTV) {
            initialMediaTypes = [MediaType.livestream];
            this.chkLiveStream = true;
            this.chkMovie = false;
            this.chkSerie = false;
            initialViewType = ViewMode.Favorites;
            this.liveSidebarSelection = { type: 'favorites' };
            this.memory.activeNavTab.next(NavTab.LiveTV);
          } else if (currentTab === NavTab.Movies) {
            initialMediaTypes = [MediaType.movie];
            this.chkLiveStream = false;
            this.chkMovie = true;
            this.chkSerie = false;
            initialViewType = ViewMode.All;
            this.memory.activeNavTab.next(NavTab.Movies);
          } else if (currentTab === NavTab.TVShows) {
            initialMediaTypes = [MediaType.serie];
            this.chkLiveStream = false;
            this.chkMovie = false;
            this.chkSerie = true;
            initialViewType = ViewMode.All;
            this.memory.activeNavTab.next(NavTab.TVShows);
          } else {
            this.chkLiveStream = false;
            this.chkMovie = true;
            this.chkSerie = this.anyXtream();
            this.memory.activeNavTab.next(NavTab.Home);
            initialMediaTypes = [MediaType.movie, MediaType.serie];
            initialViewType = ViewMode.All;
          }

          this.filters = {
            source_ids: Array.from(this.memory.Sources.keys()),
            view_type: initialViewType,
            media_types: initialMediaTypes,
            page: 1,
            use_keywords: false,
            sort: SortType.provider,
          };
          if (settings.default_sort != undefined && settings.default_sort != SortType.provider) {
            this.memory.Sort.next([settings.default_sort, false]);
            this.filters.sort = settings.default_sort;
          }
          if (currentTab !== NavTab.LiveTV && currentTab !== NavTab.Movies && currentTab !== NavTab.TVShows) {
            this.chkSerie = this.anyXtream();
          }

          if (this.nodeStack.hasNodes()) {
            const topNode = this.nodeStack.get();
            if (topNode) {
              if (topNode.type === NodeType.Category) {
                this.filters.group_id = topNode.id;
                this.filters.view_type = ViewMode.Categories;
              } else if (topNode.type === NodeType.Series) {
                this.filters.series_id = topNode.id;
              } else if (topNode.type === NodeType.Season) {
                this.filters.season = topNode.id;
              }
            }
          }

          if (this.pendingTabClick !== undefined) {
            const tab = this.pendingTabClick;
            this.pendingTabClick = undefined;
            this.handleNavTabClick(tab);
            return;
          }

          const savedSearch = this.searchStateService.getSearchState(currentTab);
          if (savedSearch && savedSearch.query && savedSearch.query.trim().length > 0) {
            this.filters.query = savedSearch.query;
            this.searchKeyword = savedSearch.searchKeyword;
            this.rawSearchResults = savedSearch.rawSearchResults;
            this.searchResults = savedSearch.searchResults;
            this.searchTypeFilter = savedSearch.searchTypeFilter;
            this.searchSortBy = savedSearch.searchSortBy;
            this.searchSortOrder = savedSearch.searchSortOrder;
            this.isSearchExpanded = savedSearch.isSearchExpanded;
            this.prevSearchValue = savedSearch.query;
            this.channelsVisible = true;
            if (this.search?.nativeElement) {
              this.search.nativeElement.value = savedSearch.query;
            }
            const targetSearchScroll = this.memory.searchScrollPositions.get(currentTab) ?? savedSearch.scrollPosition;
            if (targetSearchScroll && targetSearchScroll > 0) {
              this.restoreScrollPosition(targetSearchScroll);
            }
            const targetHorizontalScrolls =
              this.memory.searchHorizontalScrollPositions.get(currentTab) ??
              savedSearch.horizontalScrollPositions;
            if (targetHorizontalScrolls) {
              this.searchHorizontalScrollPositions = { ...targetHorizontalScrolls };
              this.restoreHorizontalScrollPositions(targetHorizontalScrolls);
            }
            return;
          }

          if (settings.refresh_on_start === true && !sessionStorage.getItem("refreshedOnStart")) {
            sessionStorage.setItem("refreshedOnStart", "true");
            this.refreshOnStart().then((_) => _);
          }
          if (this.isHomeDiscoveryMode) {
            const savedHomeScroll = this.memory.homeDiscoveryScrollPosition;
            if (savedHomeScroll && savedHomeScroll > 0) {
              this.restoreScrollPosition(savedHomeScroll);
            }
            return;
          }
          this.load().then(async () => {
            if (this.filters?.view_type === ViewMode.Categories && !this.filters?.group_id) {
              const savedCatScroll = this.memory.categoryScrollPositions.get(currentTab);
              if (savedCatScroll && savedCatScroll > 0) {
                await this.restoreScrollPosition(savedCatScroll);
              }
            } else if (this.filters?.group_id) {
              const key = `${currentTab}_${this.filters.group_id}`;
              const savedFolderScroll = this.memory.folderScrollPositions.get(key);
              if (savedFolderScroll && savedFolderScroll > 0) {
                await this.restoreScrollPosition(savedFolderScroll);
              }
            } else if (this.isHomeDiscoveryMode) {
              const savedHomeScroll = this.memory.homeDiscoveryScrollPosition;
              if (savedHomeScroll && savedHomeScroll > 0) {
                await this.restoreScrollPosition(savedHomeScroll);
              }
            } else if (this.filters?.view_type === ViewMode.All || !this.filters?.group_id) {
              const savedAllScroll = this.memory.allScrollPositions.get(currentTab);
              if (savedAllScroll && savedAllScroll > 0) {
                await this.restoreScrollPosition(savedAllScroll);
              }
            }
            if (this.isCatalogTab) {
              this.loadAvailableCategories();
            } else {
              setTimeout(() => this.preloadLiveCategories(), 400);
            }
          });
        }
      })
      .catch((e) => {
        this.error.handleError(e);
        this.reset();
      });
  }

  async refreshOnStart() {
    this.toast.info("Refreshing all sources... (refresh on start enabled)");
    await this.memory.tryIPC(
      "Successfully refreshed all sources (refresh on start enabled)",
      "Failed to refresh all sources (refresh on start enabled)",
      async () => {
        await invoke("refresh_all");
      },
    );
  }

  async reload() {
    await this.load();
  }

  reset() {
    this.router.navigateByUrl("setup");
  }

  async addEvents() {
    this.subscriptions.push(
      this.memory.HideChannels.subscribe((val) => {
        this.channelsVisible = val;
      }),
    );
    this.subscriptions.push(
      this.memory.SetFocus.subscribe((focus) => {
        this.focus = focus;
      }),
    );
    this.subscriptions.push(
      this.memory.SetNode.subscribe(async (dto) => {
        const currentTab = this.memory.activeNavTab.value;
        const currentScroll = window.scrollY || document.documentElement.scrollTop || window.pageYOffset || 0;
        if (dto.type == NodeType.Category) {
          this.memory.categoryScrollPositions.set(currentTab, currentScroll);
        }
        this.nodeStack.add(
          new Node(
            dto.id,
            dto.name,
            dto.type,
            this.filters?.query,
            this.filters?.view_type,
            this.filters?.media_types ? [...this.filters.media_types] : undefined,
            currentScroll,
          ),
        );
        if (dto.type == NodeType.Category) {
          this.filters!.group_id = dto.id;
          this.selectedCategoryId = dto.id;
          this.saveTabFilterState();
          if (currentTab === NavTab.LiveTV) {
            this.filters!.media_types = [MediaType.livestream];
            this.liveSidebarSelection = {
              type: 'category',
              id: dto.id,
              name: dto.name,
              sourceId: dto.sourceId,
            };
          } else if (currentTab === NavTab.Movies) {
            this.filters!.media_types = [MediaType.movie];
          } else if (currentTab === NavTab.TVShows) {
            this.filters!.media_types = [MediaType.serie];
          } else {
            this.filters!.media_types = [MediaType.livestream, MediaType.movie, MediaType.serie];
          }
          this.filters!.view_type = ViewMode.Categories;
        } else if (dto.type == NodeType.Series) {
          this.filters!.series_id = dto.id;
          this.filters!.source_ids = [dto.sourceId!];
        } else if (dto.type == NodeType.Season) this.filters!.season = dto.id;

        if (this.filters!.view_type == ViewMode.Hidden) {
          this.filters!.view_type = ViewMode.Categories;
        }

        this.clearSearch();
        await this.load();
        window.scrollTo({ top: 0, behavior: "instant" });
        if (this.focusArea == FocusArea.Tiles) this.selectFirstChannelDelayed(100);
      }),
    );
    this.subscriptions.push(
      this.memory.Refresh.subscribe((scroll) => {
        this.memory.clearCatalogPageCache();
        this.load();
        if(scroll)
          window.scrollTo({ top: 0, behavior: "instant" });
      }),
    );
    this.subscriptions.push(
      this.memory.RefreshSources.subscribe(() => {
        this.memory.clearCatalogPageCache();
      }),
    );
    this.subscriptions.push(
      this.memory.Sort.pipe(skip(1)).subscribe(async ([sort, load]) => {
        if (!this.filters || !load) return;
        this.filters!.sort = sort;
        await this.load();
      }),
    );
    this.subscriptions.push(
      this.memory.navTabClick.subscribe((tab: NavTab) => {
        this.handleNavTabClick(tab);
      }),
    );
    this.subscriptions.push(
      this.pinService.pinnedItems$.subscribe(() => {
        this.updatePinnedItems();
        this.updateDisplayedLiveCategories();
      }),
    );
    this.subscriptions.push(
      this.memory.activeNavTab.subscribe((tab) => {
        this.updatePinnedItems();
        if (tab !== NavTab.Home) {
          this.ambientBackground.resetToDefault('non-home-tab');
        } else {
          this.ambientBackground.restoreHomeHero();
        }
      }),
    );
  }

  clearSearch() {
    this.searchRequestId++;
    if (this.search?.nativeElement) {
      this.search.nativeElement.value = "";
    }
    if (this.liveSearchInput?.nativeElement) {
      this.liveSearchInput.nativeElement.value = "";
    }
    this.prevSearchValue = "";
    if (this.filters) {
      this.filters.query = "";
    }
    this.rawSearchResults = { channels: [], movies: [], tvShows: [], categories: [] };
    this.searchResults = { channels: [], movies: [], tvShows: [], categories: [] };
    this.searchKeyword = "";
    this.searchStateService.clearSearchState(this.memory.activeNavTab.value);
    this.memory.searchScrollPositions.delete(this.memory.activeNavTab.value);
    this.memory.searchHorizontalScrollPositions.delete(this.memory.activeNavTab.value);
    this.searchHorizontalScrollPositions = {};
  }

  async loadMore() {
    if (this.isSearching) return;
    this.load(true);
  }

  private dedupeChannels(channels: Channel[]): Channel[] {
    const seenIds = new Set<number>();
    const seenNames = new Set<string>();
    const result: Channel[] = [];
    for (const ch of channels) {
      if (ch.id != null) {
        if (seenIds.has(ch.id)) continue;
        seenIds.add(ch.id);
      }
      const key = `${ch.media_type}_${ch.source_id}_${ch.name?.trim().toLowerCase()}`;
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      result.push(ch);
    }
    return result;
  }

  /**
   * Keep one search card for each movie or series title. The selected card is
   * still a provider item, so the existing details screen can load every
   * matching provider version through VersionMatchingService.
   */
  private dedupeMediaSearchResults(channels: Channel[]): Channel[] {
    const uniqueChannels: Channel[] = [];

    for (const channel of channels) {
      if (
        uniqueChannels.some((existing) =>
          this.versionMatching.hasSameStrictTitleIdentity(existing, channel),
        )
      ) {
        continue;
      }
      uniqueChannels.push(channel);
    }

    return uniqueChannels;
  }

  async performUniversalSearch(rawQuery: string): Promise<void> {
    const query = rawQuery.trim();
    this.searchKeyword = query;
    if (!query) {
      this.rawSearchResults = { channels: [], movies: [], tvShows: [], categories: [] };
      this.searchResults = { channels: [], movies: [], tvShows: [], categories: [] };
      this.searchHorizontalScrollPositions = {};
      this.memory.searchHorizontalScrollPositions.delete(this.memory.activeNavTab.value);
      this.searchStateService.clearSearchState(this.memory.activeNavTab.value);
      return;
    }

    const currentTab = this.memory.activeNavTab.value;
    const searchId = ++this.searchRequestId;
    this.searchHorizontalScrollPositions = {};

    const sourceIds = this.filters?.source_ids?.length
      ? this.filters.source_ids
      : Array.from(this.memory.Sources.keys());

    if (sourceIds.length === 0) {
      this.rawSearchResults = { channels: [], movies: [], tvShows: [], categories: [] };
      this.searchResults = { channels: [], movies: [], tvShows: [], categories: [] };
      this.searchStateService.clearSearchState(currentTab);
      return;
    }

    // Sanitize query by removing punctuation/separators
    const sanitized = query
      .replace(/[-_.:|/\\,[\]()!?+*~#@$%^&=<>'"]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const searchTerm = sanitized || query;
    const words = searchTerm.split(" ").filter((w) => w.length > 0);

    // Build query variants for high recall:
    // 1. Full cleaned term (e.g. "Sky News", "UK Sports", "The Gentlemen")
    // 2. Term without leading article ("The Gentlemen" -> "Gentlemen")
    // 3. Term with unpluralized words ("UK Sports" -> "UK Sport")
    const queryVariants: string[] = [searchTerm];

    if (words.length > 1) {
      const firstLower = words[0].toLowerCase();
      if (["the", "a", "an"].includes(firstLower)) {
        const withoutArticle = words.slice(1).join(" ");
        if (withoutArticle && !queryVariants.includes(withoutArticle)) {
          queryVariants.push(withoutArticle);
        }
      }
    }

    const nonPlurals = words.map((w) => {
      const lower = w.toLowerCase();
      if (lower.length > 3 && lower.endsWith("s") && !["news", "series", "status"].includes(lower)) {
        return w.slice(0, -1);
      }
      return w;
    });
    const singularVariant = nonPlurals.join(" ");
    if (singularVariant !== searchTerm && !queryVariants.includes(singularVariant)) {
      queryVariants.push(singularVariant);
    }

    const fetchGroup = async (
      mediaTypes: MediaType[],
      viewType: ViewMode = ViewMode.All
    ): Promise<Channel[]> => {
      let list: Channel[] = [];
      for (const variant of queryVariants) {
        try {
          const results: Channel[] = await invoke("search", {
            filters: {
              source_ids: sourceIds,
              view_type: viewType,
              media_types: mediaTypes,
              query: variant,
              use_keywords: true,
              page: 1,
              sort: SortType.alphabeticalAscending,
            },
          });
          if (results && results.length > 0) {
            list = list.concat(results);
          }
        } catch (e) {
          console.error("Universal search error for variant:", variant, e);
        }
      }
      return this.dedupeChannels(list);
    };

    let fetchChannelsPromise: Promise<Channel[]> = Promise.resolve([]);
    let fetchMoviesPromise: Promise<Channel[]> = Promise.resolve([]);
    let fetchTvShowsPromise: Promise<Channel[]> = Promise.resolve([]);
    let fetchCategoriesPromise: Promise<Channel[]> = Promise.resolve([]);

    if (currentTab === NavTab.LiveTV) {
      // 1. LIVE TV TAB: Show ONLY Live TV channel results and Live TV folder/category results.
      fetchChannelsPromise = fetchGroup([MediaType.livestream]);
      fetchCategoriesPromise = fetchGroup([MediaType.livestream], ViewMode.Categories);
    } else if (currentTab === NavTab.Movies) {
      // 2. MOVIES TAB: Show ONLY Movie results and Movie folder/category results.
      fetchMoviesPromise = fetchGroup([MediaType.movie]);
      fetchCategoriesPromise = fetchGroup([MediaType.movie], ViewMode.Categories);
    } else if (currentTab === NavTab.TVShows) {
      // 3. TV SHOWS TAB: Show ONLY TV Show results and TV Show folder/category results.
      fetchTvShowsPromise = fetchGroup([MediaType.serie]);
      fetchCategoriesPromise = fetchGroup([MediaType.serie], ViewMode.Categories);
    } else {
      // 4. HOME TAB: Universal search showing Movies, TV Shows, Channels, and all categories.
      fetchChannelsPromise = fetchGroup([MediaType.livestream]);
      fetchMoviesPromise = fetchGroup([MediaType.movie]);
      fetchTvShowsPromise = fetchGroup([MediaType.serie]);
      fetchCategoriesPromise = fetchGroup(
        [MediaType.livestream, MediaType.movie, MediaType.serie],
        ViewMode.Categories
      );
    }

    const [channels, movieResults, tvShowResults, categories] = await Promise.all([
      fetchChannelsPromise,
      fetchMoviesPromise,
      fetchTvShowsPromise,
      fetchCategoriesPromise,
    ]);

    if (searchId !== this.searchRequestId || currentTab !== this.memory.activeNavTab.value) {
      return;
    }

    const actualMovies = movieResults.filter((m) => !isEpisodicOrTvContent(m));

    this.rawSearchResults = {
      channels,
      movies: this.dedupeMediaSearchResults(actualMovies),
      tvShows: this.dedupeMediaSearchResults(tvShowResults),
      categories,
    };
    this.applySearchSortAndFilter();
    this.channelsVisible = true;
    this.saveCurrentTabSearchState();
  }

  async load(more = false) {
    const requestId = ++this.catalogLoadRequestId;
    this.loading = true;
    if (this.isSearching) {
      await this.performUniversalSearch(this.filters!.query!);
      if (requestId === this.catalogLoadRequestId) this.loading = false;
      return;
    }

    if (this.isLiveTvTab && !this.liveSidebarSelection) {
      this.channels = [];
      this.reachedMax = true;
      if (requestId === this.catalogLoadRequestId) this.loading = false;
      this.updatePinnedItems();
      this.channelsVisible = true;
      this.cdr.markForCheck();
      return;
    }

    if (more) {
      this.filters!.page++;
    } else {
      this.filters!.page = 1;
    }

    const filters: Filters = {
      ...this.filters!,
      source_ids: [...this.filters!.source_ids],
      media_types: [...this.filters!.media_types],
    };
    const cacheKey =
      !more && (filters.view_type === ViewMode.All || filters.view_type === ViewMode.Favorites)
        ? JSON.stringify({
            ...filters,
            source_ids: [...filters.source_ids].sort((a, b) => a - b),
            media_types: [...filters.media_types].sort((a, b) => a - b),
          })
        : undefined;
    const cached = cacheKey ? this.memory.getCatalogPage(cacheKey) : undefined;
    if (cached) {
      this.channels = cached.channels;
      this.reachedMax = cached.reachedMax;
      this.channelsVisible = true;
      this.viewType = filters.view_type;
      this.loading = false;
      this.updatePinnedItems();
      this.updateRegularChannels(false);
      this.cdr.markForCheck();
      return;
    }

    try {
      const channels: Channel[] = await invoke("search", { filters });
      if (requestId !== this.catalogLoadRequestId) return;
      const sanitized = filters.media_types?.includes(MediaType.movie) && !filters.media_types?.includes(MediaType.serie)
        ? channels.filter((c) => !isEpisodicOrTvContent(c))
        : channels;
      if (!more) {
        this.channels = sanitized;
        this.channelsVisible = true;
        // prevent flicker of hiding opacity
        this.viewType = filters.view_type;
      } else {
        this.channels = this.channels.concat(sanitized);
      }
      this.reachedMax = channels.length < this.PAGE_SIZE;
      if (cacheKey) {
        this.memory.setCatalogPage(cacheKey, this.channels, this.reachedMax);
      }
    } catch (e) {
      if (requestId === this.catalogLoadRequestId) this.error.handleError(e);
    } finally {
      if (requestId === this.catalogLoadRequestId) {
        this.updatePinnedItems();
        this.updateRegularChannels(more);
        this.loading = false;
        this.cdr.markForCheck();
      }
    }
  }

  checkScrollTop() {
    const scrollPosition =
      window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    this.showScrollTop = scrollPosition > 300;
  }

  async checkScrollEnd() {
    if (this.reachedMax === true || this.loading === true) return;
    const scrollHeight = document.documentElement.scrollHeight;
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const clientHeight = window.innerHeight || document.documentElement.clientHeight;
    if (scrollTop + clientHeight >= scrollHeight * 0.75) {
      await this.loadMore();
    }
  }

  @HostListener("window:scroll", ["$event"])
  async scroll(event: any) {
    this.checkScrollTop();
    const y = window.scrollY || document.documentElement.scrollTop || window.pageYOffset || 0;
    this.currentScrollPosition = y;
    await this.checkScrollEnd();
  }

  ngAfterViewInit(): void {
    if (this.search?.nativeElement && this.filters?.query) {
      this.search.nativeElement.value = this.filters.query;
      this.prevSearchValue = this.filters.query;
    }
    this.addEvents().then((_) => _);
    this.subscriptions.push(
      fromEvent(this.search.nativeElement, "keyup")
        .pipe(
          filter((event: any) => event.key !== "Escape"),
          map((event: any) => {
            this.focus = 0;
            this.focusArea = FocusArea.Tiles;
            if (this.channelsVisible && event.target.value != this.prevSearchValue)
              this.channelsVisible = false;
            this.prevSearchValue = event.target.value;
            return event.target.value;
          }),
          debounceTime(300),
        )
        .subscribe(async (term: string) => {
          const currentInput = this.search?.nativeElement?.value ?? "";
          if (currentInput !== term) {
            return;
          }
          this.filters!.query = term;
          await this.load();
        }),
    );

    this.shortcuts.push(
      {
        key: ["ctrl + f", "ctrl + k", "cmd + f", "cmd + k", "ctrl + space"],
        label: "Search",
        description: "Go to search",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: (_) => this.focusSearch(),
      },
      {
        key: ["ctrl + a", "cmd + a"],
        label: "Switching modes",
        description: "Selects the all channels view",
        preventDefault: true,
        command: async (_) => await this.switchMode(this.viewModeEnum.All),
      },
      {
        key: ["ctrl + s", "cmd + s"],
        label: "Switching modes",
        description: "Selects the categories view",
        command: async (_) => await this.switchMode(this.viewModeEnum.Categories),
      },
      {
        key: ["ctrl + d", "cmd + d"],
        label: "Switching modes",
        description: "Selects the history view",
        command: async (_) => await this.switchMode(this.viewModeEnum.History),
      },
      {
        key: ["ctrl + r", "cmd + r"],
        label: "Switching modes",
        description: "Selects the favorites view",
        command: async (_) => await this.switchMode(this.viewModeEnum.Favorites),
      },
      {
        key: "ctrl + q",
        label: "Media Type Filters",
        description: "Enable/Disable livestreams",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: async (_) => {
          this.chkLiveStream = !this.chkLiveStream;
          this.updateMediaTypes(MediaType.livestream);
        },
      },
      {
        key: "ctrl + w",
        label: "Media Type Filters",
        description: "Enable/Disable movies",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: async (_) => {
          this.chkMovie = !this.chkMovie;
          this.updateMediaTypes(MediaType.movie);
        },
      },
      {
        key: "ctrl + e",
        label: "Media Type Filters",
        description: "Enable/Disable series",
        preventDefault: true,
        allowIn: [AllowIn.Input],
        command: async (_) => {
          this.chkSerie = !this.chkSerie;
          this.updateMediaTypes(MediaType.serie);
        },
      },
      {
        key: "left",
        label: "Navigation",
        description: "Go left",
        allowIn: [AllowIn.Input],
        command: async (_) => await this.nav("ArrowLeft"),
      },
      {
        key: "right",
        label: "Navigation",
        description: "Go right",
        allowIn: [AllowIn.Input],
        command: async (_) => await this.nav("ArrowRight"),
      },
      {
        key: "up",
        label: "Navigation",
        description: "Go up",
        allowIn: [AllowIn.Input],
        preventDefault: true,
        command: async (_) => await this.nav("ArrowUp"),
      },
      {
        key: "down",
        label: "Navigation",
        description: "Go down",
        allowIn: [AllowIn.Input],
        preventDefault: true,
        command: async (_) => await this.nav("ArrowDown"),
      },
    );
  }

  handleNavTabClick(tab: NavTab) {
    if (!this.filters) {
      this.pendingTabClick = tab;
      return;
    }
    this.isFilterMenuOpen = false;
    this.searchRequestId++;
    this.nodeStack.clear();
    this.memory.categoryScrollPositions.delete(tab);
    this.memory.allScrollPositions.delete(tab);
    this.memory.searchScrollPositions.delete(tab);
    this.memory.searchHorizontalScrollPositions.delete(tab);
    this.searchHorizontalScrollPositions = {};
    this.clearSearch();
    this.isSearchExpanded = false;
    if (this.search?.nativeElement) {
      this.search.nativeElement.blur();
    }
    this.filters.series_id = undefined;
    this.filters.season = undefined;

    const isCatalog = tab === NavTab.LiveTV || tab === NavTab.Movies || tab === NavTab.TVShows;
    if (isCatalog) {
      const savedState = this.tabFilterStates.get(tab);
      if (savedState) {
        this.selectedSourceId = savedState.sourceId;
        this.selectedCategoryId = tab === NavTab.LiveTV ? undefined : savedState.categoryId;
        this.selectedSort = savedState.sort;
      } else {
        this.selectedSourceId = 'all';
        this.selectedCategoryId = undefined;
        this.selectedSort = 'default';
      }
    } else {
      this.selectedSourceId = 'all';
      this.selectedCategoryId = undefined;
      this.selectedSort = 'default';
    }

    if (this.selectedSourceId === 'all') {
      this.filters.source_ids = Array.from(this.memory.Sources.keys());
    } else {
      this.filters.source_ids = [this.selectedSourceId];
    }
    this.filters.group_id = this.selectedCategoryId;
    if (this.selectedSort === 'title-asc') {
      this.filters.sort = SortType.alphabeticalAscending;
    } else if (this.selectedSort === 'title-desc') {
      this.filters.sort = SortType.alphabeticalDescending;
    } else {
      this.filters.sort = SortType.provider;
    }

    switch (tab) {
      case NavTab.LiveTV:
        this.chkLiveStream = true;
        this.chkMovie = false;
        this.chkSerie = false;
        this.filters.media_types = [MediaType.livestream];
        this.liveSidebarSelection = { type: 'favorites' };
        this.filters.view_type = ViewMode.Favorites;
        this.filters.group_id = undefined;
        this.selectedCategoryId = undefined;
        if (this.liveTvContent?.nativeElement) {
          this.liveTvContent.nativeElement.scrollTop = 0;
        }
        break;
      case NavTab.Movies:
        this.chkLiveStream = false;
        this.chkMovie = true;
        this.chkSerie = false;
        this.filters.media_types = [MediaType.movie];
        this.filters.view_type = ViewMode.All;
        break;
      case NavTab.TVShows:
        this.chkLiveStream = false;
        this.chkMovie = false;
        this.chkSerie = true;
        this.filters.media_types = [MediaType.serie];
        this.filters.view_type = ViewMode.All;
        break;
      case NavTab.Home:
      default:
        this.chkLiveStream = false;
        this.chkMovie = true;
        this.chkSerie = this.anyXtream();
        this.filters.media_types = [MediaType.movie, MediaType.serie];
        this.filters.view_type = ViewMode.All;
        break;
    }
    EpgQueueManager.clearQueue();
    if (tab === NavTab.LiveTV) {
      this.load();
      setTimeout(() => {
        if (this.memory.activeNavTab.value === NavTab.LiveTV) {
          this.loadAvailableCategories();
        }
      }, 150);
    } else {
      if (isCatalog) {
        this.loadAvailableCategories();
      }
      if (tab !== NavTab.Home) {
        this.load();
      }
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  syncActiveNavTab() {
    if (this.chkLiveStream && !this.chkMovie && !this.chkSerie) {
      this.memory.activeNavTab.next(NavTab.LiveTV);
    } else if (!this.chkLiveStream && this.chkMovie && !this.chkSerie) {
      this.memory.activeNavTab.next(NavTab.Movies);
    } else if (!this.chkLiveStream && !this.chkMovie && this.chkSerie) {
      this.memory.activeNavTab.next(NavTab.TVShows);
    } else {
      this.memory.activeNavTab.next(NavTab.Home);
    }
  }

  updateMediaTypes(mediaType: MediaType) {
    let index = this.filters!.media_types.indexOf(mediaType);
    if (index == -1) this.filters!.media_types.push(mediaType);
    else this.filters!.media_types.splice(index, 1);
    this.syncActiveNavTab();
    this.load();
  }

  filtersVisible() {
    return !this.filters?.series_id;
  }

  async switchMode(viewMode: ViewMode) {
    if (viewMode == this.filters?.view_type && !this.filters?.group_id && !this.filters?.series_id) return;
    const wasInFolder = !!this.filters?.group_id;
    const currentTab = this.memory.activeNavTab.value;
    this.filters!.series_id = undefined;
    this.filters!.group_id = undefined;
    this.selectedCategoryId = undefined;
    this.saveTabFilterState();
    this.filters!.view_type = viewMode;
    this.filters!.season = undefined;
    this.clearSearch();
    this.nodeStack.clear();
    await this.load();
    if (viewMode === ViewMode.Categories && wasInFolder) {
      const savedCatScroll = this.memory.categoryScrollPositions.get(currentTab);
      if (savedCatScroll && savedCatScroll > 0) {
        await this.restoreScrollPosition(savedCatScroll);
      }
    }
  }

  searchFocused(): boolean {
    return document.activeElement?.id == "search" || document.activeElement?.id == "liveSearchInput";
  }

  focusSearch() {
    if (this.isLiveTvTab && this.liveSearchInput?.nativeElement) {
      this.liveSearchInput.nativeElement.focus();
      return;
    }
    this.isSearchExpanded = true;
    if (this.searchFocused()) {
      this.selectFirstChannel();
      return;
    } else {
      this.focus = 0;
      this.focusArea = FocusArea.Tiles;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => {
      this.search.nativeElement.focus({
        preventScroll: true,
      });
    }, 50);
  }

  async goBackHotkey() {
    if (this.isFilterMenuOpen) {
      this.isFilterMenuOpen = false;
      return;
    }
    if (this.memory.ModalRef) {
      if (
        this.memory.ModalRef.componentInstance.name != "RestreamModalComponent" ||
        !this.memory.ModalRef.componentInstance.started
      )
        this.memory.ModalRef.close("close");
      return;
    } else if (this.memory.currentContextMenu?.menuOpen) {
      this.closeContextMenu();
    } else if (this.searchFocused()) {
      this.selectFirstChannel();
    } else if (this.filters?.query) {
      if (this.filters?.query) {
        this.clearSearch();
        await this.load();
      }
      this.selectFirstChannelDelayed(100);
    } else if (this.nodeStack.hasNodes()) {
      await this.goBack();
      this.focusArea = FocusArea.Tiles;
      this.focus = 0;
      this.selectFirstChannel(true);
    } else {
      this.selectFirstChannel();
    }
  }

  selectFirstChannelDelayed(milliseconds: number) {
    setTimeout(() => this.selectFirstChannel(), milliseconds);
  }

  async goBack() {
    let targetScrollPosition: number | undefined;
    const currentTab = this.memory.activeNavTab.value;
    if (this.nodeStack.hasNodes()) {
      var node = this.nodeStack.pop();
      if (node.type == NodeType.Category) {
        this.memory.folderScrollPositions.delete(`${currentTab}_${node.id}`);
        this.filters!.group_id = undefined;
        this.selectedCategoryId = undefined;
        this.saveTabFilterState();
        targetScrollPosition = node.scrollPosition ?? this.memory.categoryScrollPositions.get(currentTab);
      } else if (node.type == NodeType.Series) {
        this.filters!.series_id = undefined;
        this.filters!.source_ids = Array.from(this.memory.Sources.keys());
        targetScrollPosition = node.scrollPosition;
      } else if (node.type == NodeType.Season) {
        this.filters!.season = undefined;
        targetScrollPosition = node.scrollPosition;
      }
      if (node.fromMediaTypes && node.fromMediaTypes.length > 0) {
        this.filters!.media_types = [...node.fromMediaTypes];
      }
      if (node.query) {
        this.search.nativeElement.value = node.query;
        this.filters!.query = node.query;
      }
      if (node.fromViewType && this.filters!.view_type !== node.fromViewType) {
        this.filters!.view_type = node.fromViewType;
      }
    } else {
      this.filters!.group_id = undefined;
      this.selectedCategoryId = undefined;
      this.saveTabFilterState();
      this.filters!.series_id = undefined;
      this.filters!.season = undefined;
      this.filters!.view_type = ViewMode.Categories;
      targetScrollPosition = this.memory.categoryScrollPositions.get(currentTab);
    }
    await this.load();
    if (targetScrollPosition !== undefined && targetScrollPosition > 0) {
      await this.restoreScrollPosition(targetScrollPosition);
    }
  }

  private async restoreScrollPosition(targetY: number): Promise<void> {
    if (!targetY || targetY <= 0) return;
    this.cdr.detectChanges();
    let safetyCount = 0;
    while (
      !this.reachedMax &&
      targetY > (document.documentElement.scrollHeight - window.innerHeight) &&
      this.channels.length > 0 &&
      safetyCount < 10
    ) {
      safetyCount++;
      await this.load(true);
      this.cdr.detectChanges();
    }

    const tryScroll = () => {
      window.scrollTo({ top: targetY, behavior: "instant" });
      if (document.documentElement) document.documentElement.scrollTop = targetY;
      if (document.body) document.body.scrollTop = targetY;
      const currentY = window.scrollY || document.documentElement.scrollTop || window.pageYOffset || 0;
      this.currentScrollPosition = currentY;
    };

    requestAnimationFrame(() => {
      tryScroll();
      requestAnimationFrame(() => {
        tryScroll();
        setTimeout(() => {
          const currentY = window.scrollY || document.documentElement.scrollTop || window.pageYOffset || 0;
          if (Math.abs(currentY - targetY) > 5) {
            tryScroll();
          }
        }, 60);
        setTimeout(() => {
          const currentY = window.scrollY || document.documentElement.scrollTop || window.pageYOffset || 0;
          if (Math.abs(currentY - targetY) > 5) {
            tryScroll();
          }
        }, 150);
      });
    });
  }

  onSearchKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      this.clearSearch();
      this.search.nativeElement.blur();
      this.isSearchExpanded = false;
      this.load();
    }
  }

  toggleSearchExpand(event?: Event): void {
    if (event) event.stopPropagation();
    this.isSearchExpanded = !this.isSearchExpanded;
    if (this.isSearchExpanded) {
      setTimeout(() => {
        this.search?.nativeElement?.focus();
      }, 50);
    } else {
      this.clearSearch();
      this.search?.nativeElement?.blur();
      this.load();
    }
  }

  expandSearch(event?: Event): void {
    if (!this.isSearchExpanded) {
      this.isSearchExpanded = true;
      setTimeout(() => {
        this.search?.nativeElement?.focus();
      }, 50);
    }
  }

  collapseAndClearSearch(event?: Event): void {
    if (event) event.stopPropagation();
    this.clearSearch();
    this.search?.nativeElement?.blur();
    this.isSearchExpanded = false;
    this.load();
  }

  onSearchBlur(): void {
    if (!this.filters?.query && !this.search?.nativeElement?.value) {
      this.isSearchExpanded = false;
    }
  }

  openSettings() {
    this.router.navigateByUrl("settings");
  }

  async nav(key: string) {
    if (this.searchFocused()) return;
    let lowSize = this.currentWindowSize < 768;
    if (this.memory.currentContextMenu?.menuOpen || this.memory.ModalRef) {
      return;
    }
    let tmpFocus = 0;
    switch (key) {
      case "ArrowUp":
        tmpFocus -= 3;
        break;
      case "ArrowDown":
        tmpFocus += 3;
        break;
      case "ShiftTab":
      case "ArrowLeft":
        tmpFocus -= 1;
        break;
      case "Tab":
      case "ArrowRight":
        tmpFocus += 1;
        break;
    }
    let goOverSize = this.shortFiltersMode() ? 1 : 2;
    if (lowSize && tmpFocus % 3 == 0 && this.focusArea == FocusArea.Tiles) tmpFocus / 3;
    tmpFocus += this.focus;
    if (tmpFocus < 0) {
      this.focusSearch();
      return;
    } else if (
      this.focusArea == FocusArea.Tiles &&
      tmpFocus >= this.filters!.page * 36 &&
      !this.reachedMax
    )
      await this.loadMore();
    else {
      if (tmpFocus >= this.channels.length && this.focusArea == FocusArea.Tiles)
        tmpFocus = (this.channels.length == 0 ? 1 : this.channels.length) - 1;
      this.focus = tmpFocus;
      setTimeout(() => {
        document.getElementById(`${FocusAreaPrefix[this.focusArea]}${this.focus}`)?.focus();
      }, 0);
    }
  }

  shortFiltersMode() {
    return this.filters?.source_ids.findIndex((x) => this.memory.XtreamSourceIds.has(x)) == -1;
  }

  anyXtream() {
    return Array.from(this.memory.Sources.values()).findIndex((x) => x.source_type == SourceType.Xtream) != -1;
  }

  changeFocusArea(down: boolean) {
    let increment = down ? 1 : -1;
    this.focusArea += increment;
    if (this.focusArea == FocusArea.Filters && !this.filtersVisible()) this.focusArea += increment;
    if (this.focusArea < 0) this.focusArea = 0;
    this.applyFocusArea(down);
  }

  applyFocusArea(down: boolean) {
    this.focus = down
      ? 0
      : this.focusArea == FocusArea.Filters
        ? this.shortFiltersMode()
          ? 1
          : 2
        : 4;
    let id = FocusAreaPrefix[this.focusArea] + this.focus;
    document.getElementById(id)?.focus();
  }

  //Temporary solution because the ng-keyboard-shortcuts library doesn't seem to support ESC
  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    if (
      event.key == "Escape" ||
      event.key == "BrowserBack" ||
      (event.key == "Backspace" && !isInputFocused())
    ) {
      this.goBackHotkey();
      event.preventDefault();
    }
    if (event.key == "Tab" && !this.memory.ModalRef) {
      event.preventDefault();
      this.nav(event.shiftKey ? "ShiftTab" : "Tab");
    }
    if (event.key == "Enter" && this.focusArea == FocusArea.Filters)
      (document.activeElement as any).click();
  }

  selectFirstChannel(preventScroll: boolean = false) {
    this.focusArea = FocusArea.Tiles;
    this.focus = 0;
    (document.getElementById("first")?.firstChild as HTMLElement)?.focus({ preventScroll });
  }

  closeContextMenu() {
    if (this.memory.currentContextMenu?.menuOpen) {
      this.memory.currentContextMenu?.closeMenu();
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    this.liveScrollSub?.unsubscribe();
    EpgQueueManager.clearQueue();
    this.saveOriginatingScrollPosition();
    if (this.embeddedPlayer.isPlayingEmbedded) {
      this.embeddedPlayer.stopPlayer().catch(console.warn);
    }
    this.subscriptions.forEach((x) => x.unsubscribe());
  }

  async toggleKeywords() {
    this.filters!.use_keywords = !this.filters!.use_keywords;
    await this.load();
  }

  async bulkAction(action: BulkActionType) {
    if (this.filters?.series_id && !this.filters?.season) {
      return;
    }
    const actionName = BulkActionType[action].toLowerCase();
    try {
      await invoke("bulk_update", { filters: this.filters, action: action });
      await this.load();
      this.toast.success(`Successfully executed bulk update: ${actionName}`);
    } catch (e) {
      this.error.handleError(e);
    }
  }
}
