import { Component, HostListener } from "@angular/core";
import { Router, NavigationEnd } from "@angular/router";
import { filter } from "rxjs/operators";
import { MemoryService } from "./memory.service";
import { AmbientBackgroundService } from "./services/ambient-background.service";
import { SplashScreenService } from "./services/splash-screen.service";

@Component({
  selector: "app-root",
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent {
  title = "open-tv";

  constructor(
    public router: Router,
    public memory: MemoryService,
    private ambientBackground: AmbientBackgroundService,
    public splashScreen: SplashScreenService
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

  showNavBar(): boolean {
    if (this.router.url === "/setup" && !this.memory.AddingAdditionalSource && this.memory.Sources.size === 0) {
      return false;
    }
    return true;
  }
}
