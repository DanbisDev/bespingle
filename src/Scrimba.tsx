import { useEffect, useRef, useState } from 'react';
import type { ScrimbaState, Send } from './protocol';
import rules from '../server/scrimba.json';

const markLabels = { correct: 'correct position', present: 'wrong position', absent: 'not in solution' };
const emojiNames = ['Apple', 'Lemon', 'Grapes', 'Cherries', 'Kiwi', 'Blossom', 'Sunflower', 'Clover', 'Fire', 'Star', 'Rainbow', 'Gem'];

export function Scrimba({ game, selfId, send, close, error }: {
  game?: ScrimbaState; selfId: string; send: Send; close: () => void; error: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [viewId, setViewId] = useState(selfId);
  const me = game?.players.find((player) => player.id === selfId);
  const viewed = game?.players.find((player) => player.id === viewId) ?? me;
  const ownBoard = viewed?.id === selfId;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);

  const add = (emoji: string) => setDraft((current) => current.length < rules.slots && !current.includes(emoji) && keyboardMarks.get(emoji) !== 'absent' ? [...current, emoji] : current);
  const erase = () => setDraft((current) => current.slice(0, -1));
  const submit = () => {
    if (!game || !me || me.done || draft.length !== rules.slots || draft.some((emoji) => keyboardMarks.get(emoji) === 'absent')) return;
    send({ type: 'scrimba-guess', id: game.id, turn: me.guesses.length, emojis: draft });
    setDraft([]);
  };
  const keyboardMarks = new Map<string, string>();
  const rank: Record<string, number> = { absent: 1, present: 2, correct: 3 };
  for (const guess of me?.guesses ?? []) guess.emojis?.forEach((emoji, i) => {
    const mark = guess.marks[i];
    if ((rank[mark] ?? 0) > (rank[keyboardMarks.get(emoji) ?? ''] ?? 0)) keyboardMarks.set(emoji, mark);
  });

  return <dialog ref={dialog} className="dialog scrimba-dialog" aria-label="Scrimba" onCancel={(event) => { event.preventDefault(); close(); }} onKeyDown={(event) => {
    if (!ownBoard || me?.done) return;
    if (event.key === 'Backspace') { event.preventDefault(); erase(); }
    if (event.key === 'Enter' && event.target === dialog.current) { event.preventDefault(); submit(); }
  }}>
    <div className="scrimba-heading"><div><span className="scrimba-eyebrow">A LITTLE EMOJI MYSTERY</span><h2>Scrimba <span aria-hidden="true">🌈</span></h2></div><button type="button" className="secondary-button" onClick={close} aria-label="Close Scrimba">Close</button></div>
    <p className="dialog-description">Find the {rules.slots}-emoji sequence in {rules.attempts} guesses. Everyone gets the same puzzle. Each emoji appears only once.</p>
    <p className="scrimba-legend"><span>🟩 Right spot</span><span>🟨 Wrong spot</span><span>⬛ Not in puzzle</span></p>
    {!game || !me ? <p role="status">{error || 'Joining Scrimba…'}</p> : <>
      <nav className="scrimba-players" aria-label="Scrimba players">{game.players.map((player) => <button type="button" key={player.id} aria-pressed={viewed?.id === player.id} onClick={() => setViewId(player.id)}>{player.id === selfId ? 'Your board' : player.name}<small>{player.won ? 'Solved' : player.done ? 'Finished' : `${player.guesses.length}/${rules.attempts}`}</small></button>)}</nav>
      <p className="scrimba-view-note">{ownBoard ? 'Your guesses are your own. Take your time.' : me.done ? `${viewed?.name}’s board` : `${viewed?.name}’s emojis stay hidden until you finish.`}</p>
      <div className="scrimba-board" aria-label={ownBoard ? 'Your Scrimba board' : `${viewed?.name}’s Scrimba board`}>
        {Array.from({ length: rules.attempts }, (_, row) => {
          const guess = viewed?.guesses[row];
          const active = ownBoard && !me.done && row === me.guesses.length;
          return <div className="scrimba-row" role="group" aria-label={`Guess ${row + 1}`} key={row}>
            {Array.from({ length: rules.slots }, (_, col) => {
              const emoji = guess?.emojis?.[col] ?? (active ? draft[col] : undefined);
              const mark = guess?.marks[col];
              return <span className={`scrimba-cell ${mark ?? ''} ${emoji ? 'filled' : ''}`} key={col} aria-label={`Position ${col + 1}: ${emoji ?? (mark ? 'hidden emoji' : 'empty')}${mark ? `, ${markLabels[mark]}` : ''}`}><span className="scrimba-symbol">{emoji ?? (mark ? '?' : '')}</span></span>;
            })}
          </div>;
        })}
      </div>
      <div role="status" className="scrimba-result">{me.done && <><strong>{me.won ? 'You solved it! 🎉' : 'That’s six. Another mystery awaits.'}</strong><p>Solution: {game.solution?.join(' ')}</p></>}{!ownBoard && viewed?.done && <p>{viewed.won ? 'Solved' : 'Finished'} in {viewed.guesses.length} guesses</p>}</div>
      {ownBoard && !me.done && <div className="scrimba-controls">
        <div className="scrimba-keyboard" aria-label="Emoji keyboard">{rules.emojis.map((emoji, i) => <button type="button" key={emoji} className={keyboardMarks.get(emoji) ?? ''} disabled={draft.length === rules.slots || draft.includes(emoji) || keyboardMarks.get(emoji) === 'absent'} aria-label={`Add ${emojiNames[i]}${keyboardMarks.has(emoji) ? `, ${markLabels[keyboardMarks.get(emoji) as keyof typeof markLabels]}` : ''}`} onClick={() => add(emoji)}><span className="scrimba-symbol" aria-hidden="true">{emoji}</span></button>)}</div>
        <div className="scrimba-actions"><button type="button" className="secondary-button" disabled={!draft.length} onClick={erase}>⌫ Delete</button><button type="button" className="primary-button" disabled={draft.length !== rules.slots || draft.some((emoji) => keyboardMarks.get(emoji) === 'absent')} onClick={submit}>Guess</button></div>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </>}
    <p className="scrimba-footnote">Live game · Expires after 2 hours · Progress clears when you leave the office. Reopen from the chat invitation.</p>
  </dialog>;
}
