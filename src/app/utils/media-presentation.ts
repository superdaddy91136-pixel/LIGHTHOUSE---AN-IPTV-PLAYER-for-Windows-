import { Channel } from "../models/channel";
import { MediaType } from "../models/mediaType";

export const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|ts|m2ts|mov|wmv|iso|flv|webm|m4v|vob|mpg|mpeg)$/i;

export const BRAND_PREFIX_REGEX = /^(?:[\[\(|]\s*(?:4K-)?(?:A\s*\+|D\s*\+|P\s*\+|C\s*\+|MGM\+|CANAL\+|PARAMOUNT\+?|DISNEY\+?|APPLE(?:\s*TV\+?)?|NF|NETFLIX|ATVP|AMZN|PRIME(?:\s*VIDEO)?|DSNP|HMAX|MAX|HBO(?:\s*MAX)?|HULU|PEACOCK|BBC|SKY|CRUNCHYROLL|CR|STARZ|SHOWTIME)\s*[\]\)|]\s*[-:|–—\/]?|(?:4K-)?(?:A\s*\+|D\s*\+|P\s*\+|C\s*\+|MGM\+|CANAL\+|PARAMOUNT\+?|DISNEY\+?|APPLE(?:\s*TV\+?)?|NF|NETFLIX|ATVP|AMZN|PRIME(?:\s*VIDEO)?|DSNP|HMAX|MAX|HBO(?:\s*MAX)?|HULU|PEACOCK|BBC|SKY|CRUNCHYROLL|CR|STARZ|SHOWTIME)\s*[-:|–—\/])\s*/i;

export const CATEGORY_PREFIX_REGEX = /^(?:[\ [\(|]\s*(?:TOP|VIP|NEW|EXCLUSIVE|PREMIUM|VOD|SERIES?|TV|SHOWS?|FILMS?|CINEMA|MOVIES?|S|M)\s*[\]\)|]\s*[-:|–—\/]?|(?:TOP|VIP|NEW|EXCLUSIVE|PREMIUM|VOD|SERIES?|TV|SHOWS?|FILMS?|CINEMA|MOVIES?|S|M)\s*[-:|–—\/])\s*/i;

export const RESOLUTION_PREFIX_REGEX = /^[-*#~_+=|\s]*(\[?(?:4K(?:\s*UHD)?|UHD|2160p|1080p|1080i|FHD|720p|HD|SD|480p)\]?)\s*[-:|–—\/]?\s*/i;

export const LEADING_LANG_CODE_REGEX = /^(?:\|[A-Za-z0-9\s_-]+\|\[[A-Za-z0-9\s_-]+\]|\([A-Za-z0-9\s_-]+\))\s*[-:|–—\/]?\s*/;

export const FULL_LANGUAGE_PREFIX_REGEX = /^(?:ENGLISH|SPANISH|FRENCH|GERMAN|ITALIAN|PORTUGUESE|RUSSIAN|HINDI|TAMIL|TELUGU|KOREAN|JAPANESE|CHINESE|ARABIC|TURKISH|DUTCH|POLISH|SWEDISH|NORWEGIAN|DANISH|FINNISH|GREEK|HEBREW|THAI|VIETNAMESE|INDONESIAN|LATIN|MULTI|DUAL)\s*[-:|–—\/]\s*/i;

export const COUNTRY_CODE_PREFIX_REGEX = /^(?:[A-Z]{2,4})\s*[-:|–—\/]\s*/;

export const TECHNICAL_TAGS_BRACKETS = /\[\s*(?:4K(?:\s*UHD)?|UHD|2160p|1080p|1080i|FHD|720p|HD|480p|SD|HEVC|H\.?26[45]|x26[45]|10bit|HDR(?:10\+?)?|DV|Dolby(?:\s*(?:Vision|Atmos|Digital))?|Atmos|DTS(?:-HD)?|TrueHD|5\.1|7\.1|WEBRip|WEB-Rip|WEB-DL|WEBDL|BluRay|Blu-Ray|BRRip|BDRip|HDTV|DVDRip|REMUX|PROPER|REPACK|MULTI|DUAL|VOSTFR|VF|Subbed|Dubbed|Dual\s*Audio)[^\]]*\]/gi;

export const TECHNICAL_TAGS_PARENS = /\(\s*(?:4K(?:\s*UHD)?|UHD|2160p|1080p|1080i|FHD|720p|HD|480p|SD|HEVC|x26[45]|H\.?26[45]|10bit|HDR|DV|BluRay|WEBRip|WEB-DL|REMUX|MULTI|VOSTFR|Subbed|Dubbed)\s*\)/gi;

export const TRAILING_SCENE_TAGS = /\b(?:REMUX|BluRay|Blu-Ray|BRRip|BDRip|WEBRip|WEB-Rip|WEB-DL|WEBDL|HDTV|DVDRip|DVD|x26[45]|h\.?26[45]|HEVC|AVC|10bit|2160p|4K|UHD|1080p|1080i|FHD|720p|HD|480p|HDR(?:10\+?)?|DV|Dolby|DTS-HD|DTS|TrueHD|Atmos|DDP5\.1|DD5\.1|AC3|AAC2\.0|AAC|PROPER|REPACK|REMASTERED|UNRATED|EXTENDED|DIRECTORS\s*CUT|THEATRICAL)\b/gi;

export interface ParsedMediaTitle {
  cleanTitle: string;
  year?: string;
  season?: number;
  episode?: number;
  quality?: string;
}

/**
 * Strips video file extensions (.mkv, .mp4, etc.) from titles or filenames.
 */
export function stripFileExtensions(title?: string): string {
  if (!title) return '';
  return title.replace(VIDEO_EXTENSIONS, '').trim();
}

/**
 * Strips folder and directory path prefixes (e.g. "MOVIES/SCI-FI/...", "SERIES/Show/Season 01/...").
 */
export function stripFolderPaths(rawTitle?: string): string {
  if (!rawTitle) return '';
  let str = rawTitle.trim();
  if (!str.includes('/') && !str.includes('\\')) {
    return str;
  }
  const parts = str.split(/[\\/]+/).map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return parts[0] || str;

  const last = parts[parts.length - 1];
  const lastClean = stripFileExtensions(last);

  // If the last segment is just an episode indicator (e.g. "S01E01" or "01"), find parent show folder
  if (/^(?:S\d{1,2}\s*E\d{1,3}|\d{1,2}x\d{1,3}|(?:Episode|Ep\.?)\s*\d+|\d{1,3})$/i.test(lastClean)) {
    for (let i = parts.length - 2; i >= 0; i--) {
      const part = parts[i];
      if (!/^(?:Season|Series|S)\s*\d+$/i.test(part) && !/^(?:SERIES|TV|SHOWS?|VOD|MOVIES?|FILMS?)$/i.test(part)) {
        return part;
      }
    }
  }

  return last;
}

/**
 * Replaces dot and underscore scene separators with spaces while preserving
 * legitimate decimals (e.g. "2.0", "5.1", "Vol. 1").
 */
export function replaceSceneSeparators(str?: string): string {
  if (!str) return '';
  let s = str.trim();
  const dotCount = (s.match(/\./g) || []).length;
  if (dotCount >= 2 && !/^[A-Za-z]\.[A-Za-z](\.[A-Za-z])*$/.test(s)) {
    s = s.replace(/(?<!\b\d)\.(?!\d\b)/g, ' ');
  }
  s = s.replace(/_/g, ' ');
  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Strips provider branding, streaming platform identifiers, language markers, and category noise.
 */
export function stripProviderPrefixes(str?: string): string {
  if (!str) return '';
  let s = str.trim();
  for (let pass = 0; pass < 4; pass++) {
    const prev = s;
    s = s.replace(BRAND_PREFIX_REGEX, '');
    s = s.replace(CATEGORY_PREFIX_REGEX, '');
    s = s.replace(RESOLUTION_PREFIX_REGEX, '');
    s = s.replace(FULL_LANGUAGE_PREFIX_REGEX, '');
    s = s.replace(LEADING_LANG_CODE_REGEX, '');
    s = s.replace(COUNTRY_CODE_PREFIX_REGEX, '');
    s = s.replace(/^[-*#~_+=|:–—\s/]+/, '');
    if (s === prev) break;
  }
  return s.trim();
}

const EXTRACT_YEAR_CACHE = new Map<string, string | undefined>();
const MAX_EXTRACT_YEAR_CACHE = 4000;

/**
 * Extracts a 4-digit release year (1900-2099) from bracketed tags or scene filenames.
 * Protects legitimate titles that begin with years (e.g. "1917", "2001: A Space Odyssey").
 */
export function extractYear(rawTitle?: string): string | undefined {
  if (!rawTitle) return undefined;
  const cached = EXTRACT_YEAR_CACHE.get(rawTitle);
  if (cached !== undefined) return cached;

  const result = computeExtractYear(rawTitle);
  if (EXTRACT_YEAR_CACHE.size >= MAX_EXTRACT_YEAR_CACHE) {
    const oldestKey = EXTRACT_YEAR_CACHE.keys().next().value;
    if (oldestKey !== undefined) EXTRACT_YEAR_CACHE.delete(oldestKey);
  }
  EXTRACT_YEAR_CACHE.set(rawTitle, result);
  return result;
}

function computeExtractYear(rawTitle: string): string | undefined {
  // 1. Bracketed/parenthesized year: e.g. (2014), [2014]
  const bracketMatch = rawTitle.match(/[\(\[]\s*(19\d\d|20\d\d)\s*[\)\]]/);
  if (bracketMatch) return bracketMatch[1];

  // 2. Standalone 4-digit year in scene/delimited string: e.g. "Interstellar.2014.1080p", "The.Dark.Knight.2008.WEB-DL"
  // Must NOT be the first word of the title (to protect "1917", "2001: A Space Odyssey", "2012")
  const words = rawTitle.split(/[\s._/\\-]+/).filter(Boolean);
  if (words.length > 1) {
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (/^(19\d\d|20\d\d)$/.test(w)) {
        const y = parseInt(w, 10);
        const currentYear = new Date().getFullYear();
        if (y >= 1900 && y <= currentYear + 2) {
          return w;
        }
      }
    }
  }
  return undefined;
}

/**
 * Extracts quality indicators (4K UHD, 1080p, 720p, HD) only when reliably present.
 */
export function extractQuality(rawTitle?: string): string | undefined {
  if (!rawTitle) return undefined;
  if (/\b(?:4K(?:\s*UHD)?|UHD|2160p)\b/i.test(rawTitle)) return '4K UHD';
  if (/\b(?:1080p|1080i|FHD)\b/i.test(rawTitle)) return '1080p';
  if (/\b(?:720p|HD)\b/i.test(rawTitle)) return '720p';
  return undefined;
}

const CLEAN_TITLE_CACHE = new Map<string, string>();
const MAX_CLEAN_TITLE_CACHE = 4000;

/**
 * Normalizes and cleans raw IPTV/VOD channel and movie titles for presentation.
 * Removes provider prefixes, repeated symbols, language tags, technical codes,
 * while preserving meaningful franchise information and subtitles.
 *
 * Example: "[4K UHD] Interstellar (2014) REMUX" -> "Interstellar"
 * Example: "MOVIES/SCI-FI/Interstellar.2014.1080p.BluRay.x265" -> "Interstellar"
 * Example: "ENGLISH - The.Dark.Knight.2008.WEB-DL" -> "The Dark Knight"
 */
export function cleanMediaTitle(raw?: string): string {
  if (!raw) return 'Untitled';
  const cached = CLEAN_TITLE_CACHE.get(raw);
  if (cached !== undefined) return cached;

  const result = computeCleanMediaTitle(raw);
  if (CLEAN_TITLE_CACHE.size >= MAX_CLEAN_TITLE_CACHE) {
    const oldestKey = CLEAN_TITLE_CACHE.keys().next().value;
    if (oldestKey !== undefined) CLEAN_TITLE_CACHE.delete(oldestKey);
  }
  CLEAN_TITLE_CACHE.set(raw, result);
  return result;
}

function computeCleanMediaTitle(raw: string): string {
  let title = raw.trim();

  // 1. Strip folder paths if any
  title = stripFolderPaths(title);

  // 2. Strip file extensions
  title = stripFileExtensions(title);

  // 3. Replace scene separators (. and _)
  title = replaceSceneSeparators(title);

  // 4. Strip provider, language, and category prefixes
  title = stripProviderPrefixes(title);

  // 5. Strip technical brackets and parentheses
  title = title.replace(TECHNICAL_TAGS_BRACKETS, ' ');
  title = title.replace(TECHNICAL_TAGS_PARENS, ' ');

  // 6. Extract release year if present
  const year = extractYear(raw);
  if (year) {
    // Only strip year if it's not the primary title itself (e.g. "1917", "2001: A Space Odyssey")
    const cleanedWithoutYear = title.replace(new RegExp(`\\b${year}\\b`, 'g'), '').replace(/[\(\[]\s*[\)\]]/g, '').trim();
    if (cleanedWithoutYear.length >= 2) {
      title = cleanedWithoutYear;
    }
  }

  // 7. Strip country/region/language tags in parentheses or brackets: (US), (UK), (KR), (Multi), (Sub)
  title = title.replace(/\s*[\(\[]\s*(?:[A-Za-z]{2,3}|Multi|Sub|Dub|VF|VOSTFR|Dual)\s*[\)\]]/gi, '');

  // 8. Strip season/episode markers from series titles:
  title = title.replace(/\s*[-–—:|/]?\s*\b(?:S\d{1,2}\s*[-–—.]?\s*E\d{1,3}|\d{1,2}x\d{1,3}|(?:Season|Series)\s*\d+(?:\s*(?:Episode|Ep\.?)\s*\d+)?|(?:Episode|Ep\.?)\s*\d+|S\d{1,2}|E\d{1,3})\b.*$/i, '');
  title = title.replace(/\b(?:Complete\s+Series|Complete\s+Season|Mini-Series|Miniseries)\b/gi, '');

  // 9. Repeatedly strip scene tags and trailing release groups from the end: e.g. "WEBRip", "BluRay", "REMUX", "HDR", "-EVO"
  for (let pass = 0; pass < 3; pass++) {
    const prev = title;
    title = title.replace(TRAILING_SCENE_TAGS, '');
    title = title.replace(/\s+-[A-Za-z0-9]{2,12}\s*$/g, '');
    title = title.replace(/^[-*#~_+=|:–—\s/]+/, '').replace(/[-*#~_+=|:–—\s/]+$/, '');
    if (title === prev) break;
  }

  // 10. Strip empty brackets/parentheses and stray punctuation
  title = title.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
  title = title.replace(/^[-*#~_+=|:–—\s/]+/, '').replace(/[-*#~_+=|:–—\s/]+$/, '');

  // Collapse multiple spaces
  title = title.replace(/\s{2,}/g, ' ').trim();

  return title.length > 0 ? title : raw.trim();
}

/**
 * Cleans category / genre labels from provider noise.
 */
export function cleanCategoryTitle(category?: string): string | undefined {
  if (!category) return undefined;
  let clean = category
    .replace(/^[-*#~_+=|\s]*\b(VOD|MOVIES?|SERIES?|CHANNELS?|LIVE)\b[-*#~_+=|\s:]*/gi, '')
    .replace(/^\|?[A-Z]{2,4}\|?\s*[-:|]\s*/g, '')
    .replace(/Movies|Series|VOD/gi, '')
    .replace(/^[-*#~_+=|:–—\s]+/, '')
    .replace(/[-*#~_+=|:–—\s]+$/, '')
    .trim();

  if (clean.length < 2 || /^(all|vod|movies|series)$/i.test(clean)) {
    return undefined;
  }
  return clean;
}

/**
 * Returns the best available synopsis from the catalog data if one exists.
 */
export function selectSynopsis(channel: Channel): string | undefined {
  const anyChannel = channel as any;
  if (
    anyChannel.overview &&
    typeof anyChannel.overview === 'string' &&
    anyChannel.overview.trim().length > 0
  ) {
    return anyChannel.overview.trim();
  }
  if (
    anyChannel.description &&
    typeof anyChannel.description === 'string' &&
    anyChannel.description.trim().length > 0
  ) {
    return anyChannel.description.trim();
  }
  if (
    anyChannel.plot &&
    typeof anyChannel.plot === 'string' &&
    anyChannel.plot.trim().length > 0
  ) {
    return anyChannel.plot.trim();
  }
  return undefined;
}

/**
 * Normalizes title casing while preserving uppercase roman numerals and acronyms,
 * and keeping minor grammatical words lowercase.
 */
export function toTitleCase(str?: string): string {
  if (!str) return '';
  const minorWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet'
  ]);
  const romanNumerals = /^(?=[MDCLXVI])M*(C[MD]|D?C{0,3})(X[CL]|L?X{0,3})(I[XV]|V?I{0,3})$/i;

  const words = str.trim().split(/\s+/);
  return words.map((word, index) => {
    const match = word.match(/^([("']*)(.*?)([)"']*)$/);
    if (!match) return word;
    const prefix = match[1];
    const core = match[2];
    const suffix = match[3];

    if (!core) return word;

    if (core.length > 1 && romanNumerals.test(core)) {
      return prefix + core.toUpperCase() + suffix;
    }

    const lower = core.toLowerCase();
    const prevWord = index > 0 ? words[index - 1] : '';
    const isAfterSeparator = prevWord.endsWith(':') || prevWord.endsWith('-') || prevWord.endsWith('—');

    if (index > 0 && index < words.length - 1 && minorWords.has(lower) && !isAfterSeparator) {
      return prefix + lower + suffix;
    }

    if (/^[A-Z]{2,4}$/.test(core)) {
      return prefix + core + suffix;
    }

    return prefix + core.charAt(0).toUpperCase() + core.slice(1).toLowerCase() + suffix;
  }).join(' ');
}

/**
 * Sanitizes a TV show title by stripping provider prefixes, trailing year markers,
 * technical tags, and redundant season suffixes.
 */
export function sanitizeShowTitle(rawTitle?: string): string {
  if (!rawTitle) return '';
  return cleanMediaTitle(rawTitle);
}

/**
 * Cleans up raw TV episode titles by stripping provider prefixes, duplicate show names,
 * redundant season/episode notation, and leading episode numbers.
 */
export function sanitizeEpisodeTitle(
  rawTitle?: string,
  showTitle?: string,
  episodeNum?: number,
  seasonNum?: number
): string {
  if (!rawTitle) return '';
  let title = rawTitle.trim();

  title = stripFileExtensions(title);
  title = replaceSceneSeparators(title);

  for (let pass = 0; pass < 3; pass++) {
    const prev = title;
    title = stripProviderPrefixes(title);

    // 1. Remove duplicated series name if at beginning of episode title
    const cleanShow = sanitizeShowTitle(showTitle);
    if (cleanShow) {
      const escapedShow = cleanShow.replace(/[.*+?^$${}()|[\]\\]/g, '\\$&');
      const showRegex = new RegExp(`^\\s*${escapedShow}\\s*[-:|–—/]?\\s*`, 'i');
      title = title.replace(showRegex, '');
    }
    if (showTitle) {
      const escapedRawShow = showTitle.trim().replace(/[.*+?^$${}()|[\]\\]/g, '\\$&');
      const rawShowRegex = new RegExp(`^\\s*${escapedRawShow}\\s*[-:|–—/]?\\s*`, 'i');
      title = title.replace(rawShowRegex, '');
    }

    // 2. Remove redundant season & episode notation
    const redundantNotationRegex = /^\s*[-:|–—/]?\s*(?:(?:Season\s*\d+\s*[,–-]?\s*)?(?:Episode\s*\d+|Ep\s*\d+|E\d{1,3}|S\d{1,2}\s*E\d{1,3}|\d{1,2}x\d{1,3}))\s*[-:|–—/.]?\s*/i;
    title = title.replace(redundantNotationRegex, '');
    title = title.replace(/^\s*(?:s\d{1,2}\s*e\d{1,3}|ep(?:isode)?\s*\d+|\d{1,2}x\d{1,3})\s*[-:|–—/.]?\s*/i, '');

    // 3. Remove leading episode number prefix if matching episodeNum: e.g. "11 - The Romanticist"
    if (episodeNum != null) {
      const epNumPattern = new RegExp(`^\\s*0*${episodeNum}\\s*[-–—:|/.]\\s*`, 'i');
      title = title.replace(epNumPattern, '');
    }

    if (title === prev) break;
  }

  // 4. Strip technical tags at end of episode title
  title = title.replace(TECHNICAL_TAGS_BRACKETS, ' ');
  title = title.replace(TECHNICAL_TAGS_PARENS, ' ');
  title = title.replace(TRAILING_SCENE_TAGS, '');
  title = title.replace(/^[-*#~_+=|:–—/·.\s]+/, '');
  title = title.replace(/[-*#~_+=|:–—/·.\s]+$/, '');
  title = title.trim();

  if (title.length > 0) {
    return toTitleCase(title);
  }

  return '';
}

/**
 * Formats a clean player episode label with primary (show) and secondary (episode) titles.
 */
export function formatPlayerEpisodeLabel(
  rawShowTitle?: string,
  rawEpisodeTitle?: string,
  episodeNum?: number,
  seasonNum?: number
): {
  primary: string;
  secondary: string;
  full: string;
  epTitle: string;
} {
  let showTitle = sanitizeShowTitle(rawShowTitle);
  let epRaw = (rawEpisodeTitle || '').trim();

  if (!showTitle && epRaw) {
    const stripped = stripProviderPrefixes(epRaw);
    const splitIdx = stripped.indexOf(' - ');
    if (splitIdx !== -1) {
      showTitle = sanitizeShowTitle(stripped.substring(0, splitIdx));
      epRaw = stripped.substring(splitIdx + 3).trim();
    } else {
      epRaw = stripped;
    }
  }

  let resolvedEpNum = episodeNum;
  if ((resolvedEpNum == null || resolvedEpNum <= 0) && epRaw) {
    const m = epRaw.match(/\b(?:e|ep|episode)[\s._-]*(\d{1,3})\b/i) ||
              epRaw.match(/\b\d{1,2}x(\d{1,3})\b/i) ||
              epRaw.match(/\bS\d{1,2}\s*E(\d{1,3})\b/i);
    if (m) {
      resolvedEpNum = parseInt(m[1], 10);
    }
  }

  const epTitle = sanitizeEpisodeTitle(epRaw, showTitle, resolvedEpNum, seasonNum);

  let secondary = '';
  if (resolvedEpNum != null && resolvedEpNum > 0) {
    if (epTitle && epTitle.toLowerCase() !== `episode ${resolvedEpNum}`.toLowerCase()) {
      secondary = `- ${resolvedEpNum}. ${epTitle}`;
    } else {
      secondary = `- Episode ${resolvedEpNum}`;
    }
  } else if (epTitle) {
    secondary = `- ${epTitle}`;
  }

  const full = showTitle ? (secondary ? `${showTitle} ${secondary}` : showTitle) : (secondary.replace(/^-\s*/, '') || epRaw);
  return { primary: showTitle, secondary, full, epTitle };
}

/**
 * Comprehensive parser returning structured metadata for an IPTV media item.
 */
export function parseMediaTitle(raw?: string, isTvHint?: boolean): ParsedMediaTitle {
  if (!raw) return { cleanTitle: 'Untitled' };
  const cleanTitle = cleanMediaTitle(raw);
  const year = extractYear(raw);
  const quality = extractQuality(raw);

  let season: number | undefined;
  let episode: number | undefined;

  const sMatch = raw.match(/\bS(\d{1,2})\s*[-–—.]?\s*E(\d{1,3})\b/i) ||
                 raw.match(/\b(\d{1,2})x(\d{1,3})\b/i) ||
                 raw.match(/\b(?:Season|Series)\s*(\d{1,2})\s*(?:Episode|Ep\.?)\s*(\d{1,3})\b/i);
  if (sMatch) {
    season = parseInt(sMatch[1], 10);
    episode = parseInt(sMatch[2], 10);
  } else {
    const sOnly = raw.match(/\b(?:Season|Series|S)\s*(\d{1,2})\b/i);
    if (sOnly) season = parseInt(sOnly[1], 10);
    const eOnly = raw.match(/\b(?:Episode|Ep\.?|E)\s*(\d{1,3})\b/i);
    if (eOnly) episode = parseInt(eOnly[1], 10);
  }

  return {
    cleanTitle,
    year,
    season,
    episode,
    quality,
  };
}


/**
 * Determines whether a channel/catalog item represents a TV show, season, or individual episode
 * rather than a standalone movie.
 *
 * Uses existing media-type metadata, catalog database classification fields (series_id, season_id,
 * episode_num), provider URL path structure, group classification, and episode naming patterns.
 */
export function isEpisodicOrTvContent(channel?: Channel | null): boolean {
  if (!channel) return false;

  // 1. Explicit series or season media type
  if (channel.media_type === MediaType.serie || channel.media_type === MediaType.season) {
    return true;
  }

  // 2. Database catalog episodic classification (series_id, season_id, episode_num)
  if (
    channel.series_id != null ||
    channel.season_id != null ||
    (channel.episode_num != null && channel.episode_num > 0)
  ) {
    return true;
  }

  // 3. Provider URL structure (Xtream or M3U series stream paths)
  if (channel.url && /\/(?:series|tvshows?|episodes?)\//i.test(channel.url)) {
    return true;
  }

  // 4. Provider group / folder categorization (if labeled as Series / TV Shows)
  const groupName = (channel as any).group;
  if (typeof groupName === 'string' && /^(?:.*[^\w])?(?:series|tv\s*shows?|shows?|seasons?)(?:[^\w].*)?$/i.test(groupName)) {
    return true;
  }

  // 5. Explicit episode / season naming patterns (e.g. "S01E01", "1x02", "Season 1 Episode 2")
  const name = channel.name?.trim();
  if (name) {
    if (
      /\b(?:s\d{1,2}\s*[-–—.]?\s*e\d{1,3}|\d{1,2}x\d{1,3}|season\s*\d+\s*(?:episode|ep\.?)\s*\d+)\b/i.test(name) ||
      /\b(?:episode|ep\.?)\s*\d{1,3}\b/i.test(name) ||
      /\bseason\s*\d+\b/i.test(name)
    ) {
      return true;
    }
  }

  return false;
}
