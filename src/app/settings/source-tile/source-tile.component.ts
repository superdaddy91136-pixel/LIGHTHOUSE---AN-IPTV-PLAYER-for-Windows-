import { ChangeDetectorRef, Component, EventEmitter, Input, NgZone, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from "@angular/core";
import { Source } from "../../models/source";
import { SourceType } from "../../models/sourceType";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { ToastrService } from "ngx-toastr";
import { ErrorService } from "../../error.service";
import { MemoryService } from "../../memory.service";
import { EditChannelModalComponent } from "../../edit-channel-modal/edit-channel-modal.component";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { EditGroupModalComponent } from "../../edit-group-modal/edit-group-modal.component";
import { ImportModalComponent } from "../../import-modal/import-modal.component";
import { open, save } from "@tauri-apps/plugin-dialog";
import { CHANNEL_EXTENSION, FAVS_BACKUP, PLAYLIST_EXTENSION } from "../../models/extensions";
import { sanitizeFileName } from "../../utils";
import { SourceContentCounts } from "../../models/sourceContentCounts";
import { SourceRefreshProgress } from "../../models/sourceRefreshProgress";
import { SourceDeviceRefreshStatus } from "../../models/sourceRefreshStatus";
import { Subscription } from "rxjs";

@Component({
  selector: "app-source-tile",
  templateUrl: "./source-tile.component.html",
  styleUrl: "./source-tile.component.css",
})
export class SourceTileComponent implements OnInit, OnChanges, OnDestroy {
  @Input("source")
  source?: Source;
  @Input("expiry")
  expiry?: number;
  @Output() sourceDeleted = new EventEmitter<number>();
  showUsername = false;
  showPassword = false;
  loading = false;
  counts?: SourceContentCounts;
  countsLoading = true;
  private refreshSub?: Subscription;
  sourceTypeEnum = SourceType;
  editing = false;
  editableSource: Source = {};
  defaultUserAgent = "Fred TV";

  refreshing = false;
  refreshSuccess = false;
  refreshError = false;
  errorMessage = "";
  progress?: SourceRefreshProgress;
  private unlistenProgress?: UnlistenFn;
  private unlistenStatusChanged?: UnlistenFn;
  deviceRefreshStatus?: SourceDeviceRefreshStatus;
  private completeTimeout?: any;

  constructor(
    public memory: MemoryService,
    private modal: NgbModal,
    private ngZone: NgZone,
    private toastr: ToastrService,
    private errorService: ErrorService,
    private cdr: ChangeDetectorRef,
  ) { }

  async ngOnInit(): Promise<void> {
    this.loadCounts();
    this.refreshSub = this.memory.RefreshSources.subscribe(() => {
      this.loadCounts();
    });
    await this.setupProgressListener();
        await this.setupStatusListener();
        this.loadDeviceRefreshStatus();
  }

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    if (changes['source']) {
      if (!changes['source'].firstChange) {
        this.loadCounts();
      }
      const prev = changes['source'].previousValue as Source | undefined;
      const curr = changes['source'].currentValue as Source | undefined;
      if (prev?.id !== curr?.id) {
        await this.setupProgressListener();
        await this.setupStatusListener();
        this.loadDeviceRefreshStatus();
      }
    }
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
    if (this.unlistenProgress) {
      this.unlistenProgress();
      this.unlistenProgress = undefined;
    }
    if (this.unlistenStatusChanged) {
      this.unlistenStatusChanged();
      this.unlistenStatusChanged = undefined;
    }
    if (this.completeTimeout) {
      clearTimeout(this.completeTimeout);
      this.completeTimeout = undefined;
    }
  }

  private async setupProgressListener(): Promise<void> {
    if (this.unlistenProgress) {
      this.unlistenProgress();
      this.unlistenProgress = undefined;
    }
    if (this.unlistenStatusChanged) {
      this.unlistenStatusChanged();
      this.unlistenStatusChanged = undefined;
    }
    if (!this.source?.id) return;

    try {
      this.unlistenProgress = await listen<SourceRefreshProgress>(
        `source-refresh-progress-${this.source.id}`,
        (event) => {
          this.ngZone.run(() => {
            this.handleProgressEvent(event.payload);
          });
        },
      );
    } catch (err) {
      console.warn("Failed to listen for source refresh progress", this.source.id, err);
    }
  }

  private handleProgressEvent(payload: SourceRefreshProgress): void {
    if (payload.source_id !== this.source?.id) return;

    if (payload.error) {
      this.refreshing = false;
      this.refreshSuccess = false;
      this.refreshError = true;
      this.errorMessage = payload.error;
      this.progress = payload;
      this.loadCounts();
      this.cdr.markForCheck();
      return;
    }

    this.progress = payload;

    if (payload.stage === "complete") {
      this.refreshSuccess = true;
      this.refreshError = false;
      this.loadCounts();
      if (this.completeTimeout) {
        clearTimeout(this.completeTimeout);
      }
      this.completeTimeout = setTimeout(() => {
        this.ngZone.run(() => {
          this.refreshing = false;
          this.refreshSuccess = false;
          this.progress = undefined;
          this.cdr.markForCheck();
        });
      }, 1800);
    } else {
      if (!this.refreshing) {
        this.refreshing = true;
        this.refreshSuccess = false;
        this.refreshError = false;
      }
    }
    this.cdr.markForCheck();
  }

  get displayPercent(): number | null {
    if (this.refreshSuccess) return 100;
    if (
      !this.progress ||
      this.progress.indeterminate ||
      this.progress.percent === null ||
      this.progress.percent === undefined
    ) {
      return null;
    }
    return Math.min(100, Math.max(0, Math.round(this.progress.percent)));
  }

  get progressStatusText(): string {
    if (this.refreshError) {
      return this.errorMessage || "Refresh failed";
    }
    if (this.refreshSuccess) {
      return "Refresh complete";
    }
    return this.progress?.stage_label || "Refreshing...";
  }

  async loadCounts(): Promise<void> {
    if (!this.source?.id) {
      this.counts = { live: 0, movies: 0, series: 0 };
      this.countsLoading = false;
      return;
    }
    this.countsLoading = true;
    try {
      this.counts = await invoke<SourceContentCounts>("get_source_content_counts", {
        sourceId: this.source.id,
      });
    } catch (err) {
      console.warn("Failed to load content counts for source", this.source.id, err);
      this.counts = { live: 0, movies: 0, series: 0 };
    } finally {
      this.countsLoading = false;
      this.cdr.markForCheck();
    }
  }

  private async setupStatusListener(): Promise<void> {
    if (this.unlistenStatusChanged) {
      this.unlistenStatusChanged();
      this.unlistenStatusChanged = undefined;
    }
    if (!this.source?.id) return;

    try {
      this.unlistenStatusChanged = await listen<SourceDeviceRefreshStatus>(
        "source-refresh-status-changed",
        (event) => {
          if (event.payload && event.payload.source_id === this.source?.id) {
            this.ngZone.run(() => {
              this.deviceRefreshStatus = event.payload;
              this.cdr.markForCheck();
            });
          }
        },
      );
    } catch (err) {
      console.warn("Failed to listen for source refresh status changed", this.source.id, err);
    }
  }

  async loadDeviceRefreshStatus(): Promise<void> {
    if (!this.source?.id) return;
    try {
      this.deviceRefreshStatus = await invoke<SourceDeviceRefreshStatus>(
        "get_source_refresh_status",
        { sourceId: this.source.id },
      );
      this.cdr.markForCheck();
    } catch (err) {
      console.warn("Failed to load device refresh status for source", this.source.id, err);
    }
  }

  isDue(timestamp?: number): boolean {
    if (!timestamp) return true;
    return Date.now() >= timestamp * 1000;
  }

  get_source_type_name() {
    if (!this.source) return null;
    return SourceType[this.source.source_type!];
  }

  async refresh(): Promise<void> {
    if (this.refreshing || !this.source) return;

    if (this.source?.source_type == SourceType.Xtream) {
      this.memory.SeriesRefreshed.clear();
    }

    if (this.completeTimeout) {
      clearTimeout(this.completeTimeout);
      this.completeTimeout = undefined;
    }

    this.refreshing = true;
    this.refreshSuccess = false;
    this.refreshError = false;
    this.errorMessage = "";
    this.progress = {
      source_id: this.source.id || 0,
      stage: "connecting",
      stage_label: "Connecting to provider...",
      percent: 0,
      indeterminate: true,
    };
    this.cdr.markForCheck();

    try {
      await invoke("refresh_source", { source: this.source });
      this.refreshSuccess = true;
      this.refreshError = false;
      this.toastr.success("Successfully updated source");
      this.memory.RefreshSources.next(true);
      await this.loadCounts();
      await this.loadDeviceRefreshStatus();
      if (this.completeTimeout) {
        clearTimeout(this.completeTimeout);
      }
      this.completeTimeout = setTimeout(() => {
        this.ngZone.run(() => {
          this.refreshing = false;
          this.refreshSuccess = false;
          this.progress = undefined;
          this.cdr.markForCheck();
        });
      }, 1800);
    } catch (err: any) {
      const msg = typeof err === "string" ? err : err?.message || "Failed to refresh source";
      this.refreshing = false;
      this.refreshSuccess = false;
      this.refreshError = true;
      this.errorMessage = msg;
      this.errorService.handleError(err, "Failed to refresh source");
      await this.loadCounts();
      await this.loadDeviceRefreshStatus();
      this.memory.RefreshSources.next(true);
    } finally {
      this.cdr.markForCheck();
    }
  }

  retryRefresh(): void {
    this.refreshError = false;
    this.errorMessage = "";
    this.refresh();
  }

  async delete() {
    if (this.refreshing || !this.source?.id) return;
    const sourceId = this.source.id;
    const error = await this.memory.tryIPC("Successfully deleted source", "Failed to delete source", () =>
      invoke("delete_source", { id: sourceId }),
    );
    if (!error) {
      this.sourceDeleted.emit(sourceId);
      this.memory.RefreshSources.next(true);
    }
  }

  async toggleEnabled() {
    if (this.refreshing) return;
    await this.memory.tryIPC("Successfully toggled source", "Failed to toggle source", () =>
      invoke("toggle_source", { value: !this.source?.enabled, sourceId: this.source?.id }),
    );
    this.memory.RefreshSources.next(true);
  }

  async addCustomChannel() {
    this.memory.ModalRef = this.modal.open(EditChannelModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomChannelModal";
    this.memory.ModalRef.componentInstance.channel.data.source_id = this.source?.id;
  }

  async addCustomGroup() {
    this.memory.ModalRef = this.modal.open(EditGroupModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "EditCustomGroupModal";
    this.memory.ModalRef.componentInstance.group.source_id = this.source?.id;
  }

  async import() {
    this.memory.ModalRef = this.modal.open(ImportModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    this.memory.ModalRef.componentInstance.name = "ImportModalComponent";
    this.memory.ModalRef.componentInstance.source_id = this.source?.id;
  }

  async share() {
    let file = await save({
      canCreateDirectories: true,
      title: "Select where to export custom source",
      defaultPath: sanitizeFileName(this.source?.name!) + PLAYLIST_EXTENSION,
    });
    if (file) {
      await this.memory.tryIPC(
        `Successfully exported source in ${file}`,
        "Failed to export source",
        () => invoke("share_custom_source", { source: this.source, path: file }),
      );
    }
  }

  edit() {
    if (this.refreshing) return;
    this.editableSource = { ...this.source };
    this.editing = true;
  }

  async save() {
    await this.memory.tryIPC("Successfully saved changes", "Failed to save changes", async () => {
      this.editableSource.user_agent = this.editableSource.user_agent?.trim();
      this.editableSource.stream_user_agent = this.editableSource.stream_user_agent?.trim();
      if (this.editableSource.user_agent == "") this.editableSource.user_agent = undefined;
      if (this.editableSource.stream_user_agent == "")
        this.editableSource.stream_user_agent = undefined;
      await invoke("update_source", { source: this.editableSource });
      this.source = this.editableSource;
      this.editing = false;
      this.editableSource = {};
    });
  }

  async browse() {
    const file = await open({
      multiple: false,
      directory: false,
      title: "Select a new m3u file for source",
      filters: [{ name: "extension", extensions: ["m3u", "m3u8"] }],
    });
    if (file) {
      this.editableSource.url = file;
    }
  }

  cancel() {
    this.editableSource = {};
    this.editing = false;
  }

  async backupFavs() {
    const file = await save({
      canCreateDirectories: true,
      title: "Select where to save favorites",
      defaultPath: `${sanitizeFileName(this.source?.name!)}_favs${FAVS_BACKUP}`,
    });
    if (file) {
      await this.memory.tryIPC(
        "Successfully saved favorites backup",
        "Failed to save favorites backup",
        async () => {
          await invoke("backup_favs", { id: this.source?.id, path: file });
        },
      );
    }
  }

  async restoreFavs() {
    const file = await open({
      canCreateDirectories: false,
      title: "Select a favorites backup",
      directory: false,
      multiple: false,
      filters: [{ name: "extension", extensions: ["otvf"] }],
    });
    if (file) {
      await this.memory.tryIPC(
        "Successfully saved favorites backup",
        "Failed to save favorites backup",
        async () => {
          await invoke("restore_favs", { id: this.source?.id, path: file });
        },
      );
    }
  }
}
