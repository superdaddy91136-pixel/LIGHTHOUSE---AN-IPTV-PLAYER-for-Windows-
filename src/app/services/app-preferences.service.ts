import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen, UnlistenFn } from '@tauri-apps/api/event';
import { BehaviorSubject } from 'rxjs';
import { Settings } from '../models/settings';

function hexToRgbString(hex: string): string {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num) || full.length !== 6) {
    return '255, 77, 109';
  }
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `${r}, ${g}, ${b}`;
}

function getContrastTextColor(hex: string): '#0b1120' | '#ffffff' {
  const [r, g, b] = hexToRgbString(hex)
    .split(',')
    .map((v) => {
      const c = Number(v.trim()) / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.34 ? '#0b1120' : '#ffffff';
}

export type AccentPresetId = 'crimson' | 'ocean' | 'emerald' | 'amber' | 'violet';

export interface AccentPreset {
  id: AccentPresetId;
  label: string;
  color: string;
  hover: string;
  glow: string;
  soft: string;
  border: string;
  overlayPrimary: string;
  overlayHover: string;
  overlayGlow: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  {
    id: 'crimson',
    label: 'Crimson',
    color: '#ff4d6d',
    hover: '#ff758f',
    glow: 'rgba(255, 77, 109, 0.35)',
    soft: 'rgba(255, 77, 109, 0.14)',
    border: 'rgba(255, 77, 109, 0.45)',
    overlayPrimary: '#e50914',
    overlayHover: '#f40612',
    overlayGlow: 'rgba(229, 9, 20, 0.45)',
  },
  {
    id: 'ocean',
    label: 'Ocean Blue',
    color: '#38bdf8',
    hover: '#7dd3fc',
    glow: 'rgba(56, 189, 248, 0.35)',
    soft: 'rgba(56, 189, 248, 0.14)',
    border: 'rgba(56, 189, 248, 0.45)',
    overlayPrimary: '#0ea5e9',
    overlayHover: '#38bdf8',
    overlayGlow: 'rgba(14, 165, 233, 0.45)',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    color: '#34d399',
    hover: '#6ee7b7',
    glow: 'rgba(52, 211, 153, 0.35)',
    soft: 'rgba(52, 211, 153, 0.14)',
    border: 'rgba(52, 211, 153, 0.45)',
    overlayPrimary: '#10b981',
    overlayHover: '#34d399',
    overlayGlow: 'rgba(16, 185, 129, 0.45)',
  },
  {
    id: 'amber',
    label: 'Amber',
    color: '#fbbf24',
    hover: '#fcd34d',
    glow: 'rgba(251, 191, 36, 0.35)',
    soft: 'rgba(251, 191, 36, 0.14)',
    border: 'rgba(251, 191, 36, 0.45)',
    overlayPrimary: '#f59e0b',
    overlayHover: '#fbbf24',
    overlayGlow: 'rgba(245, 158, 11, 0.45)',
  },
  {
    id: 'violet',
    label: 'Violet',
    color: '#a78bfa',
    hover: '#c4b5fd',
    glow: 'rgba(167, 139, 250, 0.35)',
    soft: 'rgba(167, 139, 250, 0.14)',
    border: 'rgba(167, 139, 250, 0.45)',
    overlayPrimary: '#8b5cf6',
    overlayHover: '#a78bfa',
    overlayGlow: 'rgba(139, 92, 246, 0.45)',
  },
];

export type ShortcutActionId =
  | 'togglePlay'
  | 'seekBack'
  | 'seekForward'
  | 'volumeUp'
  | 'volumeDown'
  | 'toggleMute'
  | 'toggleFullscreen'
  | 'toggleNerdStats'
  | 'toggleChannelsDrawer'
  | 'nextChannel'
  | 'prevChannel'
  | 'recallChannel'
  | 'screenshot';

export interface ShortcutDefinition {
  id: ShortcutActionId;
  label: string;
  description: string;
  defaultBinding: string;
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: 'togglePlay', label: 'Play / Pause', description: 'Toggle playback or activate contextual prompt', defaultBinding: 'Space' },
  { id: 'seekBack', label: 'Seek Backward', description: 'Jump back 10 seconds (Movies & TV)', defaultBinding: 'ArrowLeft' },
  { id: 'seekForward', label: 'Seek Forward', description: 'Jump ahead 10 seconds (Movies & TV)', defaultBinding: 'ArrowRight' },
  { id: 'volumeUp', label: 'Volume Up', description: 'Increase player volume by 5%', defaultBinding: 'ArrowUp' },
  { id: 'volumeDown', label: 'Volume Down', description: 'Decrease player volume by 5%', defaultBinding: 'ArrowDown' },
  { id: 'toggleMute', label: 'Mute / Unmute', description: 'Toggle audio mute state', defaultBinding: 'KeyM' },
  { id: 'toggleFullscreen', label: 'Fullscreen', description: 'Toggle embedded player fullscreen mode', defaultBinding: 'KeyF' },
  { id: 'toggleNerdStats', label: 'Playback Stats', description: 'Toggle stream diagnostics overlay', defaultBinding: 'KeyI' },
  { id: 'toggleChannelsDrawer', label: 'Channel Switcher', description: 'Open or close Live TV channel drawer', defaultBinding: 'KeyC' },
  { id: 'nextChannel', label: 'Next Live Channel', description: 'Switch to next channel in Live TV', defaultBinding: 'PageUp' },
  { id: 'prevChannel', label: 'Previous Live Channel', description: 'Switch to previous channel in Live TV', defaultBinding: 'PageDown' },
  { id: 'recallChannel', label: 'Last Channel Recall', description: 'Quick-switch back to previous Live TV channel', defaultBinding: 'KeyL' },
  { id: 'screenshot', label: 'Take Screenshot', description: 'Save frame capture to screenshot folder', defaultBinding: 'Ctrl+Shift+KeyS' },
];

export const DEFAULT_KEYBINDINGS: Record<ShortcutActionId, string> = SHORTCUT_DEFINITIONS.reduce(
  (acc, def) => {
    acc[def.id] = def.defaultBinding;
    return acc;
  },
  {} as Record<ShortcutActionId, string>,
);

@Injectable({
  providedIn: 'root',
})
export class AppPreferencesService {
  private currentSettings: Settings = {};
  private activeBindings: Record<ShortcutActionId, string> = { ...DEFAULT_KEYBINDINGS };
  private unlistenSettingsUpdated?: UnlistenFn;
  private unlistenRequestOverlayPrefs?: UnlistenFn;
  private initPromise: Promise<void> | null = null;

  public isLocked$ = new BehaviorSubject<boolean>(false);

  constructor() {
    void this.init();
  }

  public init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    const loadSettings = (async () => {
      try {
        const s = await invoke<Settings>('get_settings');
        this.applySettings(s || {}, true);
      } catch (err) {
        console.warn('Failed to initialize app preferences:', err);
      }
    })();

    const setupListeners = (async () => {
      try {
        this.unlistenSettingsUpdated = await listen<Settings>('settings-updated', (event) => {
          this.applySettings(event?.payload || {}, false);
        });
      } catch {}
      try {
        this.unlistenRequestOverlayPrefs = await listen('request-overlay-preferences', async () => {
          await loadSettings;
          this.emitOverlayPreferences();
        });
      } catch {}
    })();

    this.initPromise = Promise.all([loadSettings, setupListeners]).then(() => undefined);
    return this.initPromise;
  }

  public get settingsSnapshot(): Settings {
    return this.currentSettings;
  }

  public applySettings(settings: Settings, isStartup: boolean): void {
    this.currentSettings = settings || {};
    this.activeBindings = this.parseKeybindings(settings?.keybindings);
    this.applyAppearance(this.currentSettings);
    this.emitOverlayPreferences();
    if (isStartup && settings?.pin_lock_enabled && settings?.app_pin_hash) {
      this.isLocked$.next(true);
    }
  }

  public applyAppearance(settings: Settings): void {
    const preset =
      ACCENT_PRESETS.find((p) => p.id === settings?.accent_color) || ACCENT_PRESETS[0];
    const root = document.documentElement.style;
    root.setProperty('--lh-accent', preset.color);
    root.setProperty('--lh-accent-hover', preset.hover);
    root.setProperty('--lh-accent-rgb', hexToRgbString(preset.color));
    root.setProperty('--lh-accent-glow', preset.glow);
    root.setProperty('--lh-accent-soft', preset.soft);
    root.setProperty('--lh-accent-border', preset.border);
    root.setProperty('--lh-accent-contrast', getContrastTextColor(preset.color));
  }

  public emitOverlayPreferences(): void {
    const s = this.currentSettings;
    const preset = ACCENT_PRESETS.find((p) => p.id === s?.accent_color) || ACCENT_PRESETS[0];
    const blur = typeof s?.overlay_glass_blur === 'number' ? Math.max(0, Math.min(120, s.overlay_glass_blur)) : 64;
    const opacity =
      typeof s?.overlay_glass_opacity === 'number' ? Math.max(40, Math.min(100, s.overlay_glass_opacity)) : 80;
    const overlayRgb = hexToRgbString(preset.overlayPrimary);

    emit('overlay-appearance', {
      blur,
      opacity,
      accent: preset.overlayPrimary,
      accentHover: preset.overlayHover,
      accentRgb: overlayRgb,
      accentGlow: preset.overlayGlow,
      accentSoft: `rgba(${overlayRgb}, 0.20)`,
      accentBorder: `rgba(${overlayRgb}, 0.55)`,
      accentContrast: getContrastTextColor(preset.overlayPrimary),
    }).catch(() => {});

    emit('overlay-keybindings', {
      bindings: this.activeBindings,
      defaultAudioLang: s?.default_audio_lang || '',
      defaultSubtitleLang: s?.default_subtitle_lang || '',
    }).catch(() => {});
  }

  public parseKeybindings(raw?: string): Record<ShortcutActionId, string> {
    const merged: Record<ShortcutActionId, string> = { ...DEFAULT_KEYBINDINGS };
    if (!raw || !raw.trim()) return merged;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const def of SHORTCUT_DEFINITIONS) {
          const val = parsed[def.id];
          if (typeof val === 'string' && val.trim().length > 0) {
            merged[def.id] = val.trim();
          }
        }
      }
    } catch {}
    return merged;
  }

  public getBindings(): Record<ShortcutActionId, string> {
    return { ...this.activeBindings };
  }

  public normalizeEventToBinding(event: KeyboardEvent): string | null {
    const code = event.code || event.key;
    if (!code) return null;
    const ignored = [
      'ControlLeft',
      'ControlRight',
      'ShiftLeft',
      'ShiftRight',
      'AltLeft',
      'AltRight',
      'MetaLeft',
      'MetaRight',
      'Control',
      'Shift',
      'Alt',
      'Meta',
      'Escape',
    ];
    if (ignored.includes(code)) return null;

    const parts: string[] = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(code);
    return parts.join('+');
  }

  public matchesAction(event: KeyboardEvent, actionId: ShortcutActionId): boolean {
    const target = this.activeBindings[actionId] || DEFAULT_KEYBINDINGS[actionId];
    const normalized = this.normalizeEventToBinding(event);
    if (!normalized) return false;
    return normalized === target;
  }

  public formatBindingLabel(binding: string): string {
    if (!binding) return '';
    return binding
      .split('+')
      .map((part) => {
        if (part.startsWith('Key')) return part.slice(3);
        if (part.startsWith('Digit')) return part.slice(5);
        if (part === 'ArrowLeft') return 'Left Arrow';
        if (part === 'ArrowRight') return 'Right Arrow';
        if (part === 'ArrowUp') return 'Up Arrow';
        if (part === 'ArrowDown') return 'Down Arrow';
        return part;
      })
      .join(' + ');
  }

  public async hashPin(pin: string, existingSalt?: string): Promise<string> {
    const salt = existingSalt || this.randomSaltHex();
    const input = new TextEncoder().encode(`${salt}:${pin}`);
    if (typeof window !== 'undefined' && window.crypto?.subtle) {
      const digest = await window.crypto.subtle.digest('SHA-256', input);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `v1:${salt}:${hex}`;
    }
    // Fallback deterministic mixer only when subtle crypto is unavailable
    let h1 = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h1 ^= input[i];
      h1 = Math.imul(h1, 0x01000193);
    }
    return `v1:${salt}:${(h1 >>> 0).toString(16).padStart(8, '0')}`;
  }

  private randomSaltHex(): string {
    const bytes = new Uint8Array(12);
    if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  public async verifyPin(pin: string, storedHash?: string): Promise<boolean> {
    const targetHash = storedHash ?? this.currentSettings.app_pin_hash;
    if (!targetHash) return false;
    const parts = targetHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'v1') return false;
    const candidate = await this.hashPin(pin, parts[1]);
    return candidate === targetHash;
  }

  public async unlockWithPin(pin: string): Promise<boolean> {
    const ok = await this.verifyPin(pin);
    if (ok) {
      this.isLocked$.next(false);
    }
    return ok;
  }

  public lockApp(): void {
    if (this.currentSettings.pin_lock_enabled && this.currentSettings.app_pin_hash) {
      this.isLocked$.next(true);
    }
  }
}
