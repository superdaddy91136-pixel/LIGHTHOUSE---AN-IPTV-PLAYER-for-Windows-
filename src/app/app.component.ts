import { Component, HostListener } from "@angular/core";
import { Router, NavigationEnd } from "@angular/router";
import { filter } from "rxjs/operators";
import { MemoryService } from "./memory.service";
import { AmbientBackgroundService } from "./services/ambient-background.service";
import { SplashScreenService } from "./services/splash-screen.service";
import { AppPreferencesService } from "./services/app-preferences.service";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  title = "open-tv";
  unlockPinInput = "";
  unlockPinError = "";
  unlockingPin = false;

  constructor(
    public router: Router,
    public memory: MemoryService,
    private ambientBackground: AmbientBackgroundService,
    public splashScreen: SplashScreenService,
    public appPreferences: AppPreferencesService,
  ) {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        const url = e.urlAfterRedirects || e.url;
        if (url.includes('/settings') || url.includes('/profile') || url.includes('/setup')) {
          this.ambientBackground.resetToDefault('route-' + url);
          this.splashScreen.dismiss('route-' + url);
        }
      });
  }

  @HostListener("document:contextmenu", ["$event"])
  onRightClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (this.isInsideMenuTrigger(target)) {
      return;
    }
    event.preventDefault();
  }

  private isInsideMenuTrigger(element: HTMLElement): boolean {
    return !!element.closest("[mat-menu-trigger-for], [matMenuTriggerFor]");
  }

  async submitUnlockPin(): Promise<void> {
    if (this.unlockingPin) return;
    const pin = this.unlockPinInput.trim();
    if (!pin) {
      this.unlockPinError = "Enter your PIN to unlock.";
      return;
    }
    this.unlockingPin = true;
    this.unlockPinError = "";
    try {
      const ok = await this.appPreferences.unlockWithPin(pin);
      if (ok) {
        this.unlockPinInput = "";
      } else {
        this.unlockPinError = "Incorrect PIN. Try again.";
      }
    } finally {
      this.unlockingPin = false;
    }
  }

  showNavBar(): boolean {
    if (this.router.url === "/setup" && !this.memory.AddingAdditionalSource && this.memory.Sources.size === 0) {
      return false;
    }
    return true;
  }
}
