import { useEffect, useRef, useState } from 'react';

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const BACKGROUND = '#1a2233';
const COLORS = ['#ffffff', '#ff4444', '#44aaff', '#44dd66', '#ffcc00', '#ff88ff'];

export function Whiteboard({ onStream, onClose }: { onStream: (stream: MediaStream) => void; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawing = useRef(false);
  const [color, setColor] = useState(COLORS[0]);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctxRef.current = ctx;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const stream = canvas.captureStream(20);
    streamRef.current = stream;
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = 'detail';
    onStream(stream);
    // No cleanup — usePeerMedia owns the stream after onStream/startWhiteboard.
    // stopScreen handles track lifecycle on close or carpet change.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toCanvas = (event: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (CANVAS_WIDTH / rect.width), y: (event.clientY - rect.top) * (CANVAS_HEIGHT / rect.height) };
  };

  const onPointerDown = (event: React.PointerEvent) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);
    drawing.current = true;
    const ctx = ctxRef.current!;
    ctx.beginPath();
    ctx.strokeStyle = tool === 'eraser' ? BACKGROUND : color;
    ctx.lineWidth = tool === 'eraser' ? 24 : 3;
    const { x, y } = toCanvas(event);
    ctx.moveTo(x, y);
    // Draw a dot for single clicks.
    ctx.lineTo(x + 0.1, y);
    ctx.stroke();
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = ctxRef.current!;
    const { x, y } = toCanvas(event);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const onPointerUp = () => { drawing.current = false; };

  const clear = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  };

  return <div className="whiteboard-backdrop">
    <div className="whiteboard-panel">
      <div className="whiteboard-toolbar">
        <div className="whiteboard-colors">
          {COLORS.map((c) => <button key={c} type="button" className="whiteboard-color" style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={tool === 'pen' && color === c} onClick={() => { setColor(c); setTool('pen'); }} />)}
        </div>
        <button type="button" className="whiteboard-tool" aria-pressed={tool === 'eraser'} onClick={() => setTool(tool === 'eraser' ? 'pen' : 'eraser')}>Eraser</button>
        <button type="button" className="whiteboard-tool" onClick={clear}>Clear</button>
        <button type="button" className="whiteboard-tool whiteboard-close" onClick={onClose}>Close</button>
      </div>
      <canvas ref={canvasRef} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} className="whiteboard-canvas"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} />
    </div>
  </div>;
}
