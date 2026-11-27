import { ChangeDetectorRef } from '@angular/core';
import { Subject } from 'rxjs';
import { Channel } from '../models/channel';
import { MediaType } from '../models/mediaType';
import { ProfileComponent } from './profile.component';

describe('ProfileComponent', () => {
  let component: ProfileComponent;

  beforeEach(() => {
    component = new ProfileComponent(
      { navigateByUrl: () => Promise.resolve(true) } as any,
      { activeNavTab: new Subject(), ModalRef: undefined, Sources: new Map(), clearCatalogPageCache: () => {} } as any,
      { isPlayingEmbedded: false, isPlayingEmbedded$: new Subject(), stopPlayer: () => Promise.resolve(), clearWatchHistoryCaches: () => {}, resolveVideoCanvasId: () => 'profile-video-canvas' } as any,
      { favoriteChanged$: new Subject(), getCachedFavorites: () => [], loadFavorites: () => Promise.resolve([]), syncUnfavoritedChannels: () => {} } as any,
      { markForCheck: () => {}, detectChanges: () => {} } as ChangeDetectorRef,
      { openMovieDetail: () => {} } as any,
      { openTvDetail: () => {} } as any,
    );
  });

  it('loads favorites and profile counts when initialized without loading inactive sections', () => {
    const loadFavorites = spyOn(component, 'loadFavorites').and.resolveTo();
    const loadProfileCounts = spyOn(component, 'loadProfileCounts').and.resolveTo();
    const loadHistory = spyOn(component, 'loadHistory');
    const loadHidden = spyOn(component, 'loadHidden').and.callFake(async () => {
      component.hiddenLoaded = true;
    });

    component.ngOnInit();

    expect(loadFavorites).toHaveBeenCalledWith(true);
    expect(loadProfileCounts).toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(loadHidden).not.toHaveBeenCalled();
  });

  it('loads an inactive section only once and handles unhide/history removal without id collisions', () => {
    const loadHidden = spyOn(component, 'loadHidden').and.callFake(async () => {
      component.hiddenLoaded = true;
    });
    spyOn(component, 'loadProfileCounts').and.resolveTo();

    component.setSection('hidden');
    component.setSection('hidden');
    expect(loadHidden).toHaveBeenCalledTimes(1);

    component.hiddenChannels = [
      { id: 7, name: 'Archived Movies', media_type: MediaType.group } as Channel,
      { id: 7, name: 'Movie With Same Id', media_type: MediaType.movie } as Channel,
    ];
    component.onChannelUnhidden({ id: 7, media_type: MediaType.group } as Channel);
    expect(component.hiddenChannels.map((item) => item.name)).toEqual(['Movie With Same Id']);

    component.historyChannels = [
      { id: 12, name: 'Live News', media_type: MediaType.livestream } as Channel,
      { id: 13, name: 'Action Movie', media_type: MediaType.movie } as Channel,
    ];
    component.onRemovedFromHistory({ id: 12, media_type: MediaType.livestream } as Channel);
    expect(component.historyChannels.map((item) => item.name)).toEqual(['Action Movie']);
  });

  it('toggles selection without id collision, selects all loaded keys, and clears on tab or filter change', () => {
    spyOn(component, 'loadFavorites').and.resolveTo();
    spyOn(component, 'loadHistory').and.resolveTo();

    component.activeSection = 'hidden';
    component.hiddenChannels = [
      { id: 5, name: 'Hidden Movie', media_type: MediaType.movie } as Channel,
      { id: 5, name: 'Hidden Group', media_type: MediaType.group } as Channel,
    ];

    component.toggleSelectionMode();
    expect(component.selectionMode).toBeTrue();

    component.toggleItemSelection(component.hiddenChannels[0]);
    expect(component.isSelected(component.hiddenChannels[0])).toBeTrue();
    expect(component.isSelected(component.hiddenChannels[1])).toBeFalse();

    component.selectAllLoaded();
    expect(Array.from(component.selectedKeys)).toEqual(['1:5', '3:5']);

    component.setHiddenMediaType(MediaType.movie);
    expect(component.selectedCount).toBe(0);

    component.selectAllLoaded();
    component.setSection('history');
    expect(component.selectionMode).toBeFalse();
    expect(component.selectedCount).toBe(0);
  });
});
