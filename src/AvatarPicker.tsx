import { useEffect, useState } from 'react';
import { Avatar } from './Avatar';
import { AVATARS } from './world';
import { validAvatarID } from './profile';

const selectedCheck = <span className="avatar-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></span>;

export function AvatarPicker({ avatar, customAvatar, customOption, onChange, onUpload }: {
  avatar: number; customAvatar: string; customOption: string;
  onChange: (avatar: number, customAvatar: string) => void; onUpload: (id: string) => void;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const endpoint = `${location.origin}/mcp`;
  const prompt = `Connect to the Bespingle MCP server at ${endpoint}. Call avatar_spec, design my custom avatar using its sprite-sheet format, then call upload_avatar with uploadCode "${token}" and the PNG file encoded as standard base64. Ask me what character I want before designing it.`;
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch('/api/avatar-session', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        if (stopped) return;
        if (validAvatarID(data.avatarId)) {
          onUpload(data.avatarId); setToken(''); setMessage('Your custom avatar is selected. Save your profile or enter the office to use it.'); return;
        }
      } catch (reason) {
        if (stopped) return;
        setError(reason instanceof Error ? reason.message : 'Could not check upload.'); setToken(''); return;
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [token, onUpload]);
  async function startUpload() {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/avatar-session', { method: 'POST' });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json(); setToken(data.token);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not start upload.'); }
    finally { setBusy(false); }
  }
  return <>
    <span className="field-label avatar-label">Choose your avatar</span>
    <div className="avatar-picker" role="group" aria-label="Choose your avatar">
      {AVATARS.map((item, index) => <button type="button" key={item.name} title={item.name} aria-label={`${item.name} avatar`} aria-pressed={!customAvatar && avatar === index} className={`avatar-option ${!customAvatar && avatar === index ? 'selected' : ''}`} onClick={() => onChange(index, '')}><Avatar avatar={index} size={64} />{!customAvatar && avatar === index && selectedCheck}</button>)}
      {customOption && <button type="button" aria-label="Your custom avatar" aria-pressed={customAvatar === customOption} className={`avatar-option ${customAvatar === customOption ? 'selected' : ''}`} onClick={() => onChange(avatar, customOption)}><Avatar avatar={avatar} customAvatar={customOption} size={64} />{customAvatar === customOption && selectedCheck}</button>}
    </div>
    <details className="custom-avatar-help"><summary>Create your own with Claude or Codex</summary>
      <p>Add this remote MCP server to your agent: <code>{endpoint}</code> (Streamable HTTP). Then generate an upload code and give the agent the prompt below.</p>
      <p>Codex CLI: <code>codex mcp add bespingle --url {endpoint}</code></p>
      <p>Claude Code: <code>claude mcp add --transport http bespingle {endpoint}</code></p>
      <p>For a hosted agent, use your public HTTPS office address so it can reach the server.</p>
      <p>Ask for a character you like. The agent calls <code>avatar_spec</code> for the 24-pose PNG layout, then <code>upload_avatar</code>. Keep this selector open; your avatar appears here when the upload finishes.</p>
      <p>Your upload stays out of the shared selector. People in the office can see it while you wear it. Your name and selection are remembered in this browser for one year.</p>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { void startUpload(); }}>{busy ? 'Creating code…' : token ? 'Generate a new upload code' : 'Generate upload code'}</button>
      {token && <><label className="field-label" htmlFor="avatar-agent-prompt">Agent prompt · code expires in 30 minutes</label><textarea id="avatar-agent-prompt" rows={6} readOnly value={prompt} onFocus={(event) => event.target.select()} /><button type="button" className="secondary-button" onClick={() => { void navigator.clipboard.writeText(prompt).then(() => setMessage('Prompt copied.')).catch(() => setError('Select and copy the prompt above.')); }}>Copy agent prompt</button></>}
    </details>
    {message && <p className="media-note" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </>;
}
