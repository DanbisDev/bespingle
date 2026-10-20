type Context = CanvasRenderingContext2D;
type Direction = 'down' | 'up' | 'left' | 'right';

type Palette = {
  skin: readonly [string, string, string, string]; // shade, base, light, cheek
  hair: readonly [string, string, string, string]; // deep, base, light, glint
  coat: readonly [string, string, string];
  pants: readonly [string, string];
  boots: readonly [string, string];
};

// Every starter uses the same compact proportions, with its own complexion and clothes.
const palettes: readonly Palette[] = [
  { skin: ['#d1936d', '#f2bb90', '#ffdbaf', '#e69b7c'], hair: ['#352b2e', '#54382e', '#79513b', '#a57250'], coat: ['#262b36', '#3b444e', '#626d76'], pants: ['#30313d', '#4d4c58'], boots: ['#583c36', '#a76c49'] },
  { skin: ['#854e39', '#b87953', '#dfa473', '#cb8061'], hair: ['#29252e', '#3b2d33', '#59404a', '#7b5660'], coat: ['#884b40', '#bc7054', '#e19c73'], pants: ['#323445', '#53566c'], boots: ['#342d35', '#79605c'] },
  { skin: ['#c28d6f', '#edbb96', '#ffdbb5', '#e8a28b'], hair: ['#69402e', '#9a5a36', '#c1824e', '#e5ae70'], coat: ['#36546e', '#5f8fa9', '#a1c9d4'], pants: ['#313e58', '#576d8b'], boots: ['#303343', '#8b7770'] },
  { skin: ['#9c6650', '#cd9371', '#eebc91', '#d78c7a'], hair: ['#272331', '#3f3049', '#624862', '#92708e'], coat: ['#584267', '#8b6da2', '#c5a8ce'], pants: ['#333546', '#56576c'], boots: ['#3d303e', '#85637b'] },
  { skin: ['#a16a49', '#d49c6b', '#f4c68b', '#df9b79'], hair: ['#3d2b2c', '#67462f', '#987044', '#c49a60'], coat: ['#8d6632', '#bf984b', '#e8c77d'], pants: ['#36483f', '#60755a'], boots: ['#4c3831', '#98704c'] },
  { skin: ['#bc856f', '#e9b49a', '#ffdac0', '#e89d91'], hair: ['#4e2c3a', '#79434d', '#a9666a', '#cf9490'], coat: ['#774758', '#b16f86', '#df9eb6'], pants: ['#3e3d54', '#68647d'], boots: ['#44333d', '#96737a'] },
];

const outline = '#242331';
const sprites = new Map<string, HTMLCanvasElement>();

/** A logical pixel becomes a crisp 2 × 2 world-pixel cluster. */
function pixel(ctx: Context, color: string, x: number, y: number, w: number, h = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function legs(ctx: Context, p: Palette, side: boolean, seated: boolean, step: number) {
  const [dark, light] = p.pants;
  const [boot, bootLight] = p.boots;
  if (seated) {
    // Bent thighs, raised knees and hanging boots give sitting a separate silhouette.
    for (const sign of [-1, 1]) {
      const x = side ? (sign < 0 ? -3 : 2) : sign < 0 ? -7 : 2;
      pixel(ctx, outline, x, -8, 6, 6);
      pixel(ctx, dark, x + 1, -8, 4, 5);
      pixel(ctx, light, x + 1, -8, 4, 2);
      pixel(ctx, outline, x + 1, -4, 5, 4);
      pixel(ctx, boot, x + 1, -3, 4, 2);
      pixel(ctx, bootLight, x + 2, -3, 2);
    }
    return;
  }
  for (const sign of [-1, 1]) {
    const stride = step * sign;
    const x = side ? (sign < 0 ? -4 : 0) + stride : (sign < 0 ? -6 : 2) + stride;
    const lift = stride < 0 ? -1 : 0;
    pixel(ctx, outline, x, -7 + lift, 5, 7);
    pixel(ctx, dark, x + 1, -7 + lift, 3, 5);
    pixel(ctx, light, x + 1, -6 + lift, 1, 3);
    const toe = side ? 0 : sign < 0 ? -1 : 0;
    pixel(ctx, outline, x + toe, -2 + lift, 6, 3);
    pixel(ctx, boot, x + toe + 1, -2 + lift, 4, 2);
    pixel(ctx, bootLight, x + toe + 1, -2 + lift, 3);
    pixel(ctx, '#c89c7877', x + toe + 1, lift, 3);
  }
}

function arm(ctx: Context, p: Palette, x: number, y: number, front: boolean) {
  pixel(ctx, outline, x, y, 4, 8);
  pixel(ctx, p.coat[0], x + 1, y + 1, 2, 4);
  pixel(ctx, p.coat[1], x + 1, y + 1, 1, 3);
  pixel(ctx, p.coat[2], x + 1, y + 4, 2);
  pixel(ctx, p.skin[0], x + 1, y + 5, 2, 2);
  pixel(ctx, front ? p.skin[2] : p.skin[1], x + 1, y + 5, 1, 2);
}

function torso(ctx: Context, p: Palette, index: number, side: boolean, back: boolean, seated: boolean, step: number) {
  const left = side ? -5 : -7;
  const width = side ? 11 : 14;
  if (!side) {
    arm(ctx, p, -10, -14 + (seated ? 2 : -step), !back);
    arm(ctx, p, 6, -14 + (seated ? 2 : step), !back);
  } else {
    arm(ctx, p, 2 - step, -14, false);
  }
  pixel(ctx, outline, left + 1, -15, width - 2, 2);
  pixel(ctx, outline, left, -13, width, 8);
  pixel(ctx, p.coat[0], left + 1, -14, width - 2, 8);
  pixel(ctx, p.coat[1], left + 2, -14, width - 4, 7);
  pixel(ctx, p.coat[2], left + 1, -13, 1, 5);
  pixel(ctx, p.coat[0], left + 1, -7, width - 2);
  if (back) {
    pixel(ctx, p.coat[2], left + 2, -13, width - 4);
    pixel(ctx, p.coat[0], side ? 0 : -1, -11, 1, 4);
    pixel(ctx, p.coat[2], left + 2, -8, width - 4);
  } else {
    const shift = side ? 2 : 0;
    if (index === 0 || index === 3) {
      pixel(ctx, '#8b9395', -3 + shift, -15, 6, 7);
      pixel(ctx, '#c4c4bb', -2 + shift, -14, 4, 2);
      pixel(ctx, '#6b757d', -2 + shift, -11, 4, 3);
      pixel(ctx, p.coat[0], -4 + shift, -13, 2, 6);
      pixel(ctx, p.coat[0], 3 + shift, -13, 2, 6);
      pixel(ctx, p.coat[2], -5 + shift, -13, 2, 2);
      pixel(ctx, p.coat[2], 4 + shift, -13, 1, 2);
      pixel(ctx, '#8e979b', 3 + shift, -9, 1);
    } else if (index === 2) {
      pixel(ctx, '#c7e1e1', -4 + shift, -13, 8, 2);
      pixel(ctx, p.coat[0], shift, -14, 1, 7);
      pixel(ctx, '#a2bdc8', shift, -11, 1, 3);
    } else if (index === 4) {
      pixel(ctx, '#edd6a0', -4 + shift, -13, 8, 2);
      pixel(ctx, '#6f8265', -4 + shift, -10, 8);
      pixel(ctx, '#edd6a0', -4 + shift, -8, 8);
    } else {
      pixel(ctx, p.coat[2], -3 + shift, -14, 6);
      pixel(ctx, p.coat[0], -2 + shift, -14, 4);
      pixel(ctx, p.coat[2], -4 + shift, -7, 8);
      if (index === 1) pixel(ctx, '#f2c69c', 3 + shift, -11, 2, 2);
      else {
        pixel(ctx, '#eed1c0', 2 + shift, -13, 2, 5);
        pixel(ctx, p.coat[2], -4 + shift, -11, 1, 3);
      }
    }
  }
  if (side) arm(ctx, p, -4 + (seated ? 2 : step), -13 + (seated ? 1 : 0), !back);
}

function hairCap(ctx: Context, p: Palette, index: number) {
  const [deep, hair, light, glint] = p.hair;
  pixel(ctx, outline, -3, -32, 7);
  pixel(ctx, outline, -6, -31, 13);
  pixel(ctx, outline, -8, -30, 16, 2);
  pixel(ctx, outline, -9, -28, 18, 5);
  pixel(ctx, outline, -10, -25, 20, 7);
  pixel(ctx, deep, -7, -29, 14, 7);
  pixel(ctx, hair, -5, -31, 10, 2);
  pixel(ctx, hair, -8, -28, 16, 5);
  pixel(ctx, light, -5, -30, 6);
  pixel(ctx, light, 2, -29, 4);
  pixel(ctx, light, -7, -27, 6);
  pixel(ctx, light, 0, -27, 7);
  pixel(ctx, glint, -4, -29, 3);
  pixel(ctx, glint, 1, -28, 2);
  pixel(ctx, deep, -3, -28, 3);
  pixel(ctx, deep, 4, -26, 4);
  if (index === 1) {
    for (const [x, y] of [[-7, -30], [-2, -32], [4, -30], [-9, -26], [6, -26]]) {
      pixel(ctx, outline, x, y, 5, 4);
      pixel(ctx, hair, x + 1, y, 3, 3);
      pixel(ctx, light, x + 1, y + 1, 2);
    }
  } else if (index === 2) {
    pixel(ctx, outline, -3, -32, 8, 3);
    pixel(ctx, hair, -3, -31, 7, 3);
    pixel(ctx, light, -2, -31, 4);
    pixel(ctx, glint, -1, -30, 3);
  } else if (index === 3) {
    pixel(ctx, outline, -4, -32, 8, 4);
    pixel(ctx, hair, -3, -32, 6, 3);
    pixel(ctx, light, -2, -31, 4);
    pixel(ctx, '#be9a70', -3, -28, 6);
  } else if (index === 4) {
    pixel(ctx, hair, -5, -31, 10, 3);
    pixel(ctx, light, -4, -30, 8);
    pixel(ctx, glint, -3, -29, 4);
  }
}

function frontHead(ctx: Context, p: Palette, index: number, back: boolean) {
  const [shade, skin, light, cheek] = p.skin;
  const [deep, hair, hairLight] = p.hair;
  hairCap(ctx, p, index);
  // Stepped cheek/jaw outline keeps the large head round without antialiasing.
  pixel(ctx, outline, -9, -20, 18, 5);
  pixel(ctx, outline, -8, -16, 16, 2);
  pixel(ctx, outline, -6, -14, 12, 2);
  if (back) {
    pixel(ctx, deep, -9, -24, 18, 7);
    pixel(ctx, hair, -8, -25, 16, 9);
    pixel(ctx, hairLight, -7, -26, 3, 7);
    pixel(ctx, hairLight, -3, -24, 3, 2);
    pixel(ctx, deep, 6, -25, 2, 9);
    pixel(ctx, deep, -6, -16, 12, 3);
    pixel(ctx, hair, -5, -16, 10, 2);
    pixel(ctx, p.skin[0], -3, -13, 6);
    if (index === 5) {
      pixel(ctx, outline, -9, -20, 18, 9);
      pixel(ctx, hair, -8, -20, 16, 8);
      pixel(ctx, hairLight, -7, -21, 2, 7);
      pixel(ctx, deep, 5, -20, 2, 7);
      pixel(ctx, '#c59a82', -4, -13, 8);
    }
    return;
  }
  pixel(ctx, shade, -9, -22, 18, 6);
  pixel(ctx, skin, -8, -23, 16, 7);
  pixel(ctx, light, -6, -24, 11, 3);
  pixel(ctx, light, -7, -21, 14, 5);
  pixel(ctx, shade, -7, -16, 14, 2);
  pixel(ctx, skin, -6, -17, 12, 3);
  pixel(ctx, light, -4, -15, 8);
  pixel(ctx, skin, -5, -14, 10);
  pixel(ctx, shade, -10, -21, 2, 3);
  pixel(ctx, light, -9, -21, 2, 2);
  pixel(ctx, shade, 8, -21, 2, 3);
  pixel(ctx, skin, 8, -21, 1, 2);
  // Heavy brows, bright sclera and tiny dark pupils echo the reference portrait.
  pixel(ctx, deep, -6, -21, 3);
  pixel(ctx, deep, 3, -21, 3);
  pixel(ctx, '#fff5d8', -6, -18, 4, 2);
  pixel(ctx, '#fff5d8', 3, -18, 4, 2);
  pixel(ctx, '#3d3035', -4, -18, 2, 2);
  pixel(ctx, '#3d3035', 3, -18, 2, 2);
  pixel(ctx, '#fffbea', -4, -18, 1);
  pixel(ctx, '#fffbea', 3, -18, 1);
  pixel(ctx, cheek, -7, -16, 2);
  pixel(ctx, cheek, 6, -16, 2);
  pixel(ctx, `${shade}80`, 0, -16, 1);
  pixel(ctx, light, -1, -17, 1);
  pixel(ctx, '#b97d65', -1, -14, 3);
  // Side-parted locks taper into the forehead, never a flat helmet band.
  pixel(ctx, hair, -8, -26, 15, 2);
  pixel(ctx, hairLight, -7, -26, 5);
  pixel(ctx, deep, -9, -24, 3, 5);
  pixel(ctx, hair, -8, -24, 3, 3);
  pixel(ctx, hairLight, -7, -24, 2);
  pixel(ctx, hair, -5, -25, 3, 2);
  pixel(ctx, hair, 4, -25, 5, 3);
  pixel(ctx, deep, 7, -23, 2, 3);
  pixel(ctx, hairLight, 5, -24, 2);
  if (index === 1) {
    pixel(ctx, hair, -9, -22, 2, 6);
    pixel(ctx, hair, 8, -22, 2, 5);
    pixel(ctx, hairLight, -9, -22, 1, 3);
    pixel(ctx, '#deb376', 9, -17, 1, 2);
  } else if (index === 3) {
    pixel(ctx, deep, -7, -19, 5, 3);
    pixel(ctx, deep, 2, -19, 5, 3);
    pixel(ctx, '#d6d3cf', -6, -18, 2);
    pixel(ctx, '#d6d3cf', 3, -18, 2);
    pixel(ctx, deep, -2, -18, 4);
  } else if (index === 5) {
    pixel(ctx, outline, -10, -20, 3, 9);
    pixel(ctx, outline, 8, -20, 3, 9);
    pixel(ctx, hair, -9, -21, 2, 9);
    pixel(ctx, hair, 8, -21, 2, 9);
    pixel(ctx, hairLight, -9, -21, 1, 7);
    pixel(ctx, hairLight, 8, -21, 1, 6);
  }
}

function sideHead(ctx: Context, p: Palette, index: number) {
  const [shade, skin, light, cheek] = p.skin;
  const [deep, hair, hairLight] = p.hair;
  hairCap(ctx, p, index);
  pixel(ctx, outline, -8, -22, 18, 7);
  pixel(ctx, outline, -5, -16, 14, 2);
  pixel(ctx, outline, -3, -14, 11, 2);
  // One small nose step; keep the eye separated from the profile edge.
  pixel(ctx, outline, 9, -19, 2, 3);
  pixel(ctx, shade, 0, -24, 8, 10);
  pixel(ctx, skin, 2, -24, 7, 9);
  pixel(ctx, light, 3, -23, 5, 7);
  pixel(ctx, skin, 9, -18, 1);
  pixel(ctx, skin, 2, -15, 6);
  pixel(ctx, cheek, 6, -16, 2);
  pixel(ctx, deep, 4, -21, 3);
  pixel(ctx, '#fff5d8', 5, -18, 3, 2);
  pixel(ctx, '#3d3035', 7, -18, 1, 2);
  pixel(ctx, '#fffbea', 6, -18, 1);
  pixel(ctx, '#b97d65', 6, -14, 2);
  pixel(ctx, deep, -8, -26, 9, 11);
  pixel(ctx, hair, -8, -26, 7, 9);
  pixel(ctx, hairLight, -7, -26, 2, 6);
  pixel(ctx, hair, -2, -26, 8, 2);
  pixel(ctx, hairLight, -1, -25, 5);
  pixel(ctx, shade, -1, -21, 3, 4);
  pixel(ctx, skin, 0, -21, 2, 3);
  pixel(ctx, light, 0, -21, 1, 2);
  if (index === 3) {
    pixel(ctx, deep, 5, -19, 5, 3);
    pixel(ctx, '#d6d3cf', 6, -18, 2);
    pixel(ctx, deep, 1, -19, 4);
  }
  if (index === 5) {
    pixel(ctx, outline, -9, -20, 8, 9);
    pixel(ctx, hair, -8, -21, 6, 9);
    pixel(ctx, hairLight, -7, -21, 1, 7);
  }
}

function makeSprite(index: number, direction: Direction, seated: boolean, frame: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(40, 72);
  ctx.scale(direction === 'left' ? -2 : 2, 2);
  const p = palettes[index];
  const side = direction === 'left' || direction === 'right';
  const back = direction === 'up';
  const step = seated || frame === 0 ? 0 : frame === 1 ? -1 : 1;
  ctx.fillStyle = '#10152642';
  ctx.beginPath();
  ctx.ellipse(0, -1, 10.5, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  legs(ctx, p, side, seated, step);
  ctx.translate(0, seated ? 2 : step ? -1 : 0);
  torso(ctx, p, index, side, back, seated, step);
  if (side) sideHead(ctx, p, index);
  else frontHead(ctx, p, index, back);
  return canvas;
}

/** Original 64-pixel chibi sprites, anchored at the feet and cached by pose. */
export function drawAvatar(
  ctx: Context,
  x: number,
  y: number,
  avatar: number,
  facing: string,
  seated: boolean,
  frame = 0,
  scale = 1,
) {
  const index = ((Math.trunc(avatar) % palettes.length) + palettes.length) % palettes.length;
  const direction: Direction = facing === 'up' || facing === 'left' || facing === 'right' ? facing : 'down';
  const pose = seated || frame === 0 ? 0 : Math.floor(frame) % 2 === 0 ? 2 : 1;
  const key = `${index}:${direction}:${seated ? 1 : 0}:${pose}`;
  let sprite = sprites.get(key);
  if (!sprite) {
    sprite = makeSprite(index, direction, seated, pose);
    sprites.set(key, sprite);
  }
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, Math.round(x - 40 * scale), Math.round(y - 72 * scale), 80 * scale, 80 * scale);
  ctx.restore();
}
