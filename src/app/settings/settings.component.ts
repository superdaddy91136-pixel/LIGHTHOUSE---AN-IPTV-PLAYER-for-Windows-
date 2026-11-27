import { ChangeDetectorRef, Component, ElementRef, HostListener, NgZone, ViewChild } from "@angular/core";
import { debounceTime, Subject, Subscription } from "rxjs";
import { Settings, StorageStats } from "../models/settings";
import { invoke } from "@tauri-apps/api/core";
import { Router } from "@angular/router";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Source } from "../models/source";
import { MemoryService } from "../memory.service";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { ConfirmDeleteModalComponent } from "../confirm-delete-modal/confirm-delete-modal.component";
import { SORT_TYPES, SortType, getSortTypeText } from "../models/sortType";
import { SourceType } from "../models/sourceType";
import { NavTab } from "../models/navTab";
import { ToastrService } from "ngx-toastr";
import { clearLegacyWatchProgressStorage } from "../services/embedded-player.service";
import { TmdbConfigService } from "../services/tmdb-config.service";
import { TmdbCacheService } from "../services/tmdb-cache.service";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getName, getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { emit, listen, UnlistenFn } from "@tauri-apps/api/event";
import { SourceRefreshProgress } from "../models/sourceRefreshProgress";
import {
  ACCENT_PRESETS,
  AppPreferencesService,
  DEFAULT_KEYBINDINGS,
  SHORTCUT_DEFINITIONS,
  ShortcutActionId,
} from "../services/app-preferences.service";

export type SettingsCategoryId =
  | "general"
  | "playback"
  | "livetv"
  | "library"
  | "storage"
  | "metadata"
  | "network"
  | "appearance"
  | "shortcuts"
  | "system"
  | "about";

export type ResettableSectionId =
  | "general-startup"
  | "general-display"
  | "playback-audio"
  | "playback-lang"
  | "playback-hw"
  | "playback-mpv"
  | "livetv-prefs"
  | "library-schedule"
  | "storage-location"
  | "metadata-tmdb"
  | "network-restream"
  | "network-proxy"
  | "appearance-theme"
  | "appearance-glass"
  | "shortcuts-keys"
  | "system-integration";

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
      description: "Audio volume, languages, buffer, and GPU decoding",
      icon: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z",
    },
    {
      id: "livetv",
      label: "Live TV",
      description: "Startup folder and auto-resume navigation",
      icon: "M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z",
    },
    {
      id: "library",
      label: "Library",
      description: "IPTV sources, scheduled sync, and playlist management",
      icon: "M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12z",
    },
    {
      id: "storage",
      label: "Storage & Data",
      description: "Screenshots, disk usage, cache cleanup, and JSON backups",
      icon: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
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
      description: "Local re-streaming port and HTTP proxy settings",
      icon: "M12 21l3.6-4.8A7.95 7.95 0 0 0 12 15c-1.35 0-2.6.45-3.6 1.2L12 21zm0-18C7.95 3 4.21 4.34 1.2 6.6L3 9c2.5-1.88 5.62-3 9-3s6.5 1.12 9 3l1.8-2.4C19.79 4.34 16.05 3 12 3zm0 6c-2.7 0-5.19.89-7.2 2.4L6.6 13.8A7.93 7.93 0 0 1 12 12c2.03 0 3.9.67 5.4 1.8l1.8-2.4A11.95 11.95 0 0 0 12 9z",
    },
    {
      id: "appearance",
      label: "Appearance",
      description: "Accent colors and overlay frosted glass controls",
      icon: "M12,3A9,9 0 0,0 3,12A9,9 0 0,0 12,21A1.5,1.5 0 0,0 13.5,19.5C13.5,19.11 13.35,18.76 13.11,18.5C12.88,18.23 12.73,17.88 12.73,17.5A1.5,1.5 0 0,1 14.23,16H16A5,5 0 0,0 21,11C21,6.58 16.97,3 12,3M6.5,12A1.5,1.5 0 0,1 5,10.5A1.5,1.5 0 0,1 6.5,9A1.5,1.5 0 0,1 8,10.5A1.5,1.5 0 0,1 6.5,12M9.5,8A1.5,1.5 0 0,1 8,6.5A1.5,1.5 0 0,1 9.5,5A1.5,1.5 0 0,1 11,6.5A1.5,1.5 0 0,1 9.5,8M14.5,8A1.5,1.5 0 0,1 13,6.5A1.5,1.5 0 0,1 14.5,5A1.5,1.5 0 0,1 16,6.5A1.5,1.5 0 0,1 14.5,8M17.5,12A1.5,1.5 0 0,1 16,10.5A1.5,1.5 0 0,1 17.5,9A1.5,1.5 0 0,1 19,10.5A1.5,1.5 0 0,1 17.5,12Z",
    },
    {
      id: "shortcuts",
      label: "Shortcuts",
      description: "Player keyboard cheat sheet and custom bindings",
      icon: "M19,10H17V8H19M19,13H17V11H19M16,10H14V8H16M16,13H14V11H16M16,17H8V15H16M7,10H5V8H7M7,13H5V11H7M8,11H10V13H8M8,8H10V10H8M11,11H13V13H11M11,8H13V10H11M20,5H4A2,2 0 0,0 2,7V17A2,2 0 0,0 4,19H20A2,2 0 0,0 22,17V7A2,2 0 0,0 20,5Z",
    },
    {
      id: "system",
      label: "System",
      description: "Window state, exit cleanup, and startup PIN lock",
      icon: "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z",
    },
    {
      id: "about",
      label: "About",
      description: "Application version, runtime stack, and privacy",
      icon: "M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z",
    },
  ];
  activeCategory: SettingsCategoryId = "general";
  settingsSearch: string = "";
  appName: string = "Lighthouse";
  appVersion: string = "1.9.1";
  tauriVersion: string = "";

  private readonly categorySearchIndex: Record<SettingsCategoryId, string> = {
    general:
      "general startup page home discovery live tv movies tv shows default catalog sorting display scale interface zoom",
    playback:
      "playback audio buffering remember last volume startup volume level stream caching buffer preset low latency balanced smooth auto reconnect stream failure retry count default audio language subtitle language deinterlacing deinterlace hardware video decoding hwdec gpu render pipeline vo gpu-next advanced parameters mpv cli flags",
    livetv:
      "live tv startup navigation default folder favorites all channels recent resume start last watched channel",
    library:
      "library connected sources iptv playlist xtream m3u add refresh all schedule auto-refresh interval hours epg sync frequency",
    storage:
      "screenshots storage data location destination folder path browse reset sqlite database size tmdb cache clear watch history export import backup restore settings favorites json",
    metadata:
      "metadata tmdb the movie database enrichment api read access token test connection clear cache artwork posters backdrops cast",
    network:
      "network sharing local re-streaming http streaming port tcp lan http proxy server",
    appearance:
      "appearance accent theme color crimson ocean emerald amber violet player overlay glass blur opacity frosted preview",
    shortcuts:
      "shortcuts keyboard cheat sheet keybindings rebind play pause seek volume mute speed playback faster slower fullscreen stats channels next previous recall screenshot",
    system:
      "application system integration refresh sources on launch remember window size position clear history on exit startup pin lock security privacy",
    about:
      "about lighthouse version build tauri mpv playback engine privacy local-only",
  };

  readonly zoomOptions = [
    { value: 80, label: "80% (Compact)" },
    { value: 90, label: "90% (Small)" },
    { value: 100, label: "100% (Default)" },
    { value: 110, label: "110% (Medium)" },
    { value: 125, label: "125% (Large)" },
  ];
  readonly reconnectAttemptOptions = [1, 3, 5];
  readonly bufferPresetOptions = [
    { value: "low", label: "Low Latency (5s)" },
    { value: "balanced", label: "Balanced (15s)" },
    { value: "smooth", label: "Smooth / Large Buffer (30s)" },
  ];
  readonly languageOptions = [
    { value: "eng", label: "English" },
    { value: "spa", label: "Spanish" },
    { value: "fre", label: "French" },
    { value: "ger", label: "German" },
    { value: "ita", label: "Italian" },
    { value: "por", label: "Portuguese" },
    { value: "rus", label: "Russian" },
    { value: "jpn", label: "Japanese" },
    { value: "kor", label: "Korean" },
    { value: "chi", label: "Chinese" },
    { value: "hin", label: "Hindi" },
    { value: "ara", label: "Arabic" },
    { value: "tur", label: "Turkish" },
    { value: "dut", label: "Dutch" },
    { value: "pol", label: "Polish" },
  ];
  readonly liveFolderOptions = [
    { value: "favorites", label: "Favorites" },
    { value: "all", label: "All Channels" },
    { value: "recent", label: "Recent Channels" },
  ];
  readonly refreshIntervalOptions = [
    { value: 0, label: "Off (Manual only)" },
    { value: 12, label: "Every 12 hours" },
    { value: 24, label: "Every 24 hours" },
    { value: 48, label: "Every 48 hours (Default)" },
  ];
  readonly accentPresets = ACCENT_PRESETS;
  readonly shortcutDefs = SHORTCUT_DEFINITIONS;

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
    volume: 100,
    remember_volume: false,
    auto_reconnect: true,
    reconnect_attempts: 3,
    default_audio_lang: "",
    default_subtitle_lang: "",
    enable_deinterlace: false,
    buffer_preset: "balanced",
    live_start_last_channel: false,
    default_live_folder: "favorites",
    auto_refresh_hours: 48,
    epg_refresh_hours: 24,
    remember_window_state: true,
    clear_history_on_exit: false,
    pin_lock_enabled: false,
    http_proxy: "",
    overlay_glass_blur: 64,
    overlay_glass_opacity: 80,
    accent_color: "crimson",
    refresh_on_start: false,
    restream_port: 3000,
    zoom: 100,
    default_sort: SortType.provider,
    enable_hwdec: true,
    enable_gpu: false,
  };
  mpvParamsError = "";
  restreamPortError = "";
  httpProxyError = "";
  private lastValidMpvParams?: string;
  private lastValidRestreamPort = 3000;
  private lastValidHttpProxy?: string;

  // Storage usage stats state
  storageStats: StorageStats = {
    sqlite_bytes: 0,
    history_count: 0,
    hidden_count: 0,
    favorites_count: 0,
  };

  // PIN lock setup/disable form state
  newPinInput = "";
  confirmPinInput = "";
  currentPinInput = "";
  pinFormError = "";

  // Shortcut customization state
  keybindingsMap: Record<ShortcutActionId, string> = { ...DEFAULT_KEYBINDINGS };
  capturingShortcutAction: ShortcutActionId | null = null;
  shortcutConflictError = "";

  private pendingDebouncedSave = false;
  private saveDebounced$ = new Subject<void>();
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
    public appPreferences: AppPreferencesService,
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
      this.capturingShortcutAction = null;
      this.shortcutConflictError = "";
      if (category === "storage") {
        void this.loadStorageStats();
      }
      if (this.settingsPanel?.nativeElement) {
        this.settingsPanel.nativeElement.scrollTo({ top: 0, behavior: "instant" });
      }
    }
  }

  get filteredCategories(): SettingsCategory[] {
    const q = this.settingsSearch.trim().toLowerCase();
    if (!q) return this.categories;
    return this.categories.filter((c) => {
      const index = this.categorySearchIndex[c.id] || "";
      return (
        c.label.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        index.includes(q)
      );
    });
  }

  onSettingsSearchChange(query: string): void {
    this.settingsSearch = query;
    const matches = this.filteredCategories;
    if (matches.length > 0 && !matches.some((c) => c.id === this.activeCategory)) {
      this.selectCategory(matches[0].id);
    }
  }

  clearSettingsSearch(): void {
    this.settingsSearch = "";
  }

  matchesSearch(...texts: string[]): boolean {
    const q = this.settingsSearch.trim().toLowerCase();
    if (!q) return true;
    return texts.some((t) => t.toLowerCase().includes(q));
  }

  trackByCategory(_index: number, category: SettingsCategory) {
    return category.id;
  }

  onSettingsNavKeydown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement) {
      if (event.key === "Escape" && this.settingsSearch) {
        event.preventDefault();
        event.stopPropagation();
        this.clearSettingsSearch();
      }
      return;
    }
    const navKeys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!navKeys.includes(event.key)) return;
    event.preventDefault();

    const list = this.filteredCategories;
    if (list.length === 0) return;
    const currentIndex = list.findIndex((x) => x.id === this.activeCategory);
    let nextIndex = currentIndex < 0 ? 0 : currentIndex;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (nextIndex + 1) % list.length;
        break;
      case "ArrowUp":
        nextIndex = (nextIndex - 1 + list.length) % list.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = list.length - 1;
        break;
    }

    this.selectCategory(list[nextIndex].id);
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
    if (this.capturingShortcutAction) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        this.capturingShortcutAction = null;
        this.shortcutConflictError = "";
        return;
      }
      const binding = this.appPreferences.normalizeEventToBinding(event);
      if (!binding) return;
      const conflictAction = (Object.keys(this.keybindingsMap) as ShortcutActionId[]).find(
        (id) => id !== this.capturingShortcutAction && this.keybindingsMap[id] === binding,
      );
      if (conflictAction) {
        const conflictLabel =
          this.shortcutDefs.find((d) => d.id === conflictAction)?.label || conflictAction;
        this.shortcutConflictError = `"${this.appPreferences.formatBindingLabel(binding)}" is already assigned to "${conflictLabel}". Choose another key.`;
        return;
      }
      this.keybindingsMap[this.capturingShortcutAction] = binding;
      this.settings.keybindings = JSON.stringify(this.keybindingsMap);
      this.capturingShortcutAction = null;
      this.shortcutConflictError = "";
      void this.updateSettings();
      return;
    }
    if (
      event.key === "Escape" &&
      document.activeElement?.classList.contains("sidebar-search-input") &&
      this.settingsSearch
    ) {
      event.preventDefault();
      this.clearSettingsSearch();
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
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    this.memory.activeNavTab.next(NavTab.Settings);
    this.subscriptions.push(
      this.saveDebounced$.pipe(debounceTime(350)).subscribe(() => {
        void this.flushDebouncedSave();
      }),
    );
    this.getSettings();
    this.getSources();
    this.loadStartupPage();
    this.loadTmdbSettings();
    this.loadTmdbCacheStats();
    void this.loadStorageStats();
    void this.loadAppInfo();
    if (this.memory.XtreamSourceIds.size > 0)
      this.getExpiries();
    void this.setupRefreshAllProgressListener();
    void this.setupSourceDeletedListener();
  }

  private async loadAppInfo(): Promise<void> {
    try {
      const [name, version, tauriVer] = await Promise.all([
        getName().catch(() => "Lighthouse"),
        getVersion().catch(() => "1.9.1"),
        getTauriVersion().catch(() => ""),
      ]);
      this.appName = name || "Lighthouse";
      this.appVersion = version || "1.9.1";
      this.tauriVersion = tauriVer || "";
      this.cdr.markForCheck();
    } catch {}
  }

  async resetSection(section: ResettableSectionId): Promise<void> {
    switch (section) {
      case "general-startup":
        this.startupPage = "home";
        this.onStartupPageChange();
        this.settings.default_sort = SortType.provider;
        await this.updateSettings();
        break;
      case "general-display":
        this.settings.zoom = 100;
        this.onZoomChange();
        break;
      case "playback-audio":
        this.pendingDebouncedSave = false;
        this.settings.remember_volume = false;
        this.settings.volume = 100;
        this.settings.use_stream_caching = true;
        this.settings.buffer_preset = "balanced";
        this.settings.auto_reconnect = true;
        this.settings.reconnect_attempts = 3;
        await this.updateSettings();
        break;
      case "playback-lang":
        this.settings.default_audio_lang = "";
        this.settings.default_subtitle_lang = "";
        this.settings.enable_deinterlace = false;
        await this.updateSettings();
        break;
      case "playback-hw":
        this.settings.enable_hwdec = true;
        this.settings.enable_gpu = false;
        await this.updateSettings();
        break;
      case "playback-mpv":
        this.pendingDebouncedSave = false;
        this.settings.mpv_params = undefined;
        this.mpvParamsError = "";
        await this.updateSettings();
        break;
      case "livetv-prefs":
        this.settings.default_live_folder = "favorites";
        this.settings.live_start_last_channel = false;
        await this.updateSettings();
        break;
      case "library-schedule":
        this.settings.auto_refresh_hours = 48;
        this.settings.epg_refresh_hours = 24;
        await this.updateSettings();
        invoke("trigger_auto_refresh_check").catch(() => {});
        break;
      case "storage-location":
        this.settings.screenshot_path = undefined;
        await this.updateSettings();
        break;
      case "metadata-tmdb":
        this.tmdbEnabled = false;
        this.tmdbToken = "";
        this.showTmdbToken = false;
        this.tmdbTestMessage = "";
        this.tmdbTestSuccess = null;
        this.tmdbConfig.setEnabled(false);
        this.tmdbConfig.clearToken();
        break;
      case "network-restream":
        this.pendingDebouncedSave = false;
        this.settings.restream_port = 3000;
        this.restreamPortError = "";
        await this.updateSettings();
        break;
      case "network-proxy":
        this.pendingDebouncedSave = false;
        this.settings.http_proxy = undefined;
        this.httpProxyError = "";
        await this.updateSettings();
        break;
      case "appearance-theme":
        this.settings.accent_color = "crimson";
        await this.updateSettings();
        break;
      case "appearance-glass":
        this.pendingDebouncedSave = false;
        this.settings.overlay_glass_blur = 64;
        this.settings.overlay_glass_opacity = 80;
        await this.updateSettings();
        break;
      case "shortcuts-keys":
        this.capturingShortcutAction = null;
        this.shortcutConflictError = "";
        this.keybindingsMap = { ...DEFAULT_KEYBINDINGS };
        this.settings.keybindings = JSON.stringify(this.keybindingsMap);
        await this.updateSettings();
        break;
      case "system-integration":
        this.settings.refresh_on_start = false;
        this.settings.remember_window_state = true;
        this.settings.clear_history_on_exit = false;
        await this.updateSettings();
        break;
    }
    this.cdr.markForCheck();
    this.toastr.success("Reset section to defaults");
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

  private applyLoadedSettings(x?: Settings | null): void {
    this.settings = x || {};
    if (this.settings.use_stream_caching === undefined) this.settings.use_stream_caching = true;
    if (this.settings.volume === undefined) this.settings.volume = 100;
    if (this.settings.remember_volume === undefined) this.settings.remember_volume = false;
    if (this.settings.auto_reconnect === undefined) this.settings.auto_reconnect = true;
    if (
      this.settings.reconnect_attempts !== 1 &&
      this.settings.reconnect_attempts !== 3 &&
      this.settings.reconnect_attempts !== 5
    ) {
      this.settings.reconnect_attempts = 3;
    }
    if (this.settings.default_audio_lang === undefined) this.settings.default_audio_lang = "";
    if (this.settings.default_subtitle_lang === undefined) this.settings.default_subtitle_lang = "";
    if (this.settings.enable_deinterlace === undefined) this.settings.enable_deinterlace = false;
    if (
      this.settings.buffer_preset !== "low" &&
      this.settings.buffer_preset !== "balanced" &&
      this.settings.buffer_preset !== "smooth"
    ) {
      this.settings.buffer_preset = "balanced";
    }
    if (this.settings.live_start_last_channel === undefined) this.settings.live_start_last_channel = false;
    if (
      this.settings.default_live_folder !== "favorites" &&
      this.settings.default_live_folder !== "all" &&
      this.settings.default_live_folder !== "recent"
    ) {
      this.settings.default_live_folder = "favorites";
    }
    if (
      this.settings.auto_refresh_hours !== 0 &&
      this.settings.auto_refresh_hours !== 12 &&
      this.settings.auto_refresh_hours !== 24 &&
      this.settings.auto_refresh_hours !== 48
    ) {
      this.settings.auto_refresh_hours = 48;
    }
    if (
      this.settings.epg_refresh_hours !== 0 &&
      this.settings.epg_refresh_hours !== 12 &&
      this.settings.epg_refresh_hours !== 24 &&
      this.settings.epg_refresh_hours !== 48
    ) {
      this.settings.epg_refresh_hours = 24;
    }
    if (this.settings.remember_window_state === undefined) this.settings.remember_window_state = true;
    if (this.settings.clear_history_on_exit === undefined) this.settings.clear_history_on_exit = false;
    if (this.settings.pin_lock_enabled === undefined) this.settings.pin_lock_enabled = false;
    if (this.settings.overlay_glass_blur === undefined) this.settings.overlay_glass_blur = 64;
    if (this.settings.overlay_glass_opacity === undefined) this.settings.overlay_glass_opacity = 80;
    if (!this.settings.accent_color) this.settings.accent_color = "crimson";
    this.keybindingsMap = this.appPreferences.parseKeybindings(this.settings.keybindings);

    if (this.settings.refresh_on_start === undefined) this.settings.refresh_on_start = false;
    if (this.settings.restream_port === undefined) this.settings.restream_port = 3000;
    if (this.settings.zoom === undefined) this.settings.zoom = 100;
    if (this.settings.default_sort === undefined) this.settings.default_sort = SortType.provider;
    if (this.settings.enable_hwdec === undefined) this.settings.enable_hwdec = true;
    if (this.settings.enable_gpu === undefined) this.settings.enable_gpu = false;
    this.lastValidMpvParams = this.settings.mpv_params?.trim() || undefined;
    this.lastValidRestreamPort = this.validateRestreamPort(this.settings.restream_port)
      ? 3000
      : (this.settings.restream_port as number);
    this.lastValidHttpProxy = this.validateHttpProxy(this.settings.http_proxy)
      ? undefined
      : (this.settings.http_proxy?.trim() || undefined);
    this.mpvParamsError = this.validateMpvParams(this.settings.mpv_params) || "";
    this.restreamPortError = this.validateRestreamPort(this.settings.restream_port) || "";
    this.httpProxyError = this.validateHttpProxy(this.settings.http_proxy) || "";
    this.appPreferences.applySettings(this.settings, false);
    this.cdr.markForCheck();
  }

  getSettings() {
    invoke("get_settings")
      .then((x) => {
        this.applyLoadedSettings(x as Settings);
      })
      .catch((err) => {
        console.error("Failed to load settings", err);
        this.toastr.error("Failed to load settings");
      });
  }

  async exportBackup(): Promise<void> {
    try {
      const file = await save({
        canCreateDirectories: true,
        title: "Export Settings & Favorites Backup",
        defaultPath: "lighthouse-backup.json",
        filters: [{ name: "JSON Backup", extensions: ["json"] }],
      });
      if (!file) return;
      const favCount = await invoke<number>("export_settings_backup", {
        path: file,
        startupPage: this.startupPage,
      });
      this.toastr.success(
        favCount > 0
          ? `Exported settings and ${favCount} favorite(s)`
          : "Exported settings backup",
      );
    } catch (err) {
      console.error("Failed to export backup", err);
      this.toastr.error("Failed to export backup");
    }
  }

  async importBackup(): Promise<void> {
    try {
      const file = await open({
        multiple: false,
        directory: false,
        title: "Import Settings & Favorites Backup",
        filters: [{ name: "JSON Backup", extensions: ["json"] }],
      });
      if (!file || typeof file !== "string") return;

      const summary = await invoke<{
        settings: Settings;
        startup_page?: string;
        restored_favorites: number;
        skipped_sources: number;
      }>("import_settings_backup", { path: file });

      this.applyLoadedSettings(summary.settings);
      if (summary.startup_page) {
        this.startupPage = summary.startup_page;
        this.onStartupPageChange();
      }
      try {
        if (this.settings.zoom) {
          getCurrentWebview().setZoom(Math.trunc(this.settings.zoom * 100) / 10000);
        }
      } catch {}
      emit("settings-updated", this.settings).catch(() => {});
      if (summary.restored_favorites > 0) {
        this.memory.RefreshSources.next(true);
      }
      const msg =
        summary.restored_favorites > 0
          ? `Imported settings and restored ${summary.restored_favorites} favorite(s)`
          : "Imported settings backup";
      this.toastr.success(msg);
    } catch (err) {
      console.error("Failed to import backup", err);
      this.toastr.error(typeof err === "string" ? err : "Failed to import backup");
    }
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

  validateMpvParams(raw?: string): string | null {
    const trimmed = raw?.trim();
    if (!trimmed) return null;

    let activeQuote: string | null = null;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "\\" && i + 1 < trimmed.length && (trimmed[i + 1] === '"' || trimmed[i + 1] === "'")) {
        i++;
        continue;
      }
      if (activeQuote) {
        if (ch === activeQuote) activeQuote = null;
      } else if (ch === '"' || ch === "'") {
        activeQuote = ch;
      }
    }
    if (activeQuote) {
      return "Unbalanced quotes in MPV parameters. Close all quotes before saving.";
    }

    const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (
        lower === "--wid" ||
        lower === "-wid" ||
        lower.startsWith("--wid=") ||
        lower.startsWith("-wid=") ||
        lower === "--input-ipc-server" ||
        lower === "-input-ipc-server" ||
        lower.startsWith("--input-ipc-server=") ||
        lower.startsWith("-input-ipc-server=")
      ) {
        return "The --wid and --input-ipc-server flags are reserved for the embedded player and cannot be set here.";
      }
    }
    return null;
  }

  validateRestreamPort(val: unknown): string | null {
    if (typeof val !== "number" || !Number.isInteger(val) || val < 1024 || val > 65535) {
      return "Port must be a whole number between 1024 and 65535.";
    }
    return null;
  }

  validateHttpProxy(raw?: string): string | null {
    const trimmed = raw?.trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "Proxy URL must start with http:// or https://.";
      }
      if (!parsed.hostname) {
        return "Proxy URL must include a valid host.";
      }
      return null;
    } catch {
      return "Invalid proxy URL format (example: http://127.0.0.1:8080).";
    }
  }

  onVolumeChange() {
    this.pendingDebouncedSave = true;
    this.saveDebounced$.next();
  }

  onGlassChange() {
    this.appPreferences.applySettings(this.settings, false);
    this.pendingDebouncedSave = true;
    this.saveDebounced$.next();
  }

  onSelectAccent(accentId: string) {
    this.settings.accent_color = accentId;
    this.appPreferences.applySettings(this.settings, false);
    void this.updateSettings();
  }

  onAutoRefreshHoursChange() {
    void this.updateSettings().then(() => {
      invoke("trigger_auto_refresh_check").catch(() => {});
    });
  }

  onMpvParamsChange() {
    this.mpvParamsError = this.validateMpvParams(this.settings.mpv_params) || "";
    if (!this.mpvParamsError) {
      this.pendingDebouncedSave = true;
      this.saveDebounced$.next();
    } else {
      this.pendingDebouncedSave = false;
    }
  }

  onRestreamPortChange() {
    this.restreamPortError = this.validateRestreamPort(this.settings.restream_port) || "";
    if (!this.restreamPortError) {
      this.pendingDebouncedSave = true;
      this.saveDebounced$.next();
    } else {
      this.pendingDebouncedSave = false;
    }
  }

  onHttpProxyChange() {
    this.httpProxyError = this.validateHttpProxy(this.settings.http_proxy) || "";
    if (!this.httpProxyError) {
      this.pendingDebouncedSave = true;
      this.saveDebounced$.next();
    } else {
      this.pendingDebouncedSave = false;
    }
  }

  clearHttpProxy() {
    this.settings.http_proxy = "";
    this.httpProxyError = "";
    this.pendingDebouncedSave = false;
    void this.updateSettings();
  }

  startShortcutCapture(actionId: ShortcutActionId) {
    this.shortcutConflictError = "";
    this.capturingShortcutAction = this.capturingShortcutAction === actionId ? null : actionId;
  }

  async loadStorageStats(): Promise<void> {
    try {
      const stats = await invoke<StorageStats>("get_storage_stats");
      if (stats) {
        this.storageStats = stats;
        this.cdr.markForCheck();
      }
    } catch (e) {
      console.warn("Failed to load storage stats:", e);
    }
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return "0 KB";
    const units = ["B", "KB", "MB", "GB"];
    let val = bytes;
    let idx = 0;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx++;
    }
    return `${val >= 10 || idx === 0 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`;
  }

  async enableAppPin(): Promise<void> {
    const pin = this.newPinInput.trim();
    const confirm = this.confirmPinInput.trim();
    this.pinFormError = "";
    if (pin.length < 4) {
      this.pinFormError = "PIN must be at least 4 characters.";
      return;
    }
    if (pin !== confirm) {
      this.pinFormError = "PINs do not match.";
      return;
    }
    this.settings.app_pin_hash = await this.appPreferences.hashPin(pin);
    this.settings.pin_lock_enabled = true;
    this.newPinInput = "";
    this.confirmPinInput = "";
    await this.updateSettings();
    this.toastr.success("Startup PIN lock enabled");
  }

  async disableAppPin(): Promise<void> {
    this.pinFormError = "";
    const cur = this.currentPinInput.trim();
    if (!cur) {
      this.pinFormError = "Enter your current PIN to disable lock.";
      return;
    }
    const ok = await this.appPreferences.verifyPin(cur, this.settings.app_pin_hash);
    if (!ok) {
      this.pinFormError = "Current PIN is incorrect.";
      return;
    }
    this.settings.pin_lock_enabled = false;
    this.settings.app_pin_hash = "";
    this.currentPinInput = "";
    await this.updateSettings();
    this.toastr.info("Startup PIN lock disabled");
  }

  getGlassPreviewBackground(): string {
    const op = typeof this.settings.overlay_glass_opacity === "number"
      ? Math.max(40, Math.min(100, this.settings.overlay_glass_opacity)) / 100
      : 0.8;
    return `linear-gradient(155deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.02) 38%, rgba(0, 0, 0, 0.14) 100%), rgba(18, 18, 18, ${op.toFixed(2)})`;
  }

  private async flushDebouncedSave() {
    if (!this.pendingDebouncedSave) return;
    this.pendingDebouncedSave = false;
    await this.updateSettings();
  }

  async goBack() {
    if (this.pendingDebouncedSave) {
      await this.flushDebouncedSave();
    }
    this.memory.activeNavTab.next(NavTab.Home);
    this.router.navigateByUrl("");
  }

  async updateSettings() {
    const mpvErr = this.validateMpvParams(this.settings.mpv_params);
    const portErr = this.validateRestreamPort(this.settings.restream_port);
    const proxyErr = this.validateHttpProxy(this.settings.http_proxy);
    this.mpvParamsError = mpvErr || "";
    this.restreamPortError = portErr || "";
    this.httpProxyError = proxyErr || "";

    const trimmedMpv = this.settings.mpv_params?.trim();
    const cleanMpv = trimmedMpv === "" ? undefined : trimmedMpv;
    if (!mpvErr) {
      this.settings.mpv_params = cleanMpv;
    }
    const trimmedProxy = this.settings.http_proxy?.trim();
    const cleanProxy = trimmedProxy === "" ? undefined : trimmedProxy;
    if (!proxyErr) {
      this.settings.http_proxy = cleanProxy;
    }

    const payload: Settings = {
      ...this.settings,
      mpv_params: mpvErr ? this.lastValidMpvParams : cleanMpv,
      restream_port: portErr ? this.lastValidRestreamPort : this.settings.restream_port,
      http_proxy: proxyErr ? this.lastValidHttpProxy : cleanProxy,
    };

    try {
      await invoke("update_settings", { settings: payload });
      if (!mpvErr) this.lastValidMpvParams = cleanMpv;
      if (!portErr && typeof payload.restream_port === "number") {
        this.lastValidRestreamPort = payload.restream_port;
      }
      if (!proxyErr) this.lastValidHttpProxy = cleanProxy;
      this.appPreferences.applySettings(payload, false);
      emit("settings-updated", payload).catch(() => {});
    } catch (err) {
      console.error("Failed to save settings", err);
      this.toastr.error("Failed to save settings");
    }
  }

  async selectScreenshotFolder() {
    const folder = await open({
      multiple: false,
      directory: true,
      canCreateDirectories: true,
    });
    if (folder) {
      this.settings.screenshot_path = folder;
      await this.updateSettings();
    }
  }

  async resetScreenshotFolder() {
    this.settings.screenshot_path = undefined;
    await this.updateSettings();
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
        clearLegacyWatchProgressStorage();
        await this.loadStorageStats();
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
