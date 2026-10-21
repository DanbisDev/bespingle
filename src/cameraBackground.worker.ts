import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import simdLoader from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js?url';
import simdBinary from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm?url';
import plainLoader from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js?url';
import plainBinary from '../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm?url';

let segmenter: ImageSegmenter;
let backgroundImage: ImageBitmap | undefined;
const mask = new OffscreenCanvas(256, 144);
const maskContext = mask.getContext('2d')!;
let canvas: OffscreenCanvas;
let context: OffscreenCanvasRenderingContext2D;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      backgroundImage = data.image;
      const simd = await FilesetResolver.isSimdSupported();
      segmenter = await ImageSegmenter.createFromOptions({
        wasmLoaderPath: new URL(simd ? simdLoader : plainLoader, data.origin).href,
        wasmBinaryPath: new URL(simd ? simdBinary : plainBinary, data.origin).href,
      }, {
        baseOptions: { modelAssetPath: data.model }, runningMode: 'VIDEO',
        outputConfidenceMasks: true, outputCategoryMask: false,
      });
      self.postMessage({ type: 'ready' });
      return;
    }
    const frame = data.frame as ImageBitmap;
    try {
      if (!canvas || canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas = new OffscreenCanvas(frame.width, frame.height);
        context = canvas.getContext('2d')!;
      }
      segmenter.segmentForVideo(frame, data.timestamp, (result) => {
        // The binary selfie model returns one foreground confidence mask.
        const confidence = result.confidenceMasks![0];
        if (mask.width !== confidence.width || mask.height !== confidence.height) {
          mask.width = confidence.width; mask.height = confidence.height;
        }
        const values = confidence.getAsFloat32Array();
        const pixels = maskContext.createImageData(mask.width, mask.height);
        for (let i = 0; i < values.length; i++) {
          const alpha = Math.max(0, Math.min(1, (values[i] - 0.2) / 0.6));
          pixels.data[i * 4 + 3] = Math.round(alpha * alpha * (3 - 2 * alpha) * 255);
        }
        maskContext.putImageData(pixels, 0, 0);
        const { width: w, height: h } = canvas;
        context.globalCompositeOperation = 'copy';
        context.drawImage(mask, 0, 0, w, h);
        context.globalCompositeOperation = 'source-in';
        context.drawImage(frame, 0, 0);
        context.globalCompositeOperation = 'destination-over';
        if (data.background === 'blur') {
          context.filter = 'blur(16px)';
          context.drawImage(frame, -24, -24, w + 48, h + 48);
          context.filter = 'none';
        } else if (backgroundImage) {
          const scale = Math.max(w / backgroundImage.width, h / backgroundImage.height);
          const width = backgroundImage.width * scale; const height = backgroundImage.height * scale;
          context.drawImage(backgroundImage, (w - width) / 2, (h - height) / 2, width, height);
        } else {
          const colors = data.background === 'forest' ? ['#173c39', '#708c66'] : ['#162c53', '#8bb8ce'];
          const gradient = context.createLinearGradient(0, 0, w, h);
          gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[1]);
          context.fillStyle = gradient; context.fillRect(0, 0, w, h);
        }
        context.globalCompositeOperation = 'source-over';
      });
      const output = canvas.transferToImageBitmap();
      self.postMessage({ type: 'frame', frame: output }, { transfer: [output] });
    } finally { frame.close(); }
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
