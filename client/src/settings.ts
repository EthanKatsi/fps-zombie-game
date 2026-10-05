/**
 * Player settings (graphics quality, mouse sensitivity, field of view), remembered in this
 * browser. Changes are pushed to listeners immediately (the menu and pause screen edit them).
 */
export type GraphicsQuality = 'high' | 'medium' | 'low' | 'performance';

export interface Settings {
  quality: GraphicsQuality;
  /** Multiplier on the base mouse sensitivity. */
  sensitivity: number;
  fov: number;
}

export const QUALITY_LABELS: Record<GraphicsQuality, string> = {
  high: 'High (all effects)',
  medium: 'Medium (no ambient occlusion)',
  low: 'Low (no post-processing)',
  performance: 'Performance (no shadows / effects)',
};
export const QUALITY_ORDER: GraphicsQuality[] = ['high', 'medium', 'low', 'performance'];

const KEY = 'grey.settings';
const DEFAULTS: Settings = { quality: 'high', sensitivity: 1, fov: 75 };

const load = (): Settings => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const s = { ...DEFAULTS, ...raw } as Settings;
    if (!QUALITY_ORDER.includes(s.quality)) s.quality = DEFAULTS.quality;
    s.sensitivity = Math.min(3, Math.max(0.2, Number(s.sensitivity) || 1));
    s.fov = Math.min(100, Math.max(60, Number(s.fov) || 75));
    return s;
  } catch {
    return { ...DEFAULTS };
  }
};

let current = load();
const listeners = new Set<(s: Settings) => void>();

export const getSettings = (): Settings => current;

export const updateSettings = (patch: Partial<Settings>): void => {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode: not remembered */
  }
  for (const l of listeners) l(current);
};

export const onSettingsChange = (fn: (s: Settings) => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/**
 * Wire a settings form (quality select + sensitivity/FOV sliders) that exists in the DOM.
 * Used for both the main menu and the pause screen.
 */
export const bindSettingsForm = (root: HTMLElement): void => {
  const q = root.querySelector<HTMLSelectElement>('[data-setting="quality"]');
  const sens = root.querySelector<HTMLInputElement>('[data-setting="sensitivity"]');
  const fov = root.querySelector<HTMLInputElement>('[data-setting="fov"]');
  const sensOut = root.querySelector<HTMLElement>('[data-out="sensitivity"]');
  const fovOut = root.querySelector<HTMLElement>('[data-out="fov"]');
  if (q && !q.options.length) {
    for (const k of QUALITY_ORDER) q.add(new Option(QUALITY_LABELS[k], k));
  }
  const render = (s: Settings) => {
    if (q) q.value = s.quality;
    if (sens) sens.value = String(s.sensitivity);
    if (fov) fov.value = String(s.fov);
    if (sensOut) sensOut.textContent = `${s.sensitivity.toFixed(2)}x`;
    if (fovOut) fovOut.textContent = `${Math.round(s.fov)}°`;
  };
  q?.addEventListener('change', () => updateSettings({ quality: q.value as GraphicsQuality }));
  sens?.addEventListener('input', () => updateSettings({ sensitivity: Number(sens.value) }));
  fov?.addEventListener('input', () => updateSettings({ fov: Number(fov.value) }));
  onSettingsChange(render);
  render(current);
};
