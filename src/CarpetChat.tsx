import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, Send } from './protocol';
import type { Carpet } from './world';

export function CarpetChat({ carpet, messages, selfId, send, openScrimba }: {
  carpet: Carpet; messages: ChatMessage[]; selfId: string; send: Send; openScrimba: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [messages, open]);

  return <aside className={`carpet-chat ${open ? '' : 'collapsed'}`} aria-label={`${carpet.name} chat`}>
    <div className="chat-heading"><strong>{carpet.name} chat</strong><button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Hide carpet chat' : 'Show carpet chat'}>{open ? 'Hide' : 'Show'}</button></div>
    {open && <>
      <p className="chat-note">Live messages for people on this carpet. Cleared when you leave. No saved history.</p>
      <div className="chat-messages" role="log" aria-label="Carpet messages" aria-live="polite" aria-relevant="additions" tabIndex={0}>
        {!messages.length && <p className="chat-empty">Say hello to the people here.</p>}
        {messages.map((message, index) => <div className="chat-message" key={index}><strong>{message.name}{message.from === selfId ? ' (you)' : ''}</strong><p>{message.text}</p>{message.scrimbaId && <button type="button" className="scrimba-join" onClick={() => openScrimba(message.scrimbaId!)}>Launch Scrimba</button>}</div>)}
        <div ref={end} />
      </div>
      <form className="chat-compose" onSubmit={(event) => {
        event.preventDefault();
        if (!draft.trim()) return;
        send({ type: 'chat', carpetId: carpet.id, text: draft.trim() });
        setDraft('');
      }}>
        <label className="sr-only" htmlFor="chat-message">Message this carpet</label>
        <input id="chat-message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={1000} autoComplete="off" placeholder="Message or /scrimba…" />
        <button type="submit" disabled={!draft.trim()}>Send</button>
      </form>
    </>}
  </aside>;
}
