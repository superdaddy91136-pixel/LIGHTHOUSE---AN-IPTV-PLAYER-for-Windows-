import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  Renderer2,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { MatMenuTrigger } from "@angular/material/menu";
import { Channel } from "../models/channel";
import { MemoryService } from "../memory.service";
import { MediaType } from "../models/mediaType";
import { invoke } from "@tauri-apps/api/core";
import { ToastrService } from "ngx-toastr";
import { ErrorService } from "../error.service";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { EditChannelModalComponent } from "../edit-channel-modal/edit-channel-modal.component";
import { EditGroupModalComponent } from "../edit-group-modal/edit-group-modal.component";
import { DeleteGroupModalComponent } from "../delete-group-modal/delete-group-modal.component";
import { EpgModalComponent } from "../epg-modal/epg-modal.component";
import { EPG } from "../models/epg";
import { RestreamModalComponent } from "../restream-modal/restream-modal.component";
import { DownloadService } from "../download.service";
import { Download } from "../models/download";
import { Subscription, take } from "rxjs";
import { save } from "@tauri-apps/plugin-dialog";
import { CHANNEL_EXTENSION, GROUP_EXTENSION, RECORD_EXTENSION } from "../models/extensions";
import { getDateFormatted, getExtension, sanitizeFileName } from "../utils";
import { NodeType, fromMediaType } from "../models/nodeType";

import { ViewMode } from "../models/viewMode";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { MovieDetailService } from "../services/movie-detail.service";
import { TvDetailService } from "../services/tv-detail.service";
import { PinService } from "../services/pin.service";
import { EmbeddedPlayerService } from "../services/embedded-player.service";
import { NavTab } from "../models/navTab";
import { cleanMediaTitle } from "../utils/media-presentation";

/**
 * Concurrency-limited background EPG queue manager.
 * Prevents flooding network and CPU with 50-100 simultaneous requests.
 * Caches program info and prioritizes currently visible channels.
 */
export class EpgQueueManager {
  private static cache = new Map<number, { epg: EPG | null; timestamp: number }>();
  private static inFlight = new Map<number, Promise<EPG | null>>();
  private static queue: { channel: Channel; resolve: (val: EPG | null) => void }[] = [];
  private static activeCount = 0;
  private static readonly MAX_CONCURRENT = 2;
  private static readonly CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  static getCached(channelId: number): EPG | null | undefined {
    const entry = this.cache.get(channelId);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.CACHE_TTL_MS) {
      this.cache.delete(channelId);
      return undefined;
    }
    return entry.epg;
  }

  static requestEpg(channel: Channel): Promise<EPG | null> {
    if (!channel.id) return Promise.resolve(null);
    const cached = this.getCached(channel.id);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    if (this.inFlight.has(channel.id)) {
      return this.inFlight.get(channel.id)!;
    }

    const promise = new Promise<EPG | null>((resolve) => {
      // Prioritize recently requested (LIFO so visible channels jump ahead of scrolled-past ones)
      this.queue.unshift({ channel, resolve });
      this.processNext();
    });

    this.inFlight.set(channel.id, promise);
    return promise;
  }

  static clearQueue(): void {
    this.queue = [];
  }

  private static processNext(): void {
    if (this.activeCount >= this.MAX_CONCURRENT || this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    this.activeCount++;
    const { channel, resolve } = item;

    invoke('get_epg', { channel })
      .then((data: any) => {
        const epgList = (data as EPG[]) || [];
        let current: EPG | null = null;
        if (epgList.length > 0) {
          const now = Math.floor(Date.now() / 1000);
          current =
            epgList.find((p) => p.now_playing) ||
            epgList.find((p) => p.start_timestamp <= now) ||
            epgList[0] ||
            null;
        }
        this.cache.set(channel.id!, { epg: current, timestamp: Date.now() });
        this.inFlight.delete(channel.id!);
        resolve(current);
      })
      .catch(() => {
        this.cache.set(channel.id!, { epg: null, timestamp: Date.now() });
        this.inFlight.delete(channel.id!);
        resolve(null);
      })
      .finally(() => {
        this.activeCount--;
        this.processNext();
      });
  }
}

@Component({
  selector: "app-channel-tile",
  templateUrl: "./channel-tile.component.html",
  styleUrl: "./channel-tile.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelTileComponent implements OnInit, OnDestroy, AfterViewInit, OnChanges {
  constructor(
    public memory: MemoryService,
    private toastr: ToastrService,
    private error: ErrorService,
    private modal: NgbModal,
    private el: ElementRef,
    private renderer: Renderer2,
    private download: DownloadService,
    private movieDetailService: MovieDetailService,
    private tvDetailService: TvDetailService,
    public pinService: PinService,
    public embeddedPlayer: EmbeddedPlayerService,
    private cdr: ChangeDetectorRef,
  ) { }
  @Input() channel?: Channel;
  @Input() id!: number;
  @Input() viewMode: number = 0;
  @Input() isLiveTvCard?: boolean;
  @Output() unhidden = new EventEmitter<Channel>();
  @ViewChild(MatMenuTrigger, { static: true }) matMenuTrigger!: MatMenuTrigger;
  menuTopLeftPosition = { x: 0, y: 0 };
  showImage: boolean = true;
  starting: boolean = false;
  alreadyExistsInFav = false;
  alreadyHidden = false;
  downloading = false;
  mediaTypeEnum = MediaType;
  viewModeEnum = ViewMode;
  subscriptions: Subscription[] = [];
  fade = false;
  nowPlayingEpg?: EPG;

  // Precomputed properties to avoid thousands of template method calls per second
  cleanTitle: string = '';
  sourceName: string = '';
  epgTimeDisplay: string = '';
  epgProgress: number = 0;
  isCard: boolean = true;
  isLivestreamChannel: boolean = false;
  isLiveTvMode: boolean = false;
  isGroupTile: boolean = false;
  isSeriesTile: boolean = false;
  isMovieTile: boolean = false;

  static brokenImages: Set<string> = new Set();
  static epgCache: Map<number, EPG | null> = new Map();
  static epgInFlight: Set<number> = new Set();

  ngOnInit(): void {
    this.updateChannelState();
    if ((this.isLivestreamChannel || this.isLiveTvMode) && !this.isGroupTile && this.showEPG()) {
      this.loadNowPlayingEPG();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    const chChange = changes['channel'];
    if (chChange) {
      const prev = chChange.previousValue as Channel | undefined;
      const curr = chChange.currentValue as Channel | undefined;

      this.updateChannelState();

      // If channel ID is identical, keep existing EPG and image state intact (prevents layout shifts & flickering)
      if (prev && curr && prev.id === curr.id) {
        this.cdr.markForCheck();
        return;
      }

      // Channel ID changed or initial assignment
      if (curr?.id) {
        const cached = EpgQueueManager.getCached(curr.id);
        if (cached !== undefined) {
          this.nowPlayingEpg = cached || undefined;
          this.updateEpgDisplay();
        } else {
          this.nowPlayingEpg = undefined;
          this.epgTimeDisplay = '';
          this.epgProgress = 0;
          if ((this.isLivestreamChannel || this.isLiveTvMode) && !this.isGroupTile && this.showEPG()) {
            this.loadNowPlayingEPG();
          }
        }
      } else {
        this.nowPlayingEpg = undefined;
        this.epgTimeDisplay = '';
        this.epgProgress = 0;
      }
    }
    this.cdr.markForCheck();
  }

  private updateChannelState(): void {
    if (!this.channel) {
      this.cleanTitle = '';
      this.sourceName = '';
      this.isCard = true;
      this.isLivestreamChannel = false;
      this.isLiveTvMode = false;
      this.isGroupTile = false;
      this.isSeriesTile = false;
      this.isMovieTile = false;
      return;
    }

    this.cleanTitle = cleanMediaTitle(this.channel.name || '');
    this.sourceName = this.channel.source_id ? this.memory.Sources.get(this.channel.source_id)?.name || '' : '';
    this.isCard = this.memory.activeNavTab.value !== NavTab.Settings;
    this.isLivestreamChannel = this.channel.media_type === MediaType.livestream;
    this.isLiveTvMode = !!this.isLiveTvCard || this.memory.activeNavTab.value === NavTab.LiveTV;
    this.isGroupTile = this.channel.media_type === MediaType.group;
    this.isSeriesTile = this.channel.media_type === MediaType.serie;
    this.isMovieTile = this.channel.media_type === MediaType.movie;

    if (this.channel.image && ChannelTileComponent.brokenImages.has(this.channel.image)) {
      this.showImage = false;
    } else {
      this.showImage = true;
    }
  }

  ngAfterViewInit(): void {
    this.getExistingDownload();
  }

  setDownloadGradient(progress: number) {
    let element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    let background = `linear-gradient(to right, green ${progress}%, #343a40 ${progress}%)`;
    this.renderer.setStyle(element, "background", background);
  }

  clearDownloadGradient() {
    let element = this.el.nativeElement.querySelector(`#tile-${this.id}`);
    let background = "#343a40";
    this.renderer.setStyle(element, "background", background);
  }

  async onPlayClick(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (this.starting) return;
    if (this.isGroup()) {
      this.click();
      return;
    }
    if (this.channel) {
      this.starting = true;
      this.cdr.markForCheck();
      try {
        const canvas = this.embeddedPlayer.resolveVideoCanvasId();
        await this.embeddedPlayer.playMediaDirectly(this.channel, canvas);
      } catch (e) {
        this.error.handleError(e, 'Failed to start playback');
      } finally {
        this.starting = false;
        this.cdr.markForCheck();
      }
    }
  }

  async click(record = false) {
    if (this.starting === true) {
      try {
        await invoke("cancel_play", { sourceId: this.channel?.source_id, channelId: this.channel?.id });
      } catch (e) {
        this.error.handleError(e);
      }
      return;
    }
    if (!record && this.channel?.media_type === MediaType.serie) {
      this.tvDetailService.openTvDetail(this.channel);
      return;
    }
    if (
      this.channel?.media_type == MediaType.group ||
      this.channel?.media_type == MediaType.season
    ) {
      this.memory.SetNode.next({
        id: this.channel.id!,
        name: this.channel.name!,
        type: fromMediaType(this.channel.media_type),
        sourceId: this.channel.source_id,
      });
      return;
    }
    const isEpisode = !!(this.channel?.season_id != null || this.channel?.episode_num != null);
    if (!record && this.channel?.media_type === MediaType.movie && !isEpisode) {
      this.movieDetailService.openMovieDetail(this.channel);
      return;
    }
    let file = undefined;
    if (record && (this.memory.IsContainer || this.memory.AlwaysAskSave)) {
      file = await save({
        canCreateDirectories: true,
        title: "Select where to save recording",
        defaultPath: `${sanitizeFileName(this.channel?.name!)}_${getDateFormatted()}${RECORD_EXTENSION}`,
      });
      if (!file) return;
    }
    this.starting = true;
    this.cdr.markForCheck();
    this.memory.SetFocus.next(this.id);
    const playChannel = {
      ...this.channel,
      media_type: this.channel?.media_type,
      favorite: !!this.channel?.favorite,
    };
    invoke("add_last_watched", { id: this.channel?.id }).catch((e) => {
      console.error(e);
      this.error.handleError(e);
    });

    if (!record && (this.channel?.media_type === MediaType.livestream || this.isLiveTv())) {
      try {
        const canvas = this.embeddedPlayer.resolveVideoCanvasId();
        await this.embeddedPlayer.startPlayer(playChannel, canvas, {
          title: cleanMediaTitle(this.channel?.name || 'Live TV'),
          mode: 'live',
        });
      } catch (err) {
        console.warn('Failed to start embedded live player:', err);
        this.error.handleError(err);
      }
      this.starting = false;
      this.cdr.markForCheck();
      return;
    }

    if (!record) {
      try {
        const mode = isEpisode ? 'episode' : 'movie';
        const canvas = this.embeddedPlayer.resolveVideoCanvasId();
        await this.embeddedPlayer.startPlayer(playChannel, canvas, {
          title: cleanMediaTitle(this.channel?.name || (isEpisode ? 'Episode' : 'Video')),
          mode,
        });
      } catch (err) {
        console.warn('Failed to start embedded player:', err);
        this.error.handleError(err);
      }
      this.starting = false;
      this.cdr.markForCheck();
      return;
    }

    try {
      await invoke("play", { channel: playChannel, record: true, recordPath: file });
    } catch (e) {
      this.error.handleError(e);
    }
    this.starting = false;
    this.cdr.markForCheck();
  }

  onRightClick(event: MouseEvent) {
    if (this.channel?.media_type == MediaType.season) return;
    this.alreadyExistsInFav = this.channel!.favorite!;
    this.alreadyHidden = this.channel!.hidden!;
    this.downloading = this.isDownloading();
    event.preventDefault();
    this.menuTopLeftPosition.x = event.clientX;
    this.menuTopLeftPosition.y = event.clientY;
    if (this.memory.currentContextMenu?.menuOpen) this.memory.currentContextMenu.closeMenu();
    this.memory.currentContextMenu = this.matMenuTrigger;
    this.matMenuTrigger.openMenu();
  }

  isPinned(): boolean {
    if (!this.channel) return false;
    return this.pinService.isPinned(this.channel, this.memory.activeNavTab.value);
  }

  canPin(): boolean {
    if (!this.channel || this.channel.media_type === MediaType.season) return false;
    const tab = this.memory.activeNavTab.value;
    return (
      tab === NavTab.LiveTV ||
      tab === NavTab.Movies ||
      tab === NavTab.TVShows ||
      this.channel.media_type === MediaType.livestream ||
      this.channel.media_type === MediaType.movie ||
      this.channel.media_type === MediaType.serie ||
      this.channel.media_type === MediaType.group
    );
  }

  togglePin(): void {
    if (!this.channel) return;
    const tab = this.pinService.getTabForChannel(this.channel, this.memory.activeNavTab.value);
    const wasPinned = this.isPinned();
    this.pinService.togglePin(this.channel, tab);
    const name = cleanMediaTitle(this.channel.name || '');
    if (wasPinned) {
      this.toastr.success(`Unpinned "${name}"`);
    } else {
      this.toastr.success(`Pinned "${name}"`);
    }
    this.cdr.markForCheck();
  }

  onError(event: Event) {
    this.showImage = false;
    if (this.channel?.image) {
      ChannelTileComponent.brokenImages.add(this.channel.image);
    }
    this.cdr.markForCheck();
  }

  async favorite() {
    let call = "favorite_channel";
    const wasFavorite = this.channel!.favorite;
    if (wasFavorite) {
      call = "unfavorite_channel";
    }
    try {
      await invoke(call, { channelId: this.channel!.id });
      this.channel!.favorite = !wasFavorite;
      if (this.viewMode == ViewMode.Favorites) {
        this.fade = !!wasFavorite;
      }
      this.memory.clearCatalogPageCache();
      this.cdr.markForCheck();
    } catch (e) {
      this.error.handleError(e, `Failed to add/remove "${this.channel?.name}" to/from favorites`);
    }
  }

  async removeFromHistory() {
    try {
      await invoke("remove_from_history", { id: this.channel!.id });
      this.memory.Refresh.next(false);
      this.toastr.success(`Removed "${this.channel?.name}" from history`);
      this.cdr.markForCheck();
    } catch (e) {
      this.error.handleError(e, `Failed to remove "${this.channel?.name}" from history`);
    }
  }

  async unhideItem(event?: MouseEvent) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    const isGroup = this.channel?.media_type === MediaType.group;
    const command = isGroup ? "hide_group" : "hide_channel";
    const args = { id: this.channel!.id, hidden: false };

    try {
      await invoke(command, args);
      this.channel!.hidden = false;
      this.unhidden.emit(this.channel!);
      this.memory.clearCatalogPageCache();
      this.toastr.success(`Unhidden "${this.channel?.name}"`);
      this.cdr.markForCheck();
    } catch (e) {
      this.error.handleError(e, `Failed to unhide "${this.channel?.name}"`);
    }
  }

  async hide() {
    const isGroup = this.channel?.media_type === MediaType.group;
    const hide = !this.channel!.hidden;

    const command = isGroup ? "hide_group" : "hide_channel";
    const args = { id: this.channel!.id, hidden: hide };

    const action = hide ? "Hidden" : "Unhidden";
    const type = isGroup ? "group " : "";
    const msg = `${action} ${type}"${this.channel?.name}"`;

    try {
      await invoke(command, args);
      this.channel!.hidden = hide;
      if (this.viewMode == ViewMode.Hidden && !hide) {
        this.unhidden.emit(this.channel!);
      }
      this.fade = this.viewMode == ViewMode.Hidden ? !hide : hide;
      this.memory.clearCatalogPageCache();
      this.toastr.success(`${msg} (updates on reload)`);
      this.cdr.markForCheck();
    } catch (e) {
      this.error.handleError(e, `Failed to hide/unhide "${this.channel?.name}"`);
    }
  }

  async record() {
    await this.click(true);
  }

  isMovie() {
    return this.channel?.media_type == MediaType.movie;
  }

  isLivestream() {
    return this.channel?.media_type == MediaType.livestream;
  }

  isGroup(): boolean {
    return this.channel?.media_type == MediaType.group;
  }

  isTvShow(): boolean {
    return this.channel?.media_type === MediaType.serie;
  }

  isLiveTv(): boolean {
    return !!this.isLiveTvCard || this.memory.activeNavTab.value === NavTab.LiveTV;
  }

  isCardMode(): boolean {
    const tab = this.memory.activeNavTab.value;
    if (tab === NavTab.Settings) {
      return false;
    }
    return true;
  }

  async loadNowPlayingEPG() {
    if (!this.channel?.id || !this.showEPG() || !this.channel.stream_id) return;
    const channelId = this.channel.id;
    try {
      const current = await EpgQueueManager.requestEpg(this.channel);
      if (this.channel?.id === channelId) {
        this.nowPlayingEpg = current || undefined;
        this.updateEpgDisplay();
        this.cdr.markForCheck();
      }
    } catch {
      // Ignored
    }
  }

  updateEpgDisplay(): void {
    if (!this.nowPlayingEpg) {
      this.epgTimeDisplay = '';
      this.epgProgress = 0;
      return;
    }
    if (this.nowPlayingEpg.start_time && this.nowPlayingEpg.end_time) {
      const start = this.extractTimeOnly(this.nowPlayingEpg.start_time);
      const end = this.extractTimeOnly(this.nowPlayingEpg.end_time);
      this.epgTimeDisplay = `${start} – ${end}`;
    } else if (this.nowPlayingEpg.start_time) {
      this.epgTimeDisplay = this.extractTimeOnly(this.nowPlayingEpg.start_time);
    } else {
      this.epgTimeDisplay = '';
    }

    if (this.nowPlayingEpg.start_timestamp) {
      const nowSec = Math.floor(Date.now() / 1000);
      const start = this.nowPlayingEpg.start_timestamp;
      if (nowSec <= start) {
        this.epgProgress = 0;
      } else {
        const defaultEnd = start + 3600;
        const elapsed = nowSec - start;
        const total = defaultEnd - start;
        this.epgProgress = Math.min(100, Math.max(5, Math.round((elapsed / total) * 100)));
      }
    } else {
      this.epgProgress = 0;
    }
  }

  private extractTimeOnly(timeStr: string): string {
    if (!timeStr) return '';
    if (timeStr.includes(',')) {
      const parts = timeStr.split(',');
      return parts[parts.length - 1].trim();
    }
    return timeStr.trim();
  }

  getCleanTitle(): string {
    return cleanMediaTitle(this.channel?.name || '');
  }

  toggleFavorite(event: MouseEvent) {
    event.stopPropagation();
    this.favorite();
  }

  isCustom(): boolean {
    return this.memory.CustomSourceIds!.has(this.channel?.source_id!);
  }

  showEPG(): boolean {
    return (
      (this.channel?.media_type == MediaType.livestream || (this.isLiveTv() && !this.isGroup())) &&
      !this.isCustom() &&
      this.memory.XtreamSourceIds.has(this.channel?.source_id!)
    );
  }

  getSourceName(): string {
    if (!this.channel?.source_id) return "";
    return this.memory.Sources.get(this.channel.source_id)?.name || "";
  }

  async showEPGModal() {
    try {
      let data: EPG[] = await invoke("get_epg", { channel: this.channel });
      if (data.length == 0) {
        this.toastr.info("No EPG data for this channel");
        return;
      }
      this.memory.ModalRef = this.modal.open(EpgModalComponent, {
        backdrop: "static",
        size: "xl",
        keyboard: false,
      });
      this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
      this.memory.ModalRef.componentInstance.epg = data;
      this.memory.ModalRef.componentInstance.name = this.channel?.name;
      this.memory.ModalRef.componentInstance.channelId = this.channel?.id;
      this.memory.ModalRef.componentInstance.sourceId = this.channel?.source_id;
    } catch (e) {
      this.error.handleError(
        e,
        "Missing stream id. Please refresh your sources (Settings -> Refresh All) to enable the EPG feature",
      );
    }
  }

  edit() {
    if (this.channel?.media_type == MediaType.group) this.edit_group();
    else {
      this.edit_channel();
    }
  }

  edit_group() {
    this.memory.ModalRef = this.modal.open(EditGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomGroupModal";
    this.memory.ModalRef.componentInstance.editing = true;
    this.memory.ModalRef.componentInstance.group = {
      id: this.channel!.id,
      name: this.channel!.name,
      image: this.channel!.image,
      source_id: this.channel!.source_id,
    };
    this.memory.ModalRef.componentInstance.originalName = this.channel!.name;
  }

  edit_channel() {
    this.memory.ModalRef = this.modal.open(EditChannelModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomChannelModal";
    this.memory.ModalRef.componentInstance.editing = true;
    this.memory.ModalRef.componentInstance.channel.data = { ...this.channel };
  }

  async share() {
    let entityName = this.channel?.media_type == MediaType.group ? "group" : "channel";
    let file = await save({
      canCreateDirectories: true,
      title: `Select where to export ${entityName}`,
      defaultPath:
        sanitizeFileName(this.channel?.name!) +
        (this.channel?.media_type == MediaType.group ? GROUP_EXTENSION : CHANNEL_EXTENSION),
    });
    if (!file) {
      return;
    }
    if (this.channel?.media_type == MediaType.group) {
      this.memory.tryIPC(
        `Successfully exported category to ${file}`,
        "Failed to export channel",
        () => invoke("share_custom_group", { group: this.channel, path: file }),
      );
    } else {
      this.memory.tryIPC(
        `Successfully exported channel to ${file}`,
        "Failed to export channel",
        () => invoke("share_custom_channel", { channel: this.channel, path: file }),
      );
    }
  }

  async delete() {
    if (this.channel?.media_type == MediaType.group) this.deleteGroup();
    else await this.deleteChannel();
  }

  async deleteGroup() {
    try {
      if (await invoke("group_not_empty", { id: this.channel?.id })) {
        this.openDeleteGroupModal();
      } else await this.deleteGroupNoReplace();
    } catch (e) {
      this.error.handleError(e);
    }
  }

  async deleteGroupNoReplace() {
    try {
      await invoke("delete_custom_group", {
        id: this.channel?.id,
        doChannelsUpdate: false,
      });
      this.memory.Refresh.next(true);
      this.error.success("Successfully deleted category");
    } catch (e) {
      this.error.handleError(e);
    }
  }

  openDeleteGroupModal() {
    this.memory.ModalRef = this.modal.open(DeleteGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "DeleteGroupModal";
    this.memory.ModalRef.componentInstance.group = { ...this.channel };
  }

  openRestreamModal() {
    this.memory.ModalRef = this.modal.open(RestreamModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.componentInstance.channel = this.channel;
    this.memory.ModalRef.componentInstance.name = "RestreamModalComponent";
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
  }

  async deleteChannel() {
    await this.memory.tryIPC("Successfully deleted channel", "Failed to delete channel", () =>
      invoke("delete_custom_channel", { id: this.channel?.id }),
    );
    this.memory.Refresh.next(true);
  }

  isDownloading() {
    return this.download.Downloads.has(this.channel!.id!.toString());
  }

  async downloadVod() {
    let file = undefined;
    if (this.memory.IsContainer || this.memory.AlwaysAskSave) {
      file = await save({
        canCreateDirectories: true,
        title: "Select where to download movie",
        defaultPath: `${sanitizeFileName(this.channel?.name!)}.${getExtension(this.channel?.url!)}`,
      });
      if (!file) {
        return;
      }
    }
    let download = await this.download.addDownload(
      this.channel!.id!.toString(),
      this.channel!,
    );
    this.downloadSubscribe(download);
    await this.download.download(download.id, file);
  }

  async cancelDownload() {
    await this.download.abortDownload(this.channel!.id!.toString());
  }

  getExistingDownload() {
    let download = this.download.Downloads.get(this.channel!.id!.toString());
    if (download) {
      this.setDownloadGradient(download.progress);
      this.downloadSubscribe(download);
    }
  }

  downloadSubscribe(download: Download) {
    let progressUpdate = download.progressUpdate.subscribe((progress) => {
      this.setDownloadGradient(progress);
      if (progress == 100) progressUpdate.unsubscribe();
    });
    this.subscriptions.push(progressUpdate);
    this.subscriptions.push(
      download.complete.pipe(take(1)).subscribe((_) => {
        progressUpdate.unsubscribe();
        this.clearDownloadGradient();
      }),
    );
  }

  async copyURL() {
    try {
      await writeText(this.channel?.url ?? "");
      this.error.success("Copied channel URL");
    }
    catch (e) {
      this.error.handleError(e);
    }
  }

  ngOnDestroy() {
    this.subscriptions.forEach((x) => x.unsubscribe());
  }
}
