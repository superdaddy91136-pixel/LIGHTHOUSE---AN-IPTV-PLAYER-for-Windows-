import { Injectable } from "@angular/core";
import { Source } from "./models/source";
import { BehaviorSubject, Subject } from "rxjs";
import { MatMenuTrigger } from "@angular/material/menu";
import { ToastrService } from "ngx-toastr";
import { ErrorService } from "./error.service";
import { NgbModalRef } from "@ng-bootstrap/ng-bootstrap";
import { invoke } from "@tauri-apps/api/core";
import { SortType } from "./models/sortType";
import { LAST_SEEN_VERSION } from "./models/localStorage";
import { SetNodeDTO } from "./models/setNodeDTO";
import { NavTab } from "./models/navTab";
import { Stack } from "./models/stack";
import { Channel } from "./models/channel";

@Injectable({
  providedIn: "root",
})
export class MemoryService {
  constructor(
    private toastr: ToastrService,
    private error: ErrorService,
  ) {}

  private getInitialStartupTab(): NavTab {
    try {
      const pref = localStorage.getItem("fred_tv_startup_page") || "home";
      if (pref === "livetv") return NavTab.LiveTV;
      if (pref === "movies") return NavTab.Movies;
      if (pref === "tvshows") return NavTab.TVShows;
    } catch {
      // ignore
    }
    return NavTab.Home;
  }
  public activeNavTab: BehaviorSubject<NavTab> = new BehaviorSubject<NavTab>(this.getInitialStartupTab());
  public navTabClick: Subject<NavTab> = new Subject<NavTab>();
  public nodeStack: Stack = new Stack();
  public categoryScrollPositions: Map<NavTab, number> = new Map();
  public allScrollPositions: Map<NavTab, number> = new Map();
  private catalogPageCache = new Map<
    string,
    { channels: Channel[]; reachedMax: boolean; cachedAt: number }
  >();
  public folderScrollPositions: Map<string, number> = new Map();
  public searchScrollPositions: Map<NavTab, number> = new Map();
  public searchHorizontalScrollPositions: Map<NavTab, Record<string, number>> = new Map();
  public homeDiscoveryScrollPosition: number = 0;
  public SetNode: Subject<SetNodeDTO> = new Subject();
  public SetFocus: Subject<number> = new Subject();
  public Sort: BehaviorSubject<[number, boolean]> = new BehaviorSubject<[number, boolean]>([
    SortType.provider,
    false,
  ]);
  public Sources: Map<number, Source> = new Map();
  public currentContextMenu?: MatMenuTrigger;
  public Loading = false;
  public Refresh: Subject<boolean> = new Subject();
  public RefreshSources: Subject<boolean> = new Subject();
  public AddingAdditionalSource = false;
  public SeriesRefreshed: Map<number, boolean> = new Map();
  public HideChannels: Subject<boolean> = new Subject();
  public CustomSourceIds: Set<number> = new Set();
  public XtreamSourceIds: Set<number> = new Set();
  public ModalRef?: NgbModalRef;
  public Watched_epgs: Set<string> = new Set();
  public LoadingNotification: boolean = false;
  public AppVersion?: string;
  public trayEnabled?: boolean;

  getCatalogPage(key: string): { channels: Channel[]; reachedMax: boolean } | undefined {
    const cached = this.catalogPageCache.get(key);
    if (!cached || Date.now() - cached.cachedAt > 5 * 60 * 1000) {
      this.catalogPageCache.delete(key);
      return undefined;
    }
    return { channels: cached.channels, reachedMax: cached.reachedMax };
  }

  setCatalogPage(
    key: string,
    channels: Channel[],
    reachedMax: boolean,
  ): void {
    this.catalogPageCache.delete(key);
    this.catalogPageCache.set(key, { channels, reachedMax, cachedAt: Date.now() });
    if (this.catalogPageCache.size > 20) {
      const oldestKey = this.catalogPageCache.keys().next().value;
      if (oldestKey !== undefined) this.catalogPageCache.delete(oldestKey);
    }
  }

  clearCatalogPageCache(): void {
    this.catalogPageCache.clear();
  }

  async tryIPC<T>(
    successMessage: string,
    errorMessage: string,
    action: () => Promise<T>,
  ): Promise<boolean> {
    this.Loading = true;
    let error = false;
    try {
      await action();
      this.toastr.success(successMessage);
    } catch (e) {
      this.error.handleError(e, errorMessage);
      error = true;
    }
    this.Loading = false;
    return error;
  }

  async get_epg_ids() {
    let data = await invoke("get_epg_ids");
    let set = new Set(data as Array<string>);
    this.Watched_epgs = set;
  }

  updateVersion() {
    if (this.AppVersion) localStorage.setItem(LAST_SEEN_VERSION, this.AppVersion);
  }
}
