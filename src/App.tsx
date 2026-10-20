import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { GameCanvas } from './GameCanvas';
import { AVATARS, world } from './world';
import type { Player } from './world';
import { drawAvatar } from './art';
import { useGame } from './useGame';
import { usePeerMedia } from './usePeerMedia';
import type { RemoteMedia } from './usePeerMedia';

type IconName = 'mic' | 'camera' | 'expand' | 'close' | 'arrow' | 'people' | 'exit' | 'check';
function Icon({ name, off = false }: { name: IconName; off?: boolean }) {
  const paths: Record<IconName, ReactNode> = {
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></>,
    camera: <><rect x="3" y="6" width="12" height="12" rx="3" /><path d="m15 10 6-4v12l-6-4" /></>,
    expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5" /></>,
    exit: <><path d="M10 4H4v16h6m4-13 5 5-5 5m-6-5h11" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}{off && <path d="m3 3 18 18" strokeWidth="2" />}</svg>;
}

function Avatar({ avatar, size = 48 }: { avatar: number; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    drawAvatar(ctx, 48, 84, avatar, 'down', false, 0, 1);
  }, [avatar]);
  return <canvas ref={ref} width="96" height="96" style={{ width: size, height: size }} className="avatar-art" aria-hidden="true" />;
}

function Dialog({ children, title, description, className = '' }: { children: ReactNode; title: string; description?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>('input,button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, []);
  return <div className="dialog-backdrop"><div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`dialog ${className}`}>
    <h2>{title}</h2>{description && <p className="dialog-description">{description}</p>}{children}
  </div></div>;
}

function VideoTile({ player, stream, local, media }: { player: Player; stream: MediaStream | null; local: boolean; media?: RemoteMedia }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playBlocked, setPlayBlocked] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.srcObject = stream;
    if (stream) void element.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(true));
    return () => { element.srcObject = null; };
  }, [stream]);
  const connectionLabel = local ? 'You' : media?.status === 'connected' ? '' : media?.status === 'failed' ? 'Cannot connect directly' : media?.status === 'disconnected' ? 'Disconnected' : 'Connecting…';
  return <div className={`video-tile ${player.camera && stream ? 'has-video' : ''}`} data-testid={`video-${local ? 'self' : 'peer'}`}>
    <div className="video-avatar"><Avatar avatar={player.avatar} size={64} /></div>
    <video ref={video} autoPlay playsInline muted={local} aria-label={`${player.name}${local ? ' (you)' : ''} video`} />
    <div className="video-caption"><span>{player.name}{local && <small> (you)</small>}</span><Icon name="mic" off={!player.mic} /></div>
    {connectionLabel && !local && <span className="connection-label">{connectionLabel}</span>}
    {playBlocked && !local && <button className="play-audio" onClick={(event) => { event.stopPropagation(); void video.current?.play().then(() => setPlayBlocked(false)).catch(() => {}); }}>Play audio</button>}
  </div>;
}

export default function App() {
  const game = useGame();
  const self = game.players.find((player) => player.id === game.selfId);
  const carpet = world.carpets.find((item) => item.id === self?.carpetId);
  const media = usePeerMedia(self, game.players, game.send, game.signalHandler);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(0);
  const [editingProfile, setEditingProfile] = useState(false);
  const [promptCarpet, setPromptCarpet] = useState('');
  const [expanded, setExpanded] = useState(false);
  const previousCarpet = useRef('');
  const connected = game.status === 'connected';
  const members = self?.carpetId ? game.players.filter((player) => player.carpetId === self.carpetId).sort((a, b) => a.id === self.id ? -1 : b.id === self.id ? 1 : a.name.localeCompare(b.name)) : [];

  useEffect(() => {
    const id = self?.carpetId ?? '';
    if (previousCarpet.current !== id) {
      previousCarpet.current = id;
      setExpanded(false);
    }
    setPromptCarpet(id && !media.hasChosenDevices ? id : '');
  }, [self?.carpetId, media.hasChosenDevices]);

  const join = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) game.join(name.trim(), avatar);
  };

  async function chooseDevices(mic: boolean, camera: boolean) {
    const id = promptCarpet;
    if (await media.chooseMedia(mic, camera)) setPromptCarpet((current) => current === id ? '' : current);
  }

  const isMediaPrompt = !!promptCarpet && promptCarpet === self?.carpetId;
  const modalOpen = !connected || editingProfile || isMediaPrompt;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><h1>Bespingle</h1></div>
      <div className="topbar-right"><span className="online-count"><i className={connected ? 'online-dot' : 'offline-dot'} />{game.players.length} online</span>
        {self && <button className="profile-button" onClick={() => { setName(self.name); setEditingProfile(true); }} aria-label="Edit profile"><Avatar avatar={self.avatar} size={35} /><span>{self.name}</span><span className="profile-chevron">⌄</span></button>}
      </div>
    </header>

    <main className="game-area" data-testid="game-area" aria-label="Game area">
      <div className="game-stage">
        <section className={`call-strip ${carpet ? 'has-conversation' : 'is-quiet'} ${expanded ? 'expanded' : ''}`} aria-label="Conversation videos">
          <div className="conversation">
            {carpet ? <>
              <div className="conversation-heading"><span className="room-dot" style={{ background: carpet.color }} /><strong>{carpet.name}</strong><span className="conversation-count">{members.length} here</span>
                <button className="expand-button" aria-label={expanded ? 'Return to game' : 'Enlarge conversation videos'} onClick={() => setExpanded((current) => !current)}><Icon name={expanded ? 'close' : 'expand'} /><span>{expanded ? 'Back to game' : 'Expand'}</span></button>
              </div>
              <div className="video-grid" role="button" tabIndex={0} aria-label={expanded ? 'Shrink conversation videos' : 'Enlarge conversation videos'} onClick={() => setExpanded((current) => !current)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setExpanded((current) => !current); } }}>
                {members.map((player) => <VideoTile key={player.id} player={player} local={player.id === self?.id} stream={player.id === self?.id ? media.localStream : media.remoteMedia[player.id]?.stream ?? null} media={media.remoteMedia[player.id]} />)}
              </div>
              {expanded && <p className="expanded-hint">You’re still in {carpet.name}. Return to the game to move.</p>}
            </> : <div className="quiet-floor"><Icon name="people" /><span>Walk onto a carpet to start a conversation.</span><span className={`quiet-status ${self?.mic || self?.camera ? 'is-enabled' : ''}`}><i />{self?.mic && self?.camera ? 'Mic & camera on' : self?.mic ? 'Microphone on' : self?.camera ? 'Camera on' : 'Devices off'}</span></div>}
          </div>
        </section>
        <div className="game-viewport"><GameCanvas players={game.players} selfId={game.selfId} onMove={game.move} serverNow={game.serverNow} disabled={modalOpen || expanded} /></div>
      </div>
      <footer className="game-hud">
        <div className="location-info"><span className="location-dot" style={{ background: carpet?.color ?? '#a0aa9d' }} /><div><strong>{carpet?.name ?? 'Open floor'}</strong><span>{carpet ? `${members.length} in conversation` : 'No active conversation'}</span></div></div>
        <div className="media-controls"><button className={self?.mic ? 'device-button enabled' : 'device-button'} disabled={!connected || media.busy || isMediaPrompt} aria-label={self?.mic ? 'Turn microphone off' : 'Turn microphone on'} aria-pressed={self?.mic ?? false} onClick={() => { void media.chooseMedia(!self?.mic, self?.camera ?? false); }}><Icon name="mic" off={!self?.mic} /><span>{self?.mic ? 'Mic on' : 'Mic off'}</span></button>
          <button className={self?.camera ? 'device-button enabled' : 'device-button'} disabled={!connected || media.busy || isMediaPrompt} aria-label={self?.camera ? 'Turn camera off' : 'Turn camera on'} aria-pressed={self?.camera ?? false} onClick={() => { void media.chooseMedia(self?.mic ?? false, !self?.camera); }}><Icon name="camera" off={!self?.camera} /><span>{self?.camera ? 'Camera on' : 'Camera off'}</span></button>
          <span className="hud-divider" /><button className="leave-button" disabled={!connected} onClick={game.leave} aria-label="Leave office"><Icon name="exit" /></button>
        </div>
        <div className="movement-hint"><span><kbd>W</kbd><span><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span></span><span>WASD or arrow keys to walk<small>Scroll to zoom</small></span></div>
      </footer>
      {(game.error || (media.error && !isMediaPrompt)) && connected && <p className="inline-error" role="alert">{game.error || media.error}</p>}
    </main>

    {!connected && <Dialog title="Make yourself at home." description="Pick a familiar face, add your name, and step into the office." className="join-dialog">
      <span className="welcome-pixel" aria-hidden="true"><Avatar avatar={avatar} size={88} /></span>
      <form onSubmit={join}><label className="field-label" htmlFor="display-name">Your display name</label><input id="display-name" maxLength={32} required autoComplete="off" placeholder="What should we call you?" value={name} onChange={(event) => setName(event.target.value)} disabled={game.status === 'connecting'} />
        <span className="field-label avatar-label">Choose your avatar</span><div className="avatar-picker" role="group" aria-label="Choose your avatar">{AVATARS.map((item, index) => <button type="button" key={item.name} title={item.name} aria-label={`${item.name} avatar`} aria-pressed={avatar === index} className={`avatar-option ${avatar === index ? 'selected' : ''}`} onClick={() => setAvatar(index)}><Avatar avatar={index} size={64} />{avatar === index && <span className="avatar-check"><Icon name="check" /></span>}</button>)}</div>
        {game.error && <p className="form-error" role="alert">{game.error}</p>}
        <button className="primary-button" disabled={!name.trim() || game.status === 'connecting'}>{game.status === 'connecting' ? 'Opening the door…' : 'Enter the office'}<Icon name="arrow" /></button>
      </form><p className="join-note"><Icon name="mic" off /><Icon name="camera" off />Your microphone and camera start off.</p>
    </Dialog>}

    {editingProfile && self && <Dialog title="Your profile" description="This is how your name appears around the office."><form onSubmit={(event) => { event.preventDefault(); if (name.trim()) { game.send({ type: 'profile', name: name.trim(), avatar: self.avatar }); setEditingProfile(false); } }}><div className="profile-preview"><Avatar avatar={self.avatar} size={70} /></div><label className="field-label" htmlFor="profile-name">Display name</label><input id="profile-name" maxLength={32} value={name} onChange={(event) => setName(event.target.value)} required /><div className="form-actions"><button type="button" className="secondary-button" onClick={() => setEditingProfile(false)}>Cancel</button><button className="primary-button" disabled={!name.trim()}>Save name<Icon name="check" /></button></div></form></Dialog>}

    {isMediaPrompt && <Dialog title={`You’re in ${carpet?.name ?? 'a conversation'}.`} description="What would you like to enable? You can hear and see others with your own devices off." className="media-dialog">
      <div className="device-choices">
        <button disabled={media.busy} onClick={() => { void chooseDevices(true, true); }}><span className="choice-icons"><Icon name="mic" /><Icon name="camera" /></span><strong>Both</strong><span>Microphone & camera</span></button>
        <button disabled={media.busy} onClick={() => { void chooseDevices(true, false); }}><span className="choice-icons"><Icon name="mic" /></span><strong>Microphone only</strong><span>Join with your voice</span></button>
        <button disabled={media.busy} onClick={() => { void chooseDevices(false, true); }}><span className="choice-icons"><Icon name="camera" /></span><strong>Video only</strong><span>Keep your microphone off</span></button>
        <button disabled={media.busy} onClick={() => { void chooseDevices(false, false); }}><span className="choice-icons"><Icon name="people" /></span><strong>Neither</strong><span>Just listen and watch</span></button>
      </div>{media.busy && <p className="permission-hint" role="status">Check your browser’s device permission request…</p>}{media.error && <p className="form-error" role="alert">{media.error}</p>}<p className="media-note">Device settings stay the same until you change them or leave the game.</p>
    </Dialog>}
  </div>;
}
