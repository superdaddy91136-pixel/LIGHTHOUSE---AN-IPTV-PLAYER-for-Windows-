import { ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, ViewChild } from "@angular/core";
import { debounceTime, distinctUntilChanged, fromEvent, map, Subscription } from "rxjs";
import { Settings } from "../models/settings";
import { invoke } from "@tauri-apps/api/core";
import { Router } from "@angular/router";
import { open } from "@tauri-apps/plugin-dialog";
import { Source } from "../models/source";
import { MemoryService } from "../memory.service";
import { ViewMode } from "../models/viewMode";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { ConfirmDeleteModalComponent } from "../confirm-delete-modal/confirm-delete-modal.component";
import { SORT_TYPES, SortType, getSortTypeText } from "../models/sortType";
import { SourceType } from "../models/sourceType";
import { NavTab } from "../models/navTab";
import { ToastrService } from "ngx-toastr";
import { TmdbConfigService } from "../services/tmdb-config.service";
import { TmdbCacheService } from "../services/tmdb-cache.service";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { SourceRefreshProgress } from "../models/sourceRefreshProgress";

export type SettingsCategoryId =
  | "general"
  | "playback"
  | "library"
  | "downloads"
  | "metadata"
  | "network"
  | "system";

export interface SettingsCategory {
  id: SettingsCategoryId;
  label: string;
  description: string;
  icon: string;
}

@Component({
  selector: "app-settings",
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
})
export class SettingsComponent {
  subscriptions: Subscription[] = [];
  startupPage: string = "home";

  // Desktop categories mapping directly to existing application capabilities
  readonly categories: SettingsCategory[] = [
    {
      id: "general",
      label: "General",
      description: "Startup section, catalog ordering, and interface zoom",
      icon: "M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z",
    },
    {
      id: "playback",
      label: "Playback",
      description: "Audio volume, network buffer, and GPU video decoding",
      icon: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z",
    },
    {
      id: "library",
      label: "Library",
      description: "IPTV sources, playlist sync, and viewing history",
      icon: "M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12z",
    },
    {
      id: "downloads",
      label: "Downloads",
      description: "Recording destination and save location prompts",
      icon: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
    },
    {
      id: "metadata",
      label: "Metadata",
      description: "TMDB artwork, backdrops, cast, and cache stats",
      icon: "M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z",
    },
    {
      id: "network",
      label: "Network",
      description: "Local TCP port for LAN re-streaming",
      icon: "M12 21l3.6-4.8A7.95 7.95 0 0 0 12 15c-1.35 0-2.6.45-3.6 1.2L12 21zm0-18C7.95 3 4.21 4.34 1.2 6.6L3 9c2.5-1.88 5.62-3 9-3s6.5 1.12 9 3l1.8-2.4C19.79 4.34 16.05 3 12 3zm0 6c-2.7 0-5.19.89-7.2 2.4L6.6 13.8A7.93 7.93 0 0 1 12 12c2.03 0 3.9.67 5.4 1.8l1.8-2.4A11.95 11.95 0 0 0 12 9z",
    },
    {
      id: "system",
      label: "System",
      description: "Taskbar notification tray and launch refresh",
      icon: "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z",
    },
  ];
  activeCategory: SettingsCategoryId = "general";

  readonly zoomOptions = [
    { value: 80, label: "80% (Compact)" },
    { value: 90, label: "90% (Small)" },
    { value: 100, label: "100% (Default)" },
    { value: 110, label: "110% (Medium)" },
    { value: 125, label: "125% (Large)" },
  ];

  // TMDB configuration state
  tmdbEnabled: boolean = false;
  tmdbToken: string = "";
  showTmdbToken: boolean = false;
  tmdbTesting: boolean = false;
  tmdbTestMessage: string = "";
  tmdbTestSuccess: boolean | null = null;
  tmdbCacheStats: { enrichedCount: number; failedCount: number } = { enrichedCount: 0, failedCount: 0 };

  settings: Settings = {
    use_stream_caching: true,
    default_view: ViewMode.All,
    volume: 100,
    restream_port: 3000,
    enable_tray_icon: true,
    zoom: 100,
    default_sort: SortType.provider,
    enable_hwdec: true,
    always_ask_save: false,
    enable_gpu: false,
  };
  viewModeEnum = ViewMode;
  sources: Source[] = [];
  expiries: Record<number, number> = {};
  refreshingAll = false;
  refreshAllCurrentSource = "";
  refreshAllPercent: number | null = null;
  refreshAllIndeterminate = true;
  refreshAllFailureCount = 0;
  private refreshAllSettledSourceIds = new Set<number>();
  private unlistenSourceRefreshProgress?: UnlistenFn;
  private unlistenSourceDeleted?: UnlistenFn;
  sortTypes = SORT_TYPES;
  @ViewChild("mpvParams") mpvParams!: ElementRef;
  @ViewChild("settingsPanel") settingsPanel?: ElementRef<HTMLElement>;

  constructor(
    private router: Router,
    public memory: MemoryService,
    private nav: Router,
    private modal: NgbModal,
    public tmdbConfig: TmdbConfigService,
    public tmdbCache: TmdbCacheService,
    private toastr: ToastrService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
  ) { }

  _getSortTypeText(sortType: SortType) {
    return getSortTypeText(sortType);
  }

  selectCategory(category: SettingsCategoryId) {
    if (this.activeCategory !== category) {
      this.activeCategory = category;
      if (this.settingsPanel?.nativeElement) {
        this.settingsPanel.nativeElement.scrollTo({ top: 0, behavior: "instant" });
      }
    }
  }

  trackByCategory(_index: number, category: SettingsCategory) {
    return category.id;
  }

  onSettingsNavKeydown(event: KeyboardEvent) {
    const navKeys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!navKeys.includes(event.key)) return;
    event.preventDefault();

    const currentIndex = this.categories.findIndex((x) => x.id === this.activeCategory);
    let nextIndex = currentIndex < 0 ? 0 : currentIndex;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (nextIndex + 1) % this.categories.length;
        break;
      case "ArrowUp":
        nextIndex = (nextIndex - 1 + this.categories.length) % this.categories.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = this.categories.length - 1;
        break;
    }

    this.selectCategory(this.categories[nextIndex].id);
    const buttons = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(".settings-nav-item");
    buttons[nextIndex]?.focus();
  }

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
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    this.memory.activeNavTab.next(NavTab.Settings);
    this.getSettings();
    this.getSources();
    this.loadStartupPage();
    this.loadTmdbSettings();
    this.loadTmdbCacheStats();
    if (this.memory.XtreamSourceIds.size > 0)
      this.getExpiries();
    void this.setupRefreshAllProgressListener();
    void this.setupSourceDeletedListener();
  }

  private async setupSourceDeletedListener(): Promise<void> {
    try {
      this.unlistenSourceDeleted = await listen<number>("source-deleted", (event) => {
        if (event.payload != null) {
          this.onSourceDeleted(event.payload);
        }
      });
    } catch (err) {
      console.warn("Failed to listen for source-deleted in settings", err);
    }
  }

  private async setupRefreshAllProgressListener(): Promise<void> {
    this.unlistenSourceRefreshProgress = await listen<SourceRefreshProgress>(
      "source-refresh-progress",
      (event) => this.handleRefreshAllProgress(event.payload),
    );
  }

  private handleRefreshAllProgress(progress: SourceRefreshProgress): void {
    if (!this.refreshingAll) return;

    const source = this.sources.find((item) => item.id === progress.source_id);
    if (!source) return;

    this.refreshAllCurrentSource = source.name || "Unnamed source";
    if (progress.error) {
      if (!this.refreshAllSettledSourceIds.has(progress.source_id)) {
        this.refreshAllFailureCount += 1;
        this.refreshAllSettledSourceIds.add(progress.source_id);
      }
    } else if (progress.stage === "complete") {
      this.refreshAllSettledSourceIds.add(progress.source_id);
    }

    if (progress.indeterminate || progress.percent == null) {
      this.refreshAllIndeterminate = true;
      this.refreshAllPercent = null;
    } else {
      this.refreshAllIndeterminate = false;
      const total = Math.max(this.sources.length, 1);
      const completed = this.refreshAllSettledSourceIds.size;
      const activeProgress = this.refreshAllSettledSourceIds.has(progress.source_id)
        ? 0
        : Math.min(100, Math.max(0, progress.percent));
      this.refreshAllPercent = Math.round(((completed + activeProgress / 100) / total) * 100);
    }
    this.cdr.markForCheck();
  }

  loadStartupPage() {
    this.startupPage = localStorage.getItem("fred_tv_startup_page") || "home";
  }

  onStartupPageChange() {
    localStorage.setItem("fred_tv_startup_page", this.startupPage);
  }

  onZoomChange() {
    this.updateSettings();
    try {
      if (this.settings.zoom) {
        getCurrentWebview().setZoom(Math.trunc(this.settings.zoom * 100) / 10000);
      }
    } catch (e) {
      console.warn("Could not set zoom immediately", e);
    }
  }

  getSettings() {
    invoke("get_settings").then((x) => {
      this.settings = x as Settings;
      if (this.settings.use_stream_caching === undefined) this.settings.use_stream_caching = true;
      if (this.settings.default_view === undefined) this.settings.default_view = ViewMode.All;
      if (this.settings.volume === undefined) this.settings.volume = 100;
      if (this.settings.restream_port === undefined) this.settings.restream_port = 3000;
      if (this.settings.enable_tray_icon === undefined) this.settings.enable_tray_icon = true;
      if (this.settings.zoom === undefined) this.settings.zoom = 100;
      if (this.settings.default_sort === undefined) this.settings.default_sort = SortType.provider;
      if (this.settings.enable_hwdec === undefined) this.settings.enable_hwdec = true;
      if (this.settings.always_ask_save === undefined) this.settings.always_ask_save = false;
      if (this.settings.enable_gpu === undefined) this.settings.enable_gpu = false;
    });
  }

  trackBySourceId(_index: number, source: Source): number {
    return source.id ?? _index;
  }

  onSourceDeleted(sourceId: number): void {
    this.ngZone.run(() => {
      this.sources = this.sources.filter((s) => s.id !== sourceId);
      this.memory.Sources.delete(sourceId);
      this.memory.XtreamSourceIds.delete(sourceId);
      this.memory.CustomSourceIds.delete(sourceId);
      if (this.expiries) {
        delete this.expiries[sourceId];
      }
      this.cdr.markForCheck();
      this.getSources();
    });
  }

  getSources(): void {
    invoke<Source[]>("get_sources")
      .then((sources) => {
        this.ngZone.run(() => {
          this.sources = sources || [];
          this.memory.Sources = new Map(this.sources.filter((x) => x.enabled).map((s) => [s.id!, s]));
          this.memory.CustomSourceIds = new Set(
            this.sources.filter((x) => x.source_type === SourceType.Custom).map((x) => x.id!),
          );
          this.memory.XtreamSourceIds = new Set(
            this.sources.filter((x) => x.source_type === SourceType.Xtream).map((x) => x.id!),
          );
          this.cdr.markForCheck();
        });
      })
      .catch((err) => {
        console.error("Failed to fetch sources in settings", err);
      });
  }

  getExpiries() {
    invoke("get_all_expiries").then(expiries => {
      this.expiries = expiries as Record<number, number>;
    });
  }

  ngAfterViewInit(): void {
    if (this.mpvParams?.nativeElement) {
      this.subscriptions.push(
        fromEvent(this.mpvParams.nativeElement, "keyup")
          .pipe(
            map((event: any) => {
              return event.target.value;
            }),
            debounceTime(500),
            distinctUntilChanged(),
          )
          .subscribe(async () => {
            await this.updateSettings();
          }),
      );
    }

    this.subscriptions.push(
      this.memory.RefreshSources.subscribe((_) => {
        this.getSources();
      }),
    );
  }

  addSource() {
    this.memory.AddingAdditionalSource = true;
    this.nav.navigateByUrl("setup");
  }

  async refreshAll() {
    if (this.refreshingAll) return;
    this.memory.SeriesRefreshed.clear();
    this.refreshingAll = true;
    this.refreshAllCurrentSource = "Preparing sources";
    this.refreshAllPercent = null;
    this.refreshAllIndeterminate = true;
    this.refreshAllFailureCount = 0;
    this.refreshAllSettledSourceIds.clear();
    try {
      await invoke("refresh_all");
      this.toastr.success("Successfully updated all sources");
    } catch (error) {
      const failureSummary = this.refreshAllFailureCount > 0
        ? `${this.refreshAllFailureCount} source${this.refreshAllFailureCount === 1 ? "" : "s"} failed; valid sources were retained.`
        : "Failed to refresh sources";
      this.toastr.error(failureSummary);
      console.error("Failed to refresh all sources", error);
    } finally {
      this.refreshingAll = false;
      this.memory.RefreshSources.next(true);
      this.cdr.markForCheck();
    }
  }

  async goBack() {
    await this.updateSettings();
    this.memory.activeNavTab.next(NavTab.Home);
    this.router.navigateByUrl("");
  }

  async updateSettings() {
    this.settings.mpv_params = this.settings.mpv_params?.trim();
    if (this.settings.mpv_params === "")
      this.settings.mpv_params = undefined;
    await invoke("update_settings", { settings: this.settings });
  }

  async selectFolder() {
    const folder = await open({
      multiple: false,
      directory: true,
      canCreateDirectories: true,
    });
    if (folder) {
      this.settings.recording_path = folder;
      await this.updateSettings();
    }
  }

  async nuke() {
    this.memory.ModalRef = this.modal.open(ConfirmDeleteModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "ConfirmDeleteModal";
  }

  async clearHistory() {
    await this.memory.tryIPC(
      "History cleared successfully",
      "Failed to clear history",
      async () => {
        await invoke("clear_history");
      },
    );
  }

  loadTmdbSettings() {
    const cfg = this.tmdbConfig.getConfig();
    this.tmdbEnabled = cfg.enabled;
    this.tmdbToken = cfg.token || '';
  }

  async loadTmdbCacheStats() {
    this.tmdbCacheStats = await this.tmdbCache.getCacheStats();
  }

  onTmdbEnabledChange() {
    this.tmdbConfig.setEnabled(this.tmdbEnabled);
    if (this.tmdbEnabled && (!this.tmdbToken || this.tmdbToken.trim().length === 0)) {
      this.toastr.info("Please enter your TMDB API Read Access Token to enable enrichment.");
    }
  }

  onTmdbTokenChange() {
    this.tmdbConfig.setToken(this.tmdbToken);
    this.tmdbTestSuccess = null;
    this.tmdbTestMessage = '';
  }

  toggleShowTmdbToken() {
    this.showTmdbToken = !this.showTmdbToken;
  }

  async testTmdbConnection() {
    this.tmdbTesting = true;
    this.tmdbTestMessage = '';
    this.tmdbTestSuccess = null;
    try {
      const res = await this.tmdbConfig.testConnection(this.tmdbToken);
      this.tmdbTestSuccess = res.success;
      this.tmdbTestMessage = res.message;
      if (res.success) {
        this.toastr.success(res.message);
      } else {
        this.toastr.error(res.message);
      }
    } finally {
      this.tmdbTesting = false;
    }
  }

  clearTmdbToken() {
    this.tmdbToken = '';
    this.tmdbConfig.clearToken();
    this.tmdbTestSuccess = null;
    this.tmdbTestMessage = '';
    this.toastr.info("TMDB API Read Access Token cleared.");
  }

  async clearTmdbCache() {
    await this.tmdbCache.clearCache();
    await this.loadTmdbCacheStats();
    this.toastr.success("TMDB metadata cache cleared.");
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((x) => x.unsubscribe());
    this.unlistenSourceRefreshProgress?.();
    this.unlistenSourceDeleted?.();
  }
}
