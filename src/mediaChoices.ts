import type { CameraBackground } from './cameraBackground';
import type { NoiseLevel } from './usePeerMedia';

// The noise level and camera background are remembered in this browser. They
// take effect the next time the microphone or camera is acquired.
const noiseKey = 'bespingle_noise_level';
const noiseLevels: NoiseLevel[] = ['off', 'standard', 'strong'];
export function readNoiseLevel(): NoiseLevel | undefined {
  try {
    const value = localStorage.getItem(noiseKey);
    return noiseLevels.includes(value as NoiseLevel) ? value as NoiseLevel : undefined;
  } catch { return undefined; }
}
export function saveNoiseLevel(level: NoiseLevel) {
  try { localStorage.setItem(noiseKey, level); } catch { /* Private modes may refuse storage. */ }
}

const backgroundKey = 'bespingle_camera_background';
const backgrounds: CameraBackground[] = ['none', 'blur', 'sky', 'forest', 'custom'];
export function readBackground(): CameraBackground {
  try {
    const value = localStorage.getItem(backgroundKey);
    return backgrounds.includes(value as CameraBackground) ? value as CameraBackground : 'none';
  } catch { return 'none'; }
}
export function saveBackground(background: CameraBackground) {
  try { localStorage.setItem(backgroundKey, background); } catch { /* Private modes may refuse storage. */ }
}

// A custom image is too large for local storage, so it is kept in IndexedDB.
// Only the latest one is kept.
const imageKey = 'custom';
function imageStore<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('bespingle', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('backgrounds'); };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Background storage is blocked.'));
    open.onsuccess = () => {
      const db = open.result;
      try {
        const request = use(db.transaction('backgrounds', mode).objectStore('backgrounds'));
        request.onsuccess = () => { db.close(); resolve(request.result); };
        request.onerror = () => { db.close(); reject(request.error); };
      } catch (error) { db.close(); reject(error); }
    };
  });
}
// Rejects when the image is missing or cannot be read back.
export async function readBackgroundImage(): Promise<File> {
  const value: unknown = await imageStore('readonly', (store) => store.get(imageKey));
  if (!(value instanceof Blob) || !value.size) throw new Error('No remembered background image.');
  return value instanceof File ? value : new File([value], 'background', { type: value.type });
}
export async function saveBackgroundImage(image: File) {
  try { await imageStore('readwrite', (store) => store.put(image, imageKey)); } catch { /* Private modes may refuse storage. */ }
}
