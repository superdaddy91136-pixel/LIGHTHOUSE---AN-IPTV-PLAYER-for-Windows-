import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { MemoryService } from '../memory.service';
import { Channel } from '../models/channel';
import { Filters } from '../models/filters';
import { MediaType } from '../models/mediaType';
import { SortType } from '../models/sortType';
import { ViewMode } from '../models/viewMode';
import { MediaVersion } from '../models/version';
import {
  cleanMediaTitle,
  extractQuality,
  extractYear,
} from '../utils/media-presentation';
import {
  calculateDiceSimilarity,
  calculateTokenSimilarity,
  normalizeForComparison,
} from '../utils/tmdb-matcher';

@Injectable({
  providedIn: 'root',
})
export class VersionMatchingService {
  private versionCache = new Map<string, MediaVersion[]>();
  private versionRequests = new Map<string, Promise<MediaVersion[]>>();
  private titleInfoCache = new Map<string, { cleanTitle: string; normalizedTitle: string; year?: string }>();
  private englishVersionCache = new Map<string, boolean>();

  constructor(private memory: MemoryService) {}

  private cacheValue<T>(cache: Map<string, T>, key: string, value: T): T {
    // Bound long-lived caches: provider catalogs can be large, while detail
    // navigation only benefits from recently visited titles.
    if (cache.size >= 2_000) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey != null) cache.delete(oldestKey);
    }
    cache.set(key, value);
    return value;
  }

  private channelCacheKey(channel: Channel): string {
    return `${channel.source_id ?? ''}:${channel.id ?? ''}:${channel.name ?? ''}`;
  }

  private getTitleInfo(channel: Channel): { cleanTitle: string; normalizedTitle: string; year?: string } {
    const key = this.channelCacheKey(channel);
    const cached = this.titleInfoCache.get(key);
    if (cached) return cached;

    const cleanTitle = cleanMediaTitle(channel.name);
    return this.cacheValue(this.titleInfoCache, key, {
      cleanTitle,
      normalizedTitle: this.normalizeNumberTokens(normalizeForComparison(cleanTitle)),
      year: extractYear(channel.name),
    });
  }

  /**
   * Returns whether two catalog items are safe to present as one title in a
   * catalog title. This deliberately uses strict normalized-title equality:
   * the fuzzy matching used while discovering versions is useful for provider
   * metadata, but is too permissive for deciding which search cards to hide.
   */
  hasSameStrictTitleIdentity(
    first: Channel,
    second: Channel,
    firstKnownYear?: string,
  ): boolean {
    if (!first || !second) return false;
    if (!first.name?.trim() || !second.name?.trim()) return false;

    const firstMediaType =
      first.media_type != null ? Number(first.media_type) : MediaType.movie;
    const secondMediaType =
      second.media_type != null ? Number(second.media_type) : MediaType.movie;
    if (
      firstMediaType !== secondMediaType ||
      (firstMediaType !== MediaType.movie && firstMediaType !== MediaType.serie)
    ) {
      return false;
    }

    // Search cards represent top-level movies or series, never a season/episode.
    if (
      first.season_id != null ||
      second.season_id != null ||
      (firstMediaType === MediaType.movie &&
        (first.series_id != null || second.series_id != null))
    ) {
      return false;
    }

    const firstInfo = this.getTitleInfo(first);
    const secondInfo = this.getTitleInfo(second);
    const firstTitle = firstInfo.normalizedTitle;
    const secondTitle = secondInfo.normalizedTitle;
    if (!firstTitle || firstTitle !== secondTitle) return false;

    const firstYear = firstKnownYear || firstInfo.year;
    const secondYear = secondInfo.year;
    if (!firstYear || !secondYear) return true;

    const firstYearNumber = parseInt(firstYear, 10);
    const secondYearNumber = parseInt(secondYear, 10);
    return (
      isNaN(firstYearNumber) ||
      isNaN(secondYearNumber) ||
      Math.abs(firstYearNumber - secondYearNumber) <= 1
    );
  }

  /**
   * Extracts platform/provider tags: Netflix, Prime Video, Disney+, Apple TV+, Max, etc.
   */
  extractPlatformPrefix(rawTitle?: string): string | undefined {
    if (!rawTitle) return undefined;
    const match = rawTitle.match(
      /\b(?:4K-)?(NF|NETFLIX|AMZN|PRIME|ATVP|APPLE(?:\s*TV\+?)?|DSNP|DISNEY\+?|HMAX|MAX|HBO(?:\s*MAX)?|HULU|PEACOCK|PARAMOUNT\+?|BBC|SKY|CANAL\+?|CRUNCHYROLL|STARZ|SHOWTIME|MGM\+?)\b/i,
    );
    if (!match) return undefined;
    const tag = match[1].toUpperCase();
    if (tag === 'NF' || tag === 'NETFLIX') return 'Netflix';
    if (tag === 'AMZN' || tag === 'PRIME') return 'Prime Video';
    if (tag === 'ATVP' || tag.startsWith('APPLE')) return 'Apple TV+';
    if (tag === 'DSNP' || tag.startsWith('DISNEY')) return 'Disney+';
    if (tag === 'HMAX' || tag === 'MAX' || tag.startsWith('HBO')) return 'Max';
    if (tag === 'HULU') return 'Hulu';
    if (tag === 'PEACOCK') return 'Peacock';
    if (tag.startsWith('PARAMOUNT')) return 'Paramount+';
    if (tag === 'BBC') return 'BBC';
    if (tag === 'SKY') return 'Sky';
    if (tag.startsWith('CANAL')) return 'Canal+';
    if (tag === 'CRUNCHYROLL') return 'Crunchyroll';
    if (tag === 'STARZ') return 'Starz';
    if (tag === 'SHOWTIME') return 'Showtime';
    if (tag.startsWith('MGM')) return 'MGM+';
    return tag;
  }

  /**
   * Extracts country or language codes: US, UK, FR, VF, VOSTFR, Multi, etc.
   */
  extractLanguageOrCountry(rawTitle?: string): string | undefined {
    if (!rawTitle) return undefined;

    // 1. Pipe format: |EN|, |US|, |FR|, |UK|, etc.
    const pipeMatch = rawTitle.match(/\|([A-Za-z]{2,4})\|/);
    if (pipeMatch) {
      return pipeMatch[1].toUpperCase();
    }

    // 2. Bracket or parenthesis format: [EN], [US], [FR], (US), (UK), (FR), (VF), (VOSTFR), (Multi), etc.
    const bracketMatch = rawTitle.match(
      /[\(\[]\s*(US|USA|UK|GB|CA|AU|FR|ES|DE|IT|NL|PT|BR|IN|JP|KR|MX|TW|HK|LATAM|Multi(?:-Sub)?|Sub(?:bed)?|Dub(?:bed)?|VF|VOSTFR|VO|Vost|Eng|French|Span?(?:ish)?|German|Ita(?:lian)?)\s*[\)\]]/i,
    );
    if (bracketMatch) {
      const code = bracketMatch[1].trim();
      if (/^multi/i.test(code)) return 'Multi';
      if (/^vost/i.test(code)) return 'VOSTFR';
      if (/^vf/i.test(code)) return 'VF';
      if (/^sub/i.test(code)) return 'Subbed';
      if (/^dub/i.test(code)) return 'Dubbed';
      if (/^eng/i.test(code)) return 'EN';
      if (/^french/i.test(code)) return 'FR';
      if (/^span/i.test(code)) return 'ES';
      if (/^german/i.test(code)) return 'DE';
      if (/^ita/i.test(code)) return 'IT';
      return code.toUpperCase();
    }

    // 3. Leading country/lang code: "EN |", "US -", "FR:"
    const prefixMatch = rawTitle.match(/^([A-Za-z]{2,3})\s*[-:|]/);
    if (prefixMatch) {
      return prefixMatch[1].toUpperCase();
    }

    return undefined;
  }

  /**
   * Refined quality badge extraction (supporting HDR, 4K, 1080p, 720p, etc.)
   */
  extractQualityBadge(rawTitle?: string): string | undefined {
    if (!rawTitle) return undefined;
    const is4K = /\b(4K|UHD|2160p)\b/i.test(rawTitle);
    const isHDR = /\b(HDR|HDR10|DV|Dolby\s*Vision)\b/i.test(rawTitle);
    if (is4K && isHDR) return '4K HDR';
    if (is4K) return '4K UHD';
    if (/\b(1080p|FHD|1080i)\b/i.test(rawTitle)) return '1080p';
    if (/\b(720p|HD)\b/i.test(rawTitle)) return '720p';
    if (/\b(480p|SD)\b/i.test(rawTitle)) return 'SD';
    return extractQuality(rawTitle);
  }

  /**
   * Normalizes number tokens such as "Part Two", "Part II", "Part 2" into digits for comparison.
   */
  normalizeNumberTokens(str: string): string {
    return str
      .replace(/\b(part|volume|vol|chapter|ch)\s+(one|i)\b/gi, '$1 1')
      .replace(/\b(part|volume|vol|chapter|ch)\s+(two|ii)\b/gi, '$1 2')
      .replace(/\b(part|volume|vol|chapter|ch)\s+(three|iii)\b/gi, '$1 3')
      .replace(/\b(part|volume|vol|chapter|ch)\s+(four|iv)\b/gi, '$1 4')
      .replace(/\b(part|volume|vol|chapter|ch)\s+(five|v)\b/gi, '$1 5')
      .replace(/\b(part|volume|vol|chapter|ch)\s+(six|vi)\b/gi, '$1 6')
      .replace(/\b(part|volume|vol|chapter|ch)\s+(seven|vii)\b/gi, '$1 7')
      .replace(/\b(part|volume|vol|chapter|ch)\s+(eight|viii)\b/gi, '$1 8')
      .replace(/\b(part|volume|vol|chapter|ch)\s+(nine|ix)\b/gi, '$1 9')
      .replace(/\b(part|volume|vol|chapter|ch)\s+(ten|x)\b/gi, '$1 10');
  }

  /**
   * Builds a human-readable badge label summarizing the version.
   */
  buildBadgeLabel(
    quality?: string,
    platform?: string,
    langOrCountry?: string,
    sourceName?: string,
  ): string {
    const parts: string[] = [];
    if (quality) parts.push(quality);
    if (platform) parts.push(platform);
    if (langOrCountry) parts.push(langOrCountry);
    if (parts.length === 0 && sourceName) parts.push(sourceName);
    return parts.join(' · ') || 'Standard';
  }

  /**
   * Maps a raw Channel into a structured MediaVersion object.
   */
  channelToVersion(channel: Channel, isSelected: boolean = false): MediaVersion {
    const rawName = channel.name || '';
    const titleInfo = this.getTitleInfo(channel);
    const cleanTitle = titleInfo.cleanTitle;
    const sourceName = channel.source_id
      ? this.memory.Sources.get(channel.source_id)?.name
      : undefined;
    const providerPlatform = this.extractPlatformPrefix(rawName);
    const countryOrLanguage = this.extractLanguageOrCountry(rawName);
    const qualityBadge = this.extractQualityBadge(rawName);
    const year = titleInfo.year;
    const badgeLabel = this.buildBadgeLabel(
      qualityBadge,
      providerPlatform,
      countryOrLanguage,
      sourceName,
    );

    return {
      channel,
      sourceName,
      providerPlatform,
      qualityBadge,
      year,
      countryOrLanguage,
      cleanTitle,
      rawName,
      badgeLabel,
      isSelected,
    };
  }

  /**
   * Queries SQLite database and discovers all alternative provider entries
   * representing the same movie or TV show.
   */
  async findVersions(channel: Channel, knownYear?: string): Promise<MediaVersion[]> {
    if (!channel) return [];

    const key = this.getGroupedTitleKey(channel, knownYear);
    const cached = this.versionCache.get(key);
    if (cached) return cached;

    const inFlight = this.versionRequests.get(key);
    if (inFlight) return inFlight;

    const request = this.findVersionsUncached(channel, knownYear);
    this.versionRequests.set(key, request);
    try {
      const versions = await request;
      this.versionCache.set(key, versions);
      return versions;
    } finally {
      this.versionRequests.delete(key);
    }
  }

  getCachedVersions(channel: Channel, knownYear?: string): MediaVersion[] | undefined {
    if (!channel) return undefined;
    return this.versionCache.get(this.getGroupedTitleKey(channel, knownYear));
  }

  private async findVersionsUncached(channel: Channel, knownYear?: string): Promise<MediaVersion[]> {
    if (!channel) return [];

    const targetInfo = this.getTitleInfo(channel);
    const cleanTitle = targetInfo.cleanTitle;
    const targetNorm = targetInfo.normalizedTitle;
    const targetYear = targetInfo.year || knownYear;
    const targetMediaType =
      channel.media_type != null ? Number(channel.media_type) : MediaType.movie;

    const sourceIds = Array.from(this.memory.Sources.keys());
    const querySourceIds =
      sourceIds.length > 0 ? sourceIds : channel.source_id ? [channel.source_id] : [];

    // Extract significant words from clean title for keyword searching in SQLite
    const words = cleanTitle
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    const primaryKeywords =
      words.length > 3 ? words.slice(0, 3).join(' ') : words.join(' ');
    const searchQuery = primaryKeywords.trim() || cleanTitle.trim();

    const candidateMap = new Map<number, Channel>();
    candidateMap.set(channel.id!, channel);

    try {
      // 1. Primary Keyword Search in SQLite
      const filters: Filters = {
        source_ids: querySourceIds,
        media_types: [targetMediaType],
        view_type: ViewMode.All,
        query: searchQuery,
        use_keywords: true,
        page: 1,
        sort: SortType.alphabeticalAscending,
      };

      const primaryResults = (await invoke('search', { filters })) as Channel[];
      if (primaryResults) {
        for (const item of primaryResults) {
          if (item?.id) candidateMap.set(item.id, item);
        }
      }

      // 2. Secondary fallback search if few candidates and multiple words
      if (candidateMap.size <= 1 && words.length >= 2) {
        const fallbackFilters: Filters = {
          source_ids: querySourceIds,
          media_types: [targetMediaType],
          view_type: ViewMode.All,
          query: words.slice(0, 2).join(' '),
          use_keywords: true,
          page: 1,
          sort: SortType.alphabeticalAscending,
        };
        const fallbackResults = (await invoke('search', {
          filters: fallbackFilters,
        })) as Channel[];
        if (fallbackResults) {
          for (const item of fallbackResults) {
            if (item?.id) candidateMap.set(item.id, item);
          }
        }
      }
    } catch (err) {
      console.warn('Failed to query versions from SQLite:', err);
    }

    // 3. Filter candidates through intelligent title normalization & year matching
    const matchedVersions: MediaVersion[] = [];

    for (const cand of candidateMap.values()) {
      if (!cand.id) continue;

      // Always include the current channel
      if (cand.id === channel.id) {
        matchedVersions.push(this.channelToVersion(cand, true));
        continue;
      }

      // Ensure matching media type
      if (
        cand.media_type != null &&
        Number(cand.media_type) !== targetMediaType
      ) {
        continue;
      }

      // Filter out individual TV episodes from being matched as series versions
      if (targetMediaType === MediaType.serie) {
        if (cand.season_id != null) continue;
      } else {
        // Movies should not have season_id or series_id
        if (cand.season_id != null || cand.series_id != null) continue;
      }

      // Year verification
      const candidateInfo = this.getTitleInfo(cand);
      const candYear = candidateInfo.year;
      if (candYear && targetYear) {
        const yCand = parseInt(candYear, 10);
        const yTarget = parseInt(targetYear, 10);
        if (!isNaN(yCand) && !isNaN(yTarget)) {
          if (Math.abs(yCand - yTarget) > 1) {
            // Different release/reboot year (e.g. 1984 vs 2021)
            continue;
          }
        }
      }

      // Normalized title matching
      const candNorm = candidateInfo.normalizedTitle;

      let isMatch = false;

      if (targetNorm === candNorm) {
        isMatch = true;
      } else {
        // Fuzzy comparison for minor subtitle or punctuation differences
        const dice = calculateDiceSimilarity(targetNorm, candNorm);
        const token = calculateTokenSimilarity(targetNorm, candNorm);
        const score = Math.max(dice, token);

        if (candYear && targetYear && score >= 0.85) {
          isMatch = true;
        } else if (score >= 0.90) {
          isMatch = true;
        }
      }

      if (isMatch) {
        matchedVersions.push(this.channelToVersion(cand, false));
      }
    }

    // Sort versions:
    // 1. English versions near top (preferred non-4K English source first)
    // 2. Non-4K other versions in middle (preserving relative quality and order)
    // 3. 4K versions moved to the bottom of the list
    const orderScores = new Map(matchedVersions.map((version) => [version, this.scoreVersionOrder(version)]));
    matchedVersions.sort((a, b) => {
      const scoreDiff = orderScores.get(b)! - orderScores.get(a)!;
      if (scoreDiff !== 0) return scoreDiff;
      return a.rawName.localeCompare(b.rawName);
    });

    return matchedVersions;
  }

  /**
   * Determines if a version represents an English audio/source version.
   * Handles labels such as EN, ENG, English, US, UK, GB via language tags,
   * bracket/parenthesis delimiters, prefixes, and word-boundary metadata
   * without relying on overly broad substring matching.
   */
  isEnglishVersion(version: MediaVersion | Channel): boolean {
    if (!version) return false;
    const rawName = 'channel' in version ? version.rawName || version.channel?.name || '' : version.name || '';
    const sourceId = 'channel' in version ? version.channel?.source_id : version.source_id;
    const cacheKey = `${sourceId ?? ''}:${rawName}`;
    const cached = this.englishVersionCache.get(cacheKey);
    if (cached != null) return cached;
    const clean = 'cleanTitle' in version ? version.cleanTitle : cleanMediaTitle(rawName);
    const lang = 'countryOrLanguage' in version ? version.countryOrLanguage : this.extractLanguageOrCountry(rawName);

    // 1. Direct language code check from extractLanguageOrCountry
    if (lang) {
      const l = lang.toUpperCase();
      if (l === 'EN' || l === 'ENG' || l === 'ENGLISH' || l === 'US' || l === 'UK' || l === 'GB' || l === 'CA' || l === 'AU') {
        return this.cacheValue(this.englishVersionCache, cacheKey, true);
      }
    }

    // 2. Bracket, parenthesis, pipe, or delimiter tags: [EN], (EN), |EN|, [ENG], (ENG), |ENG|, [English], (English), |English|
    if (/[\(\[\|\/]\s*(?:EN|ENG|English|US|UK|GB)\s*[\)\]\|\/]/i.test(rawName)) {
      return this.cacheValue(this.englishVersionCache, cacheKey, true);
    }

    // 3. Leading prefixes: "EN -", "EN:", "EN |", "ENG -", "ENG:", "ENG |", "English -", "English:"
    if (/^(?:EN|ENG|English|US|UK|GB)\s*[-:|]/i.test(rawName.trim())) {
      return this.cacheValue(this.englishVersionCache, cacheKey, true);
    }

    // 4. Word boundary check in parts of the title outside the clean title
    const remaining = rawName.replace(clean, '');
    if (/\b(?:EN|ENG|English)\b/i.test(remaining)) {
      return this.cacheValue(this.englishVersionCache, cacheKey, true);
    }

    // 5. Source name tag check (e.g. source named "US VOD", "UK Movies", "EN Cinema")
    const sourceName = 'sourceName' in version
      ? version.sourceName
      : ('source_id' in version && version.source_id ? this.memory.Sources.get(version.source_id)?.name : undefined);
    if (sourceName && /\b(?:EN|ENG|ENGLISH|UK|US|GB)\b/i.test(sourceName)) {
      return this.cacheValue(this.englishVersionCache, cacheKey, true);
    }

    return this.cacheValue(this.englishVersionCache, cacheKey, false);
  }

  /**
   * Determines if a version is 4K / UHD / 2160p.
   */
  is4KVersion(version: MediaVersion | Channel): boolean {
    if (!version) return false;
    const rawName = 'channel' in version ? version.rawName || version.channel?.name || '' : version.name || '';
    const quality = 'qualityBadge' in version ? version.qualityBadge : this.extractQualityBadge(rawName);
    if (quality && quality.includes('4K')) return true;

    return /\b(?:4K|UHD|2160p)\b/i.test(rawName);
  }

  /**
   * Scores version for ordering in the dropdown:
   * 1. Preferred English non-4K versions at top (1000+)
   * 2. Non-4K other versions in middle (500+)
   * 3. 4K English versions near bottom (100+)
   * 4. 4K other versions at very bottom (0+)
   * Within each tier, 1080p > 720p > others.
   */
  scoreVersionOrder(version: MediaVersion): number {
    const isEn = this.isEnglishVersion(version);
    const is4K = this.is4KVersion(version);

    let score = 0;
    if (!is4K && isEn) {
      score = 1000;
    } else if (!is4K && !isEn) {
      score = 500;
    } else if (is4K && isEn) {
      score = 100;
    } else {
      score = 0;
    }

    const q = (version.qualityBadge || '').toUpperCase();
    if (q.includes('1080P') || q.includes('FHD')) {
      score += 30;
    } else if (q.includes('720P') || q.includes('HD')) {
      score += 20;
    } else if (q.includes('4K')) {
      if (q.includes('HDR') || q.includes('DV')) {
        score += 15;
      } else {
        score += 10;
      }
    } else {
      score += 5;
    }

    return score;
  }

  /**
   * Selects the default version for a title opened for the first time:
   * Defaults to the preferred English version if available;
   * otherwise falls back to the current channel or top compatible version.
   */
  getDefaultVersion(
    versions: MediaVersion[],
    fallbackChannel?: Channel,
  ): MediaVersion | undefined {
    if (!versions || versions.length === 0) return undefined;

    // 1. Look for English version (sorted versions already place the preferred non-4K English source first)
    const enVersion = versions.find((v) => this.isEnglishVersion(v));
    if (enVersion) {
      return enVersion;
    }

    // 2. If no English version exists, fall back to existing behavior:
    // Match the initially passed channel if present in versions
    if (fallbackChannel?.id) {
      const match = versions.find((v) => v.channel.id === fallbackChannel.id);
      if (match) return match;
    }

    // 3. Otherwise return top compatible non-4K version, or versions[0]
    const non4K = versions.find((v) => !this.is4KVersion(v));
    return non4K || versions[0];
  }

  /**
   * Checks if any version in the list has previous playback history.
   */
  getVersionWithPlaybackHistory(versions: MediaVersion[]): MediaVersion | undefined {
    if (!versions || versions.length === 0) return undefined;

    try {
      const storeRaw = localStorage.getItem('fred_tv_watch_progress');
      if (storeRaw) {
        const store = JSON.parse(storeRaw);
        if (store) {
          for (const ver of versions) {
            if (ver.channel?.id == null) continue;
            const entry = store[ver.channel.id];
            if (entry) {
              const time = typeof entry === 'number' ? entry : (entry.time || 0);
              const pct = entry.percent || 0;
              if (time > 10 || pct > 1) {
                return ver;
              }
            }
          }
        }
      }
    } catch {}

    try {
      for (const ver of versions) {
        if (ver.channel?.id == null) continue;
        const id = ver.channel.id;
        const pctRaw = localStorage.getItem(`watch_progress_${id}`);
        if (pctRaw) {
          const pct = parseFloat(pctRaw);
          if (!isNaN(pct) && pct > 1) {
            return ver;
          }
        }
        const posRaw = localStorage.getItem(`playback_pos_${id}`);
        if (posRaw) {
          const pos = parseFloat(posRaw);
          if (!isNaN(pos) && pos > 10) {
            return ver;
          }
        }
      }
    } catch {}

    return undefined;
  }

  /**
   * Generates a unique, normalized storage key for a grouped title.
   */
  getGroupedTitleKey(channel: Channel, knownYear?: string): string {
    const titleInfo = this.getTitleInfo(channel);
    const norm = titleInfo.normalizedTitle;
    const year = titleInfo.year || knownYear || '';
    const mediaType =
      channel.media_type != null ? Number(channel.media_type) : MediaType.movie;
    return `fred_tv_pref_ver_${mediaType}_${norm}_${year}`;
  }

  /**
   * Persists the user's selected version preference for a grouped title.
   */
  savePreferredVersion(
    channel: Channel,
    selected: MediaVersion,
    knownYear?: string,
  ): void {
    if (!channel || !selected?.channel) return;
    try {
      const key = this.getGroupedTitleKey(channel, knownYear);
      const data = {
        channelId: selected.channel.id,
        rawName: selected.rawName,
        sourceId: selected.channel.source_id,
        url: selected.channel.url,
        badgeLabel: selected.badgeLabel,
        cleanTitle: selected.cleanTitle,
        timestamp: Date.now(),
      };
      localStorage.setItem(key, JSON.stringify(data));
    } catch (err) {
      console.warn('Failed to save preferred version to localStorage:', err);
    }
  }

  /**
   * Retrieves the user's previously selected version for a grouped title, if one exists and matches
   * one of the available versions. Falls back to undefined if not found or no longer available.
   */
  getPreferredVersion(
    channel: Channel,
    versions: MediaVersion[],
    knownYear?: string,
  ): MediaVersion | undefined {
    if (!channel || !versions || versions.length === 0) return undefined;
    try {
      const key = this.getGroupedTitleKey(channel, knownYear);
      const raw = localStorage.getItem(key);
      if (raw) {
        const stored = JSON.parse(raw);
        if (stored) {
          // 1. Match by channel ID
          if (stored.channelId != null) {
            const byId = versions.find((v) => v.channel.id === stored.channelId);
            if (byId) return byId;
          }

          // 2. Match by exact raw provider title and source ID (handles database re-indexing)
          if (stored.rawName) {
            const byNameAndSource = versions.find(
              (v) =>
                v.rawName === stored.rawName &&
                (stored.sourceId == null || v.channel.source_id === stored.sourceId),
            );
            if (byNameAndSource) return byNameAndSource;

            const byName = versions.find((v) => v.rawName === stored.rawName);
            if (byName) return byName;
          }

          // 3. Match by URL/stream identifier
          if (stored.url) {
            const byUrl = versions.find(
              (v) => v.channel.url && v.channel.url === stored.url,
            );
            if (byUrl) return byUrl;
          }
        }
      }
    } catch (err) {
      console.warn('Failed to read preferred version from localStorage:', err);
    }

    // 4. Check if any version has previous playback history
    const historyVersion = this.getVersionWithPlaybackHistory(versions);
    if (historyVersion) {
      return historyVersion;
    }

    return undefined;
  }

  /**
   * Returns a saved preferred source when it contains enough stream metadata
   * to begin playback without waiting for a catalog-wide version lookup.
   */
  getStoredPreferredChannel(channel: Channel, knownYear?: string): Channel | undefined {
    if (!channel) return undefined;
    try {
      const raw = localStorage.getItem(this.getGroupedTitleKey(channel, knownYear));
      if (!raw) return undefined;

      const stored = JSON.parse(raw);
      if (
        stored?.channelId == null ||
        !stored.url ||
        stored.sourceId == null
      ) {
        return undefined;
      }

      return {
        ...channel,
        id: stored.channelId,
        name: stored.rawName || channel.name,
        url: stored.url,
        source_id: stored.sourceId,
        favorite: !!channel.favorite,
      };
    } catch (err) {
      console.warn('Failed to read saved preferred version for playback:', err);
      return undefined;
    }
  }
}
