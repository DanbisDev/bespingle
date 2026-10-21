export type Profile = { name: string; avatar: number; customAvatar: string; customOption: string };
export const validAvatarID = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export function readProfile(): Profile {
  const fallback = { name: '', avatar: 0, customAvatar: '', customOption: '' };
  try {
    const value = document.cookie.split('; ').find((part) => part.startsWith('bespingle_profile='))?.split('=').slice(1).join('=');
    if (!value) return fallback;
    const data = JSON.parse(decodeURIComponent(value));
    return { name: typeof data.name === 'string' ? Array.from(data.name).slice(0, 32).join('') : '', avatar: Number.isInteger(data.avatar) && data.avatar >= 0 && data.avatar < 6 ? data.avatar : 0, customAvatar: validAvatarID(data.customAvatar) ? data.customAvatar : '', customOption: validAvatarID(data.customOption) ? data.customOption : '' };
  } catch { return fallback; }
}
export function saveProfile(profile: Profile) {
  document.cookie = `bespingle_profile=${encodeURIComponent(JSON.stringify(profile))}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
}
