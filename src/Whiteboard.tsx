import { useEffect, useRef, useState } from 'react';
import type { DrawMessage, DrawSegment, Send } from './protocol';

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const BACKGROUND = '#1a2233';
const COLORS = ['#ffffff', '#ff4444', '#44aaff', '#44dd66', '#ffcc00', '#ff88ff'];

type WhiteboardProps = {
  mode: 'host' | 'collaborator';
  onStream?: (stream: MediaStream) => void;
  onClose: () => void;
  send: Send;
  carpetId: string;
  selfId: string;
  onRegisterDrawHandler: (handler: (msg: DrawMessage) => void) => void;
};

export function Whiteboard({ mode, onStream, onClose, send, carpetId, selfId, onRegisterDrawHandler }: WhiteboardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawing = useRef(false);
  const [color, setColor] = useState(COLORS[0]);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const pending = useRef<DrawSegment[]>([]);
  const remoteBuffer = useRef<DrawMessage[]>([]);
  const snapshotReceived = useRef(false);

  // Initialize canvas and (host only) capture stream.
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

    if (mode === 'host' && onStream) {
      const stream = canvas.captureStream(20);
      const track = stream.getVideoTracks()[0];
      if (track) track.contentHint = 'detail';
      onStream(stream);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush pending draw segments every 50ms.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!pending.current.length) return;
      const batch = pending.current.splice(0);
      send({ type: 'draw', carpetId, segments: batch });
    }, 50);
    return () => clearInterval(timer);
  }, [send, carpetId]);

  // Request a snapshot of the current canvas from any active participant on mount.
  // This lets both collaborators (joining an existing board) and returning hosts
  // (who lost their canvas) receive existing drawing state.
  useEffect(() => {
    snapshotReceived.current = false;
    send({ type: 'draw', carpetId, segments: [{ op: 'snapshot-request' }] });
  }, [send, carpetId]);

  // Register as the draw event receiver.
  useEffect(() => {
    onRegisterDrawHandler((msg) => {
      // Any participant responds to snapshot requests from peers.
      const hasRequest = msg.segments.some((s) => s.op === 'snapshot-request');
      if (hasRequest && canvasRef.current) {
        const data = canvasRef.current.toDataURL('image/jpeg', 0.6);
        send({ type: 'draw', carpetId, segments: [{ op: 'snapshot', data }] });
        return;
      }

      // Apply incoming snapshot (first one wins).
      if (!snapshotReceived.current) {
        const snap = msg.segments.find((s) => s.op === 'snapshot');
        if (snap && snap.op === 'snapshot') {
          snapshotReceived.current = true;
          const img = new Image();
          img.onload = () => {
            const ctx = ctxRef.current;
            if (ctx) ctx.drawImage(img, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          };
          img.src = snap.data;
          return;
        }
      }

      if (msg.from === selfId) return;
      if (drawing.current) {
        remoteBuffer.current.push(msg);
      } else {
        applyRemote(msg);
      }
    });
    return () => onRegisterDrawHandler(() => {});
  }, [onRegisterDrawHandler, selfId, mode, send, carpetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyRemote = (msg: DrawMessage) => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    for (const seg of msg.segments) {
      if (seg.op === 'begin') {
        ctx.beginPath();
        ctx.strokeStyle = seg.color;
        ctx.lineWidth = seg.width;
        ctx.moveTo(seg.x, seg.y);
        ctx.lineTo(seg.x + 0.1, seg.y);
        ctx.stroke();
      } else if (seg.op === 'move') {
        ctx.lineTo(seg.x, seg.y);
        ctx.stroke();
      } else if (seg.op === 'clear') {
        ctx.fillStyle = BACKGROUND;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      }
    }
  };

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
    const strokeColor = tool === 'eraser' ? BACKGROUND : color;
    const lineWidth = tool === 'eraser' ? 24 : 3;
    ctx.beginPath();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    const { x, y } = toCanvas(event);
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y);
    ctx.stroke();
    pending.current.push({ op: 'begin', x, y, color: strokeColor, width: lineWidth });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = ctxRef.current!;
    const { x, y } = toCanvas(event);
    ctx.lineTo(x, y);
    ctx.stroke();
    pending.current.push({ op: 'move', x, y });
  };

  const onPointerUp = () => {
    drawing.current = false;
    for (const buffered of remoteBuffer.current.splice(0)) applyRemote(buffered);
  };

  const clear = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    pending.current.push({ op: 'clear' });
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
