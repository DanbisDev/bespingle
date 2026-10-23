import { useEffect, useRef } from 'react';
import { drawAvatar } from './art';
export function Avatar({ avatar, customAvatar, size = 48 }: { avatar: number; customAvatar?: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const render = () => {
      const canvas = ref.current;
      const ctx = canvas?.getContext('2d');
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      drawAvatar(ctx, 48, 84, avatar, 'down', false, undefined, 1, undefined, customAvatar);
    };
    render();
    window.addEventListener('avatar-loaded', render);
    return () => window.removeEventListener('avatar-loaded', render);
  }, [avatar, customAvatar]);
  return <canvas ref={ref} width="96" height="96" style={{ width: size, height: size }} className="avatar-art" aria-hidden="true" />;
}
