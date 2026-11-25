import { Component, Input, Optional } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { EPG } from "../../models/epg";
import { MemoryService } from "../../memory.service";
import { invoke } from "@tauri-apps/api/core";
import { EPGNotify } from "../../models/epgNotify";
import { ErrorService } from "../../error.service";
import { Channel } from "../../models/channel";
import { MediaType } from "../../models/mediaType";
import { EmbeddedPlayerService } from "../../services/embedded-player.service";
import { cleanMediaTitle } from "../../utils/media-presentation";

@Component({
  selector: "app-epg-modal-item",
  templateUrl: "./epg-modal-item.component.html",
  styleUrl: "./epg-modal-item.component.css",
})
export class EpgModalItemComponent {
  constructor(
    public memory: MemoryService,
    private error: ErrorService,
    private embeddedPlayer: EmbeddedPlayerService,
    @Optional() private activeModal?: NgbActiveModal,
  ) { }
  @Input()
  epg?: EPG;
  @Input()
  name?: string;
  @Input()
  sourceId?: number;
  @Input()
  channelId?: number;
  playing: boolean = false;

  notificationOn(): boolean {
    return this.memory.Watched_epgs.has(this.epg!.epg_id);
  }

  async toggleNotification() {
    if (this.memory.LoadingNotification) return;
    this.memory.LoadingNotification = true;
    if (!this.notificationOn()) {
      try {
        await invoke("add_epg", { epg: this.epg_to_epgNotify(this.epg!) });
        this.error.success("Added notification successfully");
      } catch (e) {
        this.error.handleError(e);
      }
    } else {
      try {
        await invoke("remove_epg", { epgId: this.epg?.epg_id });
        this.error.success("Removed notification successfully");
      } catch (e) {
        this.error.handleError(e);
      }
    }
    await this.memory.get_epg_ids();
    this.memory.LoadingNotification = false;
  }

  epg_to_epgNotify(epg: EPG): EPGNotify {
    return {
      channel_name: this.name!,
      epg_id: epg.epg_id,
      start_timestamp: epg.start_timestamp,
      title: epg.title,
    };
  }

  async timeshift() {
    if (this.playing) return;
    this.playing = true;
    let channel: Channel = {
      id: -1,
      url: this.epg?.timeshift_url,
      name: this.epg?.title,
      media_type: MediaType.movie,

      favorite: false,
      source_id: this.sourceId,
    };
    try {
      if (this.activeModal) {
        try {
          this.activeModal.dismiss();
        } catch {}
      }
      await this.embeddedPlayer.startPlayer(channel, this.embeddedPlayer.resolveVideoCanvasId(), {
        title: cleanMediaTitle(this.epg?.title || 'Catchup'),
        mode: 'movie',
      });
    } catch (e) {
      console.error(e);
      this.error.handleError(e);
    } finally {
      this.playing = false;
    }
  }
}
