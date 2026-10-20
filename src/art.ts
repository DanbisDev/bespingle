import { world, type Carpet, type Chair, type Decoration, type Rect } from './world';

type Context = CanvasRenderingContext2D;

// Original, deliberately drawn pixel clusters. One unit is one world pixel.
function block(ctx: Context, color: string, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function hash(x: number, y = 0): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function oval(ctx: Context, color: string, x: number, y: number, w: number, h: number) {
  for (let row = 0; row < h; row++) {
    const dy = (row + 0.5 - h / 2) / (h / 2);
    const inset = Math.round((1 - Math.sqrt(Math.max(0, 1 - dy * dy))) * w / 2);
    block(ctx, color, x + inset, y + row, Math.max(0, w - inset * 2), 1);
  }
}

function shadow(ctx: Context, rect: Rect, offset = 5) {
  block(ctx, '#11191b42', rect.x + offset, rect.y + offset, rect.w, rect.h);
  block(ctx, '#11191b23', rect.x + offset + 3, rect.y + offset + 3, rect.w, rect.h);
}

function diamond(ctx: Context, color: string, x: number, y: number, size: number) {
  for (let row = -size; row <= size; row++) {
    const half = size - Math.abs(row);
    block(ctx, color, x - half, y + row, half * 2 + 1, 1);
  }
}

function lightPool(ctx: Context, x: number, y: number, w: number, h: number, cool = false) {
  oval(ctx, cool ? '#68b6c007' : '#edc58606', x - w / 2, y - h / 2, w, h);
  oval(ctx, cool ? '#68b6c009' : '#edc58608', x - w * .38, y - h * .38, w * .76, h * .76);
  oval(ctx, cool ? '#68b6c00a' : '#edc5860a', x - w * .24, y - h * .24, w * .48, h * .48);
}

function floor(ctx: Context) {
  block(ctx, '#302d2c', 0, 0, world.width, world.height);
  const colors = ['#514039', '#57443b', '#4b3d37', '#5d483d', '#53423a', '#493c36', '#5a473d'];
  for (let y = 48; y < world.height; y += 12) {
    const offset = ((y / 12) % 4) * 24;
    for (let x = -96 + offset; x < world.width; x += 96) {
      const seed = hash(x, y);
      block(ctx, colors[Math.floor(seed * colors.length)], x + 1, y + 1, 95, 11);
      block(ctx, '#94705625', x + 2, y + 1, 92, 1);
      block(ctx, '#241f2045', x + 1, y + 11, 95, 1);
      block(ctx, '#342c2a50', x + 8, y + 5, 37 + Math.floor(seed * 36), 1);
      block(ctx, '#bc8f6020', x + 16, y + 7, 12 + Math.floor(seed * 56), 1);
      if (seed > .6) {
        block(ctx, '#352d2a66', x + 43, y + 4, 10, 1);
        block(ctx, '#352d2a44', x + 40, y + 5, 17, 1);
        block(ctx, '#a67b5120', x + 44, y + 6, 8, 1);
      }
      if (seed < .34) block(ctx, '#c1986c18', x + 5, y + 9, 49, 1);
      block(ctx, '#27252555', x + 94, y + 3, 1, 2);
      block(ctx, '#27252555', x + 94, y + 8, 1, 2);
    }
  }
  // A narrow inlaid perimeter gives the open floor a finished, architectural edge.
  block(ctx, '#ab805631', 40, 56, 1200, 2);
  block(ctx, '#ab805631', 40, 789, 1200, 2);
  block(ctx, '#ab805631', 40, 56, 2, 735);
  block(ctx, '#ab805631', 1238, 56, 2, 735);
  lightPool(ctx, 550, 100, 330, 145, true);
  lightPool(ctx, 988, 110, 370, 150, true);
  lightPool(ctx, 788, 720, 270, 170);
  lightPool(ctx, 210, 730, 380, 150);
  lightPool(ctx, 180, 535, 220, 110, true);
  lightPool(ctx, 1100, 647, 235, 110, true);
}

const rugPalettes = [
  { field: '#315e59', dark: '#203e40', shade: '#294d4b', trim: '#b6b795', flower: '#799c89' },
  { field: '#364c67', dark: '#233348', shade: '#2d4057', trim: '#bba98b', flower: '#7e96a6' },
  { field: '#724b54', dark: '#4b3441', shade: '#61424e', trim: '#c2a58b', flower: '#a4797d' },
];

function rugFlower(ctx: Context, x: number, y: number, trim: string, accent: string, size = 7) {
  diamond(ctx, trim, x, y, size);
  diamond(ctx, accent, x, y, size - 3);
  block(ctx, trim, x - 1, y - size - 4, 3, 3);
  block(ctx, trim, x - 1, y + size + 2, 3, 3);
  block(ctx, trim, x - size - 4, y - 1, 3, 3);
  block(ctx, trim, x + size + 2, y - 1, 3, 3);
}

function rug(ctx: Context, carpet: Carpet, index: number) {
  const { x, y, w, h } = carpet;
  const p = rugPalettes[index];
  shadow(ctx, carpet, 3);
  for (let fx = x + 4; fx < x + w - 3; fx += 4) {
    block(ctx, '#b0a28a', fx, y - 4, 1, 4);
    block(ctx, '#807b6b', fx + 1, y - 3, 1, 3);
    block(ctx, '#b0a28a', fx, y + h, 1, 4);
  }
  block(ctx, '#171f28', x, y, w, h);
  block(ctx, p.trim, x + 1, y + 1, w - 2, h - 2);
  block(ctx, p.dark, x + 3, y + 3, w - 6, h - 6);
  block(ctx, p.trim, x + 6, y + 6, w - 12, h - 12);
  block(ctx, p.dark, x + 7, y + 7, w - 14, h - 14);
  block(ctx, p.field, x + 17, y + 17, w - 34, h - 34);
  block(ctx, p.trim, x + 16, y + 16, w - 32, 1);
  block(ctx, p.trim, x + 16, y + h - 17, w - 32, 1);
  block(ctx, p.trim, x + 16, y + 16, 1, h - 32);
  block(ctx, p.trim, x + w - 17, y + 16, 1, h - 32);
  for (let fx = x + 23; fx < x + w - 16; fx += 16) {
    diamond(ctx, p.flower, fx, y + 11, 3);
    diamond(ctx, p.trim, fx, y + 11, 1);
    diamond(ctx, p.flower, fx, y + h - 12, 3);
    block(ctx, p.trim, fx - 5, y + 10, 2, 1);
    block(ctx, p.trim, fx - 5, y + h - 12, 2, 1);
  }
  for (let fy = y + 25; fy < y + h - 16; fy += 16) {
    diamond(ctx, p.flower, x + 11, fy, 3);
    diamond(ctx, p.trim, x + 11, fy, 1);
    diamond(ctx, p.flower, x + w - 12, fy, 3);
  }
  // Woven filigree and scattered rosettes remain legible around the furniture.
  for (let py = y + 26; py < y + h - 22; py += 22) {
    for (let px = x + 27; px < x + w - 21; px += 22) {
      block(ctx, '#ffffff08', px, py, 1, 2);
      block(ctx, '#101d2914', px + 6, py + 9, 2, 1);
      if ((Math.round((px - x) / 22) + Math.round((py - y) / 22)) % 3 === 0) {
        diamond(ctx, p.shade, px + 7, py + 3, 3);
        block(ctx, p.flower + '55', px + 7, py + 2, 1, 2);
      }
    }
  }
  for (const [cx, cy] of [[x + 32, y + 32], [x + w - 33, y + 32], [x + 32, y + h - 33], [x + w - 33, y + h - 33]]) {
    rugFlower(ctx, cx, cy, p.trim, p.field, 7);
    block(ctx, p.flower, cx + 11, cy - 1, 10, 1);
    block(ctx, p.flower, cx - 20, cy - 1, 9, 1);
    block(ctx, p.flower, cx, cy - 20, 1, 9);
    block(ctx, p.flower, cx, cy + 11, 1, 9);
  }
  // A fine diamond medallion peeks out from under each table.
  const cx = x + w / 2;
  const cy = y + h / 2;
  diamond(ctx, p.shade, cx, cy, Math.min(w, h) * .27);
  diamond(ctx, p.flower + '44', cx, cy, Math.min(w, h) * .22);
  diamond(ctx, p.field, cx, cy, Math.min(w, h) * .20);
}

function roomPlaque(ctx: Context, carpet: Carpet) {
  ctx.font = '600 10px ui-monospace, monospace';
  const plaqueWidth = Math.ceil(ctx.measureText(carpet.name.toUpperCase()).width) + 30;
  const x = carpet.x + (carpet.w - plaqueWidth) / 2;
  const y = carpet.y - 31;
  shadow(ctx, { x, y, w: plaqueWidth, h: 19 }, 2);
  block(ctx, '#182c32', x, y, plaqueWidth, 19);
  block(ctx, '#61807a', x, y, plaqueWidth, 1);
  block(ctx, '#b79666', x + 3, y + 7, 2, 4);
  block(ctx, '#b79666', x + plaqueWidth - 5, y + 7, 2, 4);
  block(ctx, '#2d4243', x + 7, y + 17, plaqueWidth - 14, 1);
  ctx.fillStyle = '#e0d6b9';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(carpet.name.toUpperCase(), carpet.x + carpet.w / 2, y + 10);
}

function wall(ctx: Context, rect: Rect) {
  const { x, y, w, h } = rect;
  shadow(ctx, { x, y, w: w + 2, h: h + 3 }, 5);
  block(ctx, '#202b31', x, y, w, h);
  const colors = ['#465256', '#414d52', '#4c5859', '#3e4b50', '#505a5a'];
  for (let row = 0; row < h; row += 8) {
    for (let col = -24 + (row % 16 === 0 ? 0 : 12); col < w; col += 24) {
      const left = Math.max(x, x + col + 1);
      const right = Math.min(x + w, x + col + 23);
      if (right <= left) continue;
      block(ctx, colors[Math.floor(hash(x + col, y + row) * colors.length)], left, y + row + 1, right - left, Math.min(6, h - row - 1));
      block(ctx, '#a1aba424', left, y + row + 1, right - left, 1);
      if (hash(x + col + 20, y + row) > .7) block(ctx, '#17252b22', left + 4, y + row + 4, Math.min(8, right - left - 4), 1);
    }
  }
  block(ctx, '#76817b', x, y, w, 2);
  block(ctx, '#252e30', x, y + h - 7, w, 7);
  block(ctx, '#8e7253', x, y + h - 7, w, 2);
  block(ctx, '#493f34', x, y + h - 5, w, 2);
  block(ctx, '#131f24', x, y + h - 1, w, 1);
  if (w < 40) {
    block(ctx, '#71808066', x, y, 2, h - 7);
    block(ctx, '#19282b88', x + w - 3, y + 2, 3, h - 9);
  }
}

function leaf(ctx: Context, x: number, y: number, flip: boolean, tone = 0) {
  const dark = tone ? '#235347' : '#2c5b47';
  const mid = tone ? '#367c62' : '#468561';
  const light = tone ? '#70ac78' : '#8ab678';
  const dir = flip ? -1 : 1;
  block(ctx, dark, x + (flip ? -13 : 0), y + 3, 14, 5);
  block(ctx, mid, x + (flip ? -11 : 0), y + 1, 12, 5);
  block(ctx, mid, x + (flip ? -7 : 0), y - 1, 8, 3);
  block(ctx, light, x + dir * 3 - (flip ? 6 : 0), y + 1, 6, 1);
  block(ctx, '#9ab97966', x + dir * 3, y + 3, 2, 1);
  block(ctx, dark, x + (flip ? -12 : 3), y + 6, 10, 2);
}

function plant(ctx: Context, d: Decoration) {
  const mid = Math.round(d.x + d.w / 2);
  const base = d.y + d.h;
  oval(ctx, '#11191b45', mid - 19, base - 7, 39, 11);
  // Glazed ceramic pot, brass stand, soil and layered split leaves.
  block(ctx, '#263d3f', mid - 11, base - 21, 22, 17);
  block(ctx, '#3c6061', mid - 10, base - 20, 20, 15);
  block(ctx, '#628381', mid - 9, base - 20, 4, 13);
  block(ctx, '#29484c', mid + 6, base - 19, 4, 14);
  block(ctx, '#243b3f', mid - 8, base - 5, 16, 3);
  block(ctx, '#9e8b63', mid - 9, base - 2, 2, 3);
  block(ctx, '#9e8b63', mid + 7, base - 2, 2, 3);
  oval(ctx, '#8ca39a', mid - 12, base - 23, 24, 6);
  oval(ctx, '#242d27', mid - 9, base - 22, 18, 4);
  block(ctx, '#466247', mid - 1, d.y + 9, 2, d.h - 30);
  block(ctx, '#76945a', mid, d.y + 8, 1, d.h - 30);
  const tops = [[-1, 3, false], [-2, 13, true], [1, 14, false], [-2, 24, true], [2, 25, false], [-1, 32, true], [1, 34, false]] as const;
  for (let i = 0; i < tops.length; i++) {
    const [lx, ly, flip] = tops[i];
    const sx = mid + lx;
    leaf(ctx, sx, d.y + ly, flip, i % 2);
    block(ctx, '#49764e', sx + (flip ? -2 : 0), d.y + ly + 6, 2, 7);
  }
  leaf(ctx, mid, d.y + 2, false, 1);
}

function chair(ctx: Context, seat: Chair) {
  const x = seat.x - 20;
  const y = seat.y - 27;
  const commons = seat.id.startsWith('commons');
  const studio = seat.id.startsWith('studio');
  const p = commons ? ['#674b43', '#a7775e', '#c19878', '#4f3d39'] : studio ? ['#293e51', '#4a7181', '#78a0a7', '#24333e'] : ['#29483f', '#548673', '#8db29a', '#223a34'];
  if (seat.facing === 'left' || seat.facing === 'right') {
    // A side chair has rails above and below its cushion, with its feet
    // attached to the lower rail. Mirror the complete frame as one piece.
    ctx.save();
    ctx.translate(seat.x, y);
    ctx.scale(seat.facing === 'left' ? -1 : 1, 1);
    oval(ctx, '#0e1a2149', -22, 29, 45, 19);
    for (const leg of [-13, 12]) {
      block(ctx, '#302d2a', leg, 33, 4, 13);
      block(ctx, '#615745', leg, 34, 1, 9);
      block(ctx, '#a99469', leg, 43, 4, 2);
    }
    // The far arm sits behind the cushion; the near arm closes its front edge.
    block(ctx, '#1a2c2d', -14, 7, 34, 7);
    block(ctx, p[0], -13, 8, 32, 5);
    block(ctx, p[1], -12, 8, 30, 3);
    block(ctx, p[2], -12, 8, 28, 1);
    block(ctx, '#16292d', -16, 12, 36, 22);
    block(ctx, p[0], -15, 13, 34, 21);
    block(ctx, p[1], -12, 14, 29, 17);
    block(ctx, p[2] + '99', -11, 15, 26, 1);
    block(ctx, p[3], -11, 28, 27, 3);
    block(ctx, '#ffffff10', -9, 18, 22, 1);
    for (let stitch = -8; stitch < 16; stitch += 5) block(ctx, p[2] + '77', stitch, 30, 2, 1);
    block(ctx, '#16282c', -22, -1, 12, 37);
    block(ctx, p[0], -21, 0, 10, 35);
    block(ctx, p[1], -19, 2, 6, 29);
    block(ctx, p[2], -19, 2, 2, 28);
    block(ctx, p[3], -13, 3, 1, 29);
    block(ctx, '#1a2c2d', -14, 29, 34, 7);
    block(ctx, p[0], -13, 30, 32, 5);
    block(ctx, p[1], -12, 30, 30, 3);
    block(ctx, p[2], -12, 30, 28, 1);
    block(ctx, p[3], -12, 34, 30, 1);
    ctx.restore();
    return;
  }
  oval(ctx, '#0e1a2149', x - 1, y + 29, 45, 19);
  // Exposed walnut frame and slender brass foot caps.
  for (const leg of [4, 32]) {
    block(ctx, '#302d2a', x + leg, y + 32, 4, 14);
    block(ctx, '#a99469', x + leg, y + 43, 4, 2);
    block(ctx, '#615745', x + leg, y + 33, 1, 10);
  }
  block(ctx, '#16292d', x + 1, y + 6, 39, 30);
  block(ctx, p[0], x + 3, y + 7, 35, 29);
  block(ctx, p[1], x + 6, y + 9, 29, 22);
  block(ctx, p[2] + '99', x + 7, y + 10, 26, 2);
  block(ctx, p[3], x + 7, y + 29, 27, 3);
  block(ctx, '#ffffff10', x + 10, y + 14, 22, 1);
  block(ctx, '#10282b25', x + 9, y + 26, 22, 1);
  for (let stitch = 11; stitch < 32; stitch += 5) block(ctx, p[2] + '77', x + stitch, y + 31, 2, 1);
  if (seat.facing === 'down') {
    block(ctx, '#17272a', x, y - 3, 41, 17);
    block(ctx, p[0], x + 2, y - 2, 37, 15);
    block(ctx, p[1], x + 4, y, 33, 10);
    block(ctx, p[2], x + 5, y, 30, 2);
    block(ctx, p[3], x + 4, y + 10, 33, 3);
    block(ctx, p[0], x + 19, y + 3, 1, 6);
  } else if (seat.facing === 'up') {
    block(ctx, '#17272a', x, y + 29, 41, 13);
    block(ctx, p[0], x + 2, y + 29, 37, 11);
    block(ctx, p[1], x + 4, y + 30, 33, 7);
    block(ctx, p[2], x + 5, y + 30, 31, 1);
    block(ctx, p[3], x + 3, y + 38, 35, 2);
  }
  block(ctx, '#1a2c2d', x - 2, y + 14, 7, 22);
  block(ctx, '#1a2c2d', x + 36, y + 14, 7, 22);
  block(ctx, p[1], x - 1, y + 14, 5, 18);
  block(ctx, p[1], x + 37, y + 14, 5, 18);
  block(ctx, p[2], x, y + 14, 3, 2);
  block(ctx, p[2], x + 38, y + 14, 3, 2);
}

function mug(ctx: Context, x: number, y: number, color = '#ddd4b7') {
  oval(ctx, '#16202736', x - 1, y + 7, 14, 5);
  block(ctx, '#28373b', x + 7, y + 2, 5, 6);
  block(ctx, color, x + 8, y + 3, 3, 4);
  block(ctx, '#675b49', x + 9, y + 4, 1, 2);
  block(ctx, color, x, y + 1, 8, 8);
  block(ctx, '#ffffff44', x + 1, y + 2, 2, 5);
  block(ctx, '#8a715c', x + 6, y + 2, 1, 6);
  block(ctx, '#3c3028', x + 1, y, 6, 2);
  block(ctx, '#bb9e75', x + 2, y + 1, 3, 1);
}

function book(ctx: Context, x: number, y: number, color = '#4f8283') {
  block(ctx, '#182b30', x, y, 21, 15);
  block(ctx, '#c4bea5', x + 2, y + 11, 18, 3);
  block(ctx, color, x + 1, y, 19, 12);
  block(ctx, '#ffffff26', x + 2, y + 1, 2, 10);
  block(ctx, '#1d2a2b55', x + 4, y + 1, 1, 10);
  block(ctx, '#dacda65c', x + 8, y + 4, 8, 1);
  block(ctx, '#dacda644', x + 9, y + 6, 6, 1);
  block(ctx, '#777963', x + 4, y + 13, 14, 1);
  block(ctx, '#bd8759', x + 15, y + 11, 2, 6);
}

function woodSurface(ctx: Context, x: number, y: number, w: number, h: number) {
  block(ctx, '#1b2528', x - 2, y - 2, w + 4, h + 9);
  block(ctx, '#533e32', x, y + 4, w, h + 2);
  block(ctx, '#8c6548', x, y, w, h - 1);
  block(ctx, '#a17a54', x + 2, y + 1, w - 4, 2);
  block(ctx, '#bd956324', x + 4, y + 4, w - 8, h - 10);
  block(ctx, '#654a37', x + 2, y + h - 4, w - 4, 3);
  block(ctx, '#bd9365', x, y + h - 1, w, 1);
  for (let line = x + 25; line < x + w - 8; line += 27) {
    block(ctx, '#4e3c303c', line, y + 4, 1, h - 10);
    block(ctx, '#c3925824', line + 2, y + 5, 1, h - 12);
  }
  for (let line = y + 10; line < y + h - 8; line += 15) {
    const start = x + 6 + Math.floor(hash(line, x) * 22);
    block(ctx, '#cc9a5e22', start, line, w - 34, 1);
    block(ctx, '#342f2724', start + 10, line + 2, w - 46, 1);
  }
}

function table(ctx: Context, d: Decoration) {
  const { x, y, w, h } = d;
  shadow(ctx, d, 6);
  if (d.type === 'round-table') {
    oval(ctx, '#172329', x - 2, y - 1, w + 4, h + 8);
    oval(ctx, '#574235', x, y + 5, w, h + 1);
    oval(ctx, '#ad8358', x, y, w, h - 2);
    oval(ctx, '#b99a70', x + 3, y + 1, w - 6, h - 6);
    oval(ctx, '#94734f', x + 5, y + 4, w - 10, h - 10);
    oval(ctx, '#a9885f', x + 6, y + 5, w - 12, h - 12);
    for (let gy = y + 11; gy < y + h - 10; gy += 8) block(ctx, '#715b4033', x + 9, gy, w - 18, 1);
    oval(ctx, '#253c3c', x + 9, y + 15, 17, 14);
    mug(ctx, x + 13, y + 15, '#9fc5ba');
    mug(ctx, x + 42, y + 30, '#d3ba8c');
    block(ctx, '#d0b17b', x + 33, y + 13, 8, 10);
    block(ctx, '#dcd2af', x + 34, y + 13, 6, 1);
    block(ctx, '#7f9b69', x + 35, y + 8, 2, 7);
    block(ctx, '#9ab77c', x + 31, y + 8, 5, 3);
  } else {
    woodSurface(ctx, x, y, w, h);
    if (d.type === 'side-table') {
      book(ctx, x + 10, y + 12, '#936574');
      book(ctx, x + 12, y + 9, '#426970');
      oval(ctx, '#5e51395c', x + w - 26, y + 30, 19, 15);
      mug(ctx, x + w - 23, y + 28);
    } else {
      // A restrained felt runner, notebooks, brass pencil and a small ceramic vase.
      const vertical = h > w;
      block(ctx, '#31505099', x + (vertical ? 48 : 28), y + 8, vertical ? 32 : w - 56, h - 18);
      block(ctx, '#a4b0a533', x + (vertical ? 49 : 29), y + 9, vertical ? 1 : w - 58, vertical ? h - 20 : 1);
      book(ctx, x + 15, y + 14);
      mug(ctx, x + w - 25, y + h - 23, '#b6c5b5');
      block(ctx, '#d5cdaf', x + w - 43, y + 17, 22, 17);
      block(ctx, '#bbb397', x + w - 41, y + 19, 1, 13);
      for (let ln = 0; ln < 3; ln++) block(ctx, '#8b947f', x + w - 37, y + 22 + ln * 3, 11 - ln * 2, 1);
      block(ctx, '#323e41', x + w - 44, y + 36, 25, 2);
      block(ctx, '#c2a36a', x + w - 43, y + 36, 4, 1);
      oval(ctx, '#29414288', x + w / 2 - 9, y + h / 2 + 5, 19, 7);
      block(ctx, '#b3bba9', x + w / 2 - 5, y + h / 2 - 5, 10, 13);
      block(ctx, '#d4d2b8', x + w / 2 - 4, y + h / 2 - 6, 8, 3);
      block(ctx, '#3e755a', x + w / 2, y + h / 2 - 20, 1, 16);
      leaf(ctx, x + w / 2, y + h / 2 - 19, true, 1);
      leaf(ctx, x + w / 2, y + h / 2 - 14, false, 0);
    }
  }
}

function desk(ctx: Context, d: Decoration) {
  const { x, y, w, h } = d;
  shadow(ctx, { x, y, w, h: h + 8 });
  block(ctx, '#1a282c', x + 7, y + h - 1, 5, 15);
  block(ctx, '#1a282c', x + w - 12, y + h - 1, 5, 15);
  block(ctx, '#778278', x + 7, y + h + 11, 5, 2);
  block(ctx, '#778278', x + w - 12, y + h + 11, 5, 2);
  woodSurface(ctx, x, y, w, h);
  block(ctx, '#29474b', x + 35, y + 28, w - 63, 27);
  block(ctx, '#617c7544', x + 37, y + 29, w - 67, 1);
  const sx = x + w / 2 - 29;
  // Thin bezel, ambient blue light, editor windows and a brass monitor stand.
  block(ctx, '#121f26', sx - 1, y + 3, 60, 34);
  block(ctx, '#445c61', sx, y + 3, 58, 33);
  block(ctx, '#102b3c', sx + 2, y + 5, 54, 28);
  block(ctx, '#345c72', sx + 3, y + 6, 52, 3);
  block(ctx, '#6ca7b6', sx + 5, y + 7, 1, 1);
  block(ctx, '#cf9b71', sx + 8, y + 7, 1, 1);
  block(ctx, '#1d414e', sx + 3, y + 10, 12, 22);
  for (let line = 0; line < 5; line++) {
    block(ctx, '#779da0', sx + 5, y + 12 + line * 4, 6 + line % 3, 1);
    block(ctx, ['#8ac6bd', '#d9b786', '#73b0c1'][line % 3], sx + 19 + line % 2 * 3, y + 12 + line * 4, 23 - line % 3 * 5, 1);
    block(ctx, '#4f8791', sx + 20 + line % 2 * 2, y + 14 + line * 4, 17 - line % 3 * 3, 1);
  }
  block(ctx, '#61bfa3', sx + 50, y + 35, 2, 1);
  block(ctx, '#394c50', sx + 26, y + 37, 6, 6);
  block(ctx, '#a99872', sx + 17, y + 42, 24, 2);
  block(ctx, '#182d32', sx - 1, y + 47, 57, 9);
  block(ctx, '#708e8b', sx, y + 47, 55, 7);
  for (let row = 0; row < 2; row++) {
    for (let key = 0; key < 12; key++) block(ctx, '#b6c3b0', sx + 2 + key * 4, y + 48 + row * 2, 3, 1);
  }
  block(ctx, '#bcc9b5', sx + 15, y + 52, 22, 1);
  block(ctx, '#80a49b', x + w - 32, y + 44, 6, 9);
  block(ctx, '#c0d3bd', x + w - 31, y + 44, 4, 2);
  mug(ctx, x + w - 22, y + 18, '#d3c09c');
  book(ctx, x + 8, y + 34, '#59756a');
  block(ctx, '#d0b076', x + 12, y + 23, 15, 1);
  block(ctx, '#1d3236', x + 10, y + 22, 3, 2);
}

function bookshelf(ctx: Context, d: Decoration) {
  const { x, y, w, h } = d;
  shadow(ctx, d, 5);
  block(ctx, '#1a272b', x - 2, y - 2, w + 4, h + 6);
  block(ctx, '#74543d', x, y, w, h);
  block(ctx, '#283034', x + 6, y + 6, w - 12, h - 10);
  block(ctx, '#c39d6544', x + 6, y + 6, w - 12, 3);
  const colors = ['#b29068', '#61948b', '#b7745b', '#60879d', '#946d8b', '#b7aa79', '#7e9271', '#d2bea0'];
  for (let row = 0; row < 2; row++) {
    const base = y + 27 + row * 26;
    let bx = x + 9;
    let count = 0;
    while (bx < x + w - 12) {
      const bw = 3 + Math.floor(hash(bx, row) * 5);
      const bh = 13 + Math.floor(hash(bx + 50, row) * 7);
      const color = colors[(count + row * 3) % colors.length];
      block(ctx, '#141e2544', bx + 1, base - bh - 1, bw, bh + 1);
      block(ctx, color, bx, base - bh, bw, bh);
      block(ctx, '#f1dcba66', bx + 1, base - bh + 3, Math.max(1, bw - 2), 1);
      block(ctx, '#141d2455', bx + bw - 1, base - bh, 1, bh);
      if (bw > 5) block(ctx, '#e4d7b450', bx + 1, base - 4, bw - 2, 1);
      bx += bw + 2;
      count++;
    }
    block(ctx, '#a47a4d', x + 3, base + 1, w - 6, 3);
    block(ctx, '#c9a46c', x + 3, base + 1, w - 6, 1);
    block(ctx, '#342c28', x + 3, base + 4, w - 6, 2);
  }
  block(ctx, '#9b754f', x - 3, y - 3, w + 6, 5);
  block(ctx, '#c3a06d', x - 2, y - 3, w + 4, 1);
  block(ctx, '#c4a37244', x + 2, y + 1, 1, h - 2);
  block(ctx, '#c4a37244', x + w - 3, y + 1, 1, h - 2);
}

function sofa(ctx: Context, d: Decoration) {
  const { x, y, w, h } = d;
  shadow(ctx, d, 6);
  block(ctx, '#252c2b', x + 9, y + h - 3, 5, 11);
  block(ctx, '#252c2b', x + w - 14, y + h - 3, 5, 11);
  block(ctx, '#ae976c', x + 9, y + h + 5, 5, 2);
  block(ctx, '#ae976c', x + w - 14, y + h + 5, 5, 2);
  block(ctx, '#172d32', x - 2, y - 2, w + 4, h + 3);
  block(ctx, '#345b60', x, y, w, h);
  block(ctx, '#497578', x + 4, y + 2, w - 8, 23);
  block(ctx, '#729590', x + 5, y + 2, w - 10, 2);
  block(ctx, '#31545a', x + 4, y + 23, w - 8, 4);
  const cushionWidth = (w - 37) / 3;
  for (let cushion = 0; cushion < 3; cushion++) {
    const cx = Math.round(x + 16 + (cushionWidth + 2) * cushion);
    block(ctx, '#4d797a', cx, y + 28, cushionWidth, 24);
    block(ctx, '#72968e', cx + 1, y + 28, cushionWidth - 2, 1);
    block(ctx, '#2b5258', cx + 1, y + 51, cushionWidth - 2, 2);
    block(ctx, '#23434b', cx + cushionWidth - 1, y + 29, 1, 23);
    block(ctx, '#7fa09633', cx + 5, y + 31, cushionWidth - 10, 1);
  }
  block(ctx, '#244950', x + 1, y + 16, 13, h - 17);
  block(ctx, '#244950', x + w - 14, y + 16, 13, h - 17);
  block(ctx, '#608989', x + 2, y + 15, 11, 7);
  block(ctx, '#608989', x + w - 13, y + 15, 11, 7);
  block(ctx, '#8ba59a', x + 3, y + 15, 9, 1);
  block(ctx, '#8ba59a', x + w - 12, y + 15, 9, 1);
  // A tasseled copper cushion and soft folded throw.
  block(ctx, '#6d4e42', x + 19, y + 9, 22, 21);
  block(ctx, '#c59369', x + 20, y + 10, 20, 18);
  block(ctx, '#d7b58b', x + 22, y + 11, 16, 2);
  diamond(ctx, '#ead0a655', x + 30, y + 19, 5);
  block(ctx, '#7f8a7c', x + w - 39, y + 20, 18, 33);
  block(ctx, '#c2c0a5', x + w - 37, y + 21, 2, 31);
  block(ctx, '#c2c0a5', x + w - 27, y + 21, 2, 31);
  for (let fringe = 0; fringe < 6; fringe++) block(ctx, '#c2c0a5', x + w - 38 + fringe * 3, y + 53, 1, 4);
  block(ctx, '#193a42', x + 7, y + h - 5, w - 14, 3);
}

function coffeeBar(ctx: Context, d: Decoration) {
  const { x, y, w, h } = d;
  shadow(ctx, d, 5);
  block(ctx, '#1c2b2f', x - 2, y + 4, w + 4, h);
  block(ctx, '#274b50', x, y + 11, w, h - 11);
  for (let cabinet = x + 4; cabinet < x + w - 12; cabinet += 49) {
    block(ctx, '#172e36', cabinet, y + 18, 43, h - 21);
    block(ctx, '#376064', cabinet + 2, y + 20, 39, h - 25);
    block(ctx, '#72918a66', cabinet + 3, y + 20, 37, 1);
    block(ctx, '#233f46', cabinet + 4, y + 22, 1, h - 29);
    block(ctx, '#c6a16b', cabinet + 28, y + 24, 8, 2);
    block(ctx, '#263333', cabinet + 29, y + 26, 8, 1);
  }
  block(ctx, '#25363a', x - 3, y, w + 6, 15);
  block(ctx, '#c3bba4', x - 3, y - 2, w + 6, 12);
  block(ctx, '#e1d8bb', x - 2, y - 2, w + 4, 2);
  block(ctx, '#817d6a', x - 3, y + 10, w + 6, 3);
  for (let vein = 0; vein < 12; vein++) {
    const vx = x + 4 + Math.floor(hash(vein, y) * (w - 12));
    block(ctx, '#5e756326', vx, y + 2 + vein % 4, 8 + vein % 7, 1);
  }
  // Copper and charcoal espresso machine, portafilter and stacked ceramic cups.
  block(ctx, '#14262c', x + 16, y - 27, 42, 32);
  block(ctx, '#9b7354', x + 18, y - 26, 38, 16);
  block(ctx, '#ceab7c', x + 20, y - 25, 34, 2);
  block(ctx, '#5a584c', x + 20, y - 10, 34, 12);
  block(ctx, '#1c2e31', x + 23, y - 9, 28, 8);
  block(ctx, '#9ca99b', x + 27, y - 12, 17, 3);
  block(ctx, '#17292f', x + 39, y - 11, 11, 2);
  block(ctx, '#89c6ac', x + 49, y - 21, 3, 3);
  oval(ctx, '#344946', x + 22, y - 23, 7, 7);
  block(ctx, '#c9c8af', x + 25, y - 22, 1, 3);
  block(ctx, '#b5c8b7', x + 30, y - 6, 9, 6);
  block(ctx, '#879585', x + 19, y + 3, 36, 2);
  mug(ctx, x + 70, y - 1, '#a9c4b3');
  mug(ctx, x + 84, y - 1, '#d7ba8b');
  block(ctx, '#d2c9ad', x + 72, y - 8, 7, 6);
  block(ctx, '#a3b9a5', x + 73, y - 7, 5, 3);
  block(ctx, '#6b8b8b', x + 153, y - 1, 44, 9);
  block(ctx, '#233f47', x + 156, y, 38, 6);
  block(ctx, '#bac6b3', x + 177, y - 14, 3, 17);
  block(ctx, '#bac6b3', x + 177, y - 14, 12, 3);
  block(ctx, '#637e79', x + 179, y - 11, 1, 11);
  book(ctx, x + 229, y - 2, '#a67859');
  block(ctx, '#a77a57', x + w - 24, y - 8, 14, 13);
  block(ctx, '#d0ac76', x + w - 24, y - 8, 14, 2);
  block(ctx, '#345f4c', x + w - 22, y - 19, 3, 14);
  leaf(ctx, x + w - 20, y - 22, true, 1);
  leaf(ctx, x + w - 20, y - 17, false, 0);
}

function windowArt(ctx: Context, d: Decoration) {
  const { x, y, w, h } = d;
  block(ctx, '#17282f', x - 4, y - 3, w + 8, h + 6);
  block(ctx, '#879491', x - 2, y - 2, w + 4, h + 4);
  block(ctx, '#20344a', x, y, w, h);
  block(ctx, '#29415b', x + 1, y + 7, w - 2, 8);
  block(ctx, '#334f65', x + 1, y + 15, w - 2, h - 16);
  for (let sx = x + 6; sx < x + w - 4; sx += 13) {
    const bh = 7 + Math.floor(hash(sx, x) * 15);
    const bw = 9 + Math.floor(hash(sx, y) * 5);
    block(ctx, '#172d3d', sx, y + h - bh, bw, bh);
    block(ctx, '#53687b44', sx, y + h - bh, bw, 1);
    for (let ly = y + h - bh + 3; ly < y + h - 2; ly += 4) {
      if (hash(sx, ly) > .45) block(ctx, '#d1ad7177', sx + 3, ly, 2, 1);
      if (hash(sx + 12, ly) > .65) block(ctx, '#8bb6b36e', sx + 7, ly, 2, 1);
    }
  }
  block(ctx, '#d3d3b1', x + w - 31, y + 5, 3, 3);
  block(ctx, '#9fb9bb88', x + 15, y + 6, 1, 1);
  block(ctx, '#9fb9bb88', x + 39, y + 4, 1, 1);
  block(ctx, '#a9c3bf16', x + 5, y + 2, 9, h - 4);
  block(ctx, '#a9c3bf10', x + 17, y + 2, 3, h - 4);
  for (let mullion = x + 51; mullion < x + w; mullion += 51) {
    block(ctx, '#142a33', mullion - 1, y, 5, h);
    block(ctx, '#788c89', mullion, y, 2, h);
  }
  block(ctx, '#a5a68f', x - 5, y + h - 1, w + 10, 3);
  block(ctx, '#4a5755', x - 5, y + h + 2, w + 10, 3);
}

function decoration(ctx: Context, d: Decoration) {
  const { x, y, w, h } = d;
  switch (d.type) {
    case 'plant': plant(ctx, d); break;
    case 'round-table':
    case 'meeting-table':
    case 'side-table': table(ctx, d); break;
    case 'desk': desk(ctx, d); break;
    case 'bookshelf': bookshelf(ctx, d); break;
    case 'sofa': sofa(ctx, d); break;
    case 'coffee-bar': coffeeBar(ctx, d); break;
    case 'planter': {
      shadow(ctx, d, 5);
      block(ctx, '#172c30', x, y + 9, w, h - 7);
      block(ctx, '#526e68', x + 2, y + 11, w - 4, h - 13);
      block(ctx, '#8fa28a', x + 2, y + 10, w - 4, 2);
      block(ctx, '#233b3e', x + 4, y + h - 5, w - 8, 3);
      block(ctx, '#b5996b', x - 2, y + 7, w + 4, 4);
      block(ctx, '#cbb58a', x - 2, y + 7, w + 4, 1);
      block(ctx, '#27382d', x + 4, y + 2, w - 8, 5);
      for (let px = x + 13; px < x + w - 8; px += 17) {
        const top = y - 6 - Math.floor(hash(px) * 12);
        block(ctx, '#255345', px - 1, top + 4, 5, 22);
        block(ctx, '#5c9363', px, top, 3, 23);
        block(ctx, '#93b576', px + 1, top + 1, 1, 16);
        leaf(ctx, px, top + 10, true, 1);
        leaf(ctx, px + 2, top + 3, false, 0);
      }
      for (let rib = x + 12; rib < x + w - 8; rib += 16) block(ctx, '#bbba8d26', rib, y + 16, 1, h - 25);
      break;
    }
    case 'lamp':
      oval(ctx, '#131f2966', x + 4, y + h - 7, w - 4, 10);
      block(ctx, '#203138', x + w / 2 - 2, y + 19, 4, h - 23);
      block(ctx, '#b49b6b', x + w / 2 - 1, y + 20, 1, h - 27);
      block(ctx, '#d3bd8a', x + 7, y, w - 14, 4);
      block(ctx, '#d6c49a', x + 5, y + 4, w - 10, 6);
      block(ctx, '#dfcda4', x + 2, y + 10, w - 4, 10);
      block(ctx, '#ecd9ad', x, y + 19, w, 3);
      block(ctx, '#a6895f', x, y + 22, w, 2);
      for (let pleat = x + 6; pleat < x + w - 5; pleat += 5) block(ctx, '#9b886333', pleat, y + 10, 1, 9);
      break;
    case 'window': windowArt(ctx, d); break;
    case 'noticeboard':
      block(ctx, '#17272c', x - 2, y - 2, w + 4, h + 4);
      block(ctx, '#97734c', x, y, w, h);
      block(ctx, '#b69461', x + 2, y + 2, w - 4, 1);
      block(ctx, '#5c6860', x + 4, y + 4, w - 8, h - 8);
      for (let i = 0; i < 5; i++) {
        const nx = x + 10 + i * 31;
        const ny = y + 8 + i % 2 * 2;
        block(ctx, '#1e333247', nx + 2, ny + 2, 22, 20);
        block(ctx, ['#d6c698', '#90b9ac', '#c99b80', '#99b5c8', '#c4afc2'][i], nx, ny, 22, 20);
        block(ctx, '#f2deae88', nx + 1, ny, 20, 1);
        block(ctx, '#c5aa71', nx + 10, ny - 1, 2, 3);
        block(ctx, '#4e6f695c', nx + 4, ny + 8, 13, 1);
        block(ctx, '#4e6f6944', nx + 4, ny + 11, 9, 1);
        block(ctx, '#4e6f6944', nx + 4, ny + 14, 11, 1);
      }
      break;
    case 'picture':
      block(ctx, '#1a2d33', x, y, w, h);
      block(ctx, '#baa175', x + 1, y + 1, w - 2, h - 2);
      block(ctx, '#d3c4a1', x + 3, y + 3, w - 6, h - 6);
      block(ctx, '#3c6571', x + 5, y + 5, w - 10, h - 10);
      diamond(ctx, '#a6b6a2', x + 12, y + 16, 7);
      diamond(ctx, '#638d80', x + 20, y + 18, 8);
      block(ctx, '#dbb67a', x + w - 11, y + 6, 3, 3);
      break;
    case 'clock':
      oval(ctx, '#172b32', x - 2, y - 2, w + 4, h + 4);
      oval(ctx, '#bd9f6c', x - 1, y - 1, w + 2, h + 2);
      oval(ctx, '#d5d1b5', x + 1, y + 1, w - 2, h - 2);
      block(ctx, '#75827a', x + w / 2, y + 3, 1, 2);
      block(ctx, '#75827a', x + w / 2, y + h - 5, 1, 2);
      block(ctx, '#75827a', x + 3, y + h / 2, 2, 1);
      block(ctx, '#75827a', x + w - 5, y + h / 2, 2, 1);
      block(ctx, '#334a4b', x + w / 2 - 1, y + 6, 2, h / 2 - 5);
      block(ctx, '#334a4b', x + w / 2 - 1, y + h / 2 - 1, 7, 2);
      block(ctx, '#a97a53', x + w / 2 - 1, y + h / 2 - 1, 2, 2);
      break;
  }
}

/** Static original pixel scenery, cached by the game renderer. Geometry lives in world.json. */
export function drawGameWorld(ctx: Context) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  floor(ctx);
  world.carpets.forEach((carpet, index) => rug(ctx, carpet, index));
  world.walls.forEach((rect) => wall(ctx, rect));
  const furnishings = [
    ...world.decorations.map((item) => ({ y: item.y + item.h, draw: () => decoration(ctx, item) })),
    ...world.chairs.map((item) => ({ y: item.y + 19, draw: () => chair(ctx, item) })),
  ].sort((a, b) => a.y - b.y);
  furnishings.forEach((item) => item.draw());
  world.carpets.forEach((carpet) => roomPlaque(ctx, carpet));
  // Small brass wall sconces cast a warm counterpoint to the blue evening windows.
  for (const sx of [378, 678, 850, 1120]) {
    block(ctx, '#1b2b31', sx, 14, 9, 22);
    block(ctx, '#9d845c', sx + 2, 16, 5, 17);
    block(ctx, '#d6bd86', sx + 1, 17, 7, 8);
    block(ctx, '#eddbac', sx + 2, 17, 5, 6);
    block(ctx, '#edc88a0b', sx - 8, 8, 25, 29);
  }
  ctx.font = '500 9px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#c5b18b80';
  ctx.fillText('A LITTLE ROOM TO THINK.', 66, 482);
  ctx.fillStyle = '#baad8a65';
  ctx.fillText('COFFEE & GOOD COMPANY', 69, 797);
  ctx.restore();
}

export { drawAvatar } from './avatarArt';
