const storageKey = 'bespingle_split_width';
export const splitWidthMin = 25;
export const splitWidthMax = 75;
export function clampSplitWidth(width: number) { return Math.min(splitWidthMax, Math.max(splitWidthMin, width)); }
export function readSplitWidth(): number {
  try { const width = Number.parseFloat(localStorage.getItem(storageKey) ?? ''); return Number.isFinite(width) ? clampSplitWidth(width) : 50; } catch { return 50; }
}
export function saveSplitWidth(width: number) {
  try { localStorage.setItem(storageKey, String(width)); } catch { /* Private modes may refuse storage. */ }
}
