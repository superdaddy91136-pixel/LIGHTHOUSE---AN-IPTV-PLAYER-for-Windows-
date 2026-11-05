import { Injectable } from '@angular/core';
import { NavTab } from '../models/navTab';
import { Channel } from '../models/channel';

export interface UniversalSearchResults {
  channels: Channel[];
  movies: Channel[];
  tvShows: Channel[];
  categories: Channel[];
}

export interface TabSearchState {
  query: string;
  searchKeyword: string;
  rawSearchResults: UniversalSearchResults;
  searchResults: UniversalSearchResults;
  allSearchResultsList?: Channel[];
  displayedSearchResults?: Channel[];
  searchTypeFilter: 'all' | 'movies' | 'tv' | 'live';
  searchSortBy: 'relevance' | 'provider' | 'alphabetical';
  searchSortOrder: 'asc' | 'desc';
  isSearchExpanded: boolean;
  scrollPosition?: number;
  horizontalScrollPositions?: Record<string, number>;
}

@Injectable({
  providedIn: 'root',
})
export class SearchStateService {
  private tabStates: Map<NavTab, TabSearchState> = new Map();

  public getSearchState(tab: NavTab): TabSearchState | undefined {
    return this.tabStates.get(tab);
  }

  public setSearchState(tab: NavTab, state: TabSearchState): void {
    this.tabStates.set(tab, state);
  }

  public clearSearchState(tab: NavTab): void {
    this.tabStates.delete(tab);
  }

  public clearAll(): void {
    this.tabStates.clear();
  }

  public hasSearch(tab: NavTab): boolean {
    const state = this.tabStates.get(tab);
    return !!(state && state.query && state.query.trim().length > 0);
  }
}
