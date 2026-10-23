// Mirroring flips only how you see your own camera. Peers always receive the
// true image, and your shared screen is never flipped.
const storageKey = 'bespingle_mirror_self_view';
export function readMirrorSelfView(): boolean {
  try { return localStorage.getItem(storageKey) !== 'off'; } catch { return true; }
}
export function saveMirrorSelfView(mirror: boolean) {
  try { localStorage.setItem(storageKey, mirror ? 'on' : 'off'); } catch { /* Private modes may refuse storage. */ }
}
