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
      { activeNavTab: new Subject(), ModalRef: undefined } as any,
      { isPlayingEmbedded: false, isPlayingEmbedded$: new Subject(), stopPlayer: () => Promise.resolve(), clearWatchHistoryCaches: () => {} } as any,
      { favoriteChanged$: new Subject(), getCachedFavorites: () => [], loadFavorites: () => Promise.resolve([]) } as any,
      { markForCheck: () => {}, detectChanges: () => {} } as ChangeDetectorRef,
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
});
