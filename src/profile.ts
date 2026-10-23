export type Profile = { name: string; avatar: number; customAvatar: string; customOption: string };
export type AvatarRef = { hash: string; walk: number; dance: number };
// A custom avatar reference is the image's content hash, followed by its walk
// and dance frame counts unless both are 2; the server issues exactly one form.
export function parseAvatarRef(ref: unknown): AvatarRef | undefined {
  const match = typeof ref === 'string' ? /^([a-f0-9]{64})(?:-([2-9]|1[0-6])-([2-9]|1[0-6]))?$/.exec(ref) : null;
  if (!match) return undefined;
  const [walk, dance] = match[2] ? [Number(match[2]), Number(match[3])] : [2, 2];
  return match[2] && walk === 2 && dance === 2 ? undefined : { hash: match[1], walk, dance };
}
export const validAvatarRef = (ref: unknown): ref is string => Boolean(parseAvatarRef(ref));
export function readProfile(): Profile {
  const fallback = { name: '', avatar: 0, customAvatar: '', customOption: '' };
  try {
    const value = document.cookie.split('; ').find((part) => part.startsWith('bespingle_profile='))?.split('=').slice(1).join('=');
    if (!value) return fallback;
    const data = JSON.parse(decodeURIComponent(value));
    return { name: typeof data.name === 'string' ? Array.from(data.name).slice(0, 32).join('') : '', avatar: Number.isInteger(data.avatar) && data.avatar >= 0 && data.avatar < 6 ? data.avatar : 0, customAvatar: validAvatarRef(data.customAvatar) ? data.customAvatar : '', customOption: validAvatarRef(data.customOption) ? data.customOption : '' };
  } catch { return fallback; }
}
export function saveProfile(profile: Profile) {
  document.cookie = `bespingle_profile=${encodeURIComponent(JSON.stringify(profile))}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
