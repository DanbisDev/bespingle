# Bespingle

A shared pixel office with a full-window, night-themed game area and direct
browser-to-browser audio and video. Walk onto a carpet to join a conversation;
walk off to leave it. Built with React, TypeScript, Go, and WebRTC.

Bespingle is an early proof of concept, published under the [MIT license](LICENSE).
The office is open to anyone with its link. There are no accounts, passwords,
attendance limits, or saved profiles. A server restart clears the office and
disconnects its participants.

## Run locally

Requires Node.js 22.12+ and Go 1.26+.

```sh
npm ci
npm run dev
```

Open [http://localhost:5555](http://localhost:5555) in two browser windows. Each
window joins as a separate person. The React development server runs on port
5555; Go runs on `127.0.0.1:6666`. Vite proxies `/ws` and `/api` so the browser
uses only port 5555. Ctrl+C stops both services.

To start them separately, run `npm run dev:backend` and
`npm run dev:frontend` in separate terminals.

## Explore the office

- Choose a display name and one of six pixel avatars. Click your profile to
  change your name later.
- Move with **WASD or the arrow keys**. Hold a key to keep walking; each 48-pixel tile takes 240 ms.
  Hold **Shift** while moving to sprint up to **3 tiles per tick** (240 ms),
  stopping before walls or occupied tiles. Releasing Shift returns to walking.
  The hidden grid reserves both the source and destination during a step, so
  players cannot share tiles or swap through one another. A blocked move into
  another player makes the moving avatar bounce back. Walls block movement;
  furniture does not.
- Press **Z** to toggle dancing for everyone to see. Walking stops the dance.
- **Scroll over the game area** to zoom. The camera follows your avatar.
- Share a carpet to talk. The Nook, The Studio, and The Commons have 2, 4, and 8
  visual chairs, with no attendance caps. Walking onto a chair tile seats your
  avatar visually; the carpet determines conversation membership.
- On your first carpet entry, choose **both**, **microphone only**, **video only**,
  or **neither**. Neither still receives other participants' media.
- Enabled devices stay on across carpets and the open floor until you switch
  them off with the HUD controls or leave the game. The choice is remembered
  for that game session; entering another carpet does not prompt again.
- Click the video strip or **Expand** to cover the game area with videos.
  Movement pauses while videos are expanded.
- Each carpet has a temporary text chat. Messages go only to participants
  connected to that carpet when sent, including the sender. Later arrivals get
  no earlier messages. The server relays messages without saving or logging
  their content; each browser keeps at most 100 messages in memory, cleared
  when leaving the carpet, disconnecting, or reloading. Chat is not written to
  browser storage. Recipients can still copy messages they receive.
- Click **Share screen** on a carpet to choose a tab, window, or display. Everyone
  on that carpet can watch alongside your camera; use **Expand** for a larger view.
  Stop with **Stop sharing** or the browser’s sharing control. Leaving the carpet
  or office also stops sharing, including a pending screen selection. Multiple
  people can share at once. Screen sharing sends video only, without system audio.
- **Leave office** stops local devices. A new game starts with devices off.

## Direct audio and video

The Go server handles names, positions, carpet membership, device flags, temporary carpet chat, and
WebRTC connection setup over WebSocket. It does not receive or forward audio or
video. Browsers send media directly to other participants on the same carpet.
Leaving a carpet closes those peer connections. Local devices may remain on,
but no media is sent to other participants while you are on the open floor.

Connection discovery uses `stun:stun.cloudflare.com:3478`.
[Cloudflare documents its public STUN service as free and unlimited](https://developers.cloudflare.com/realtime/turn/faq/).
There is no TURN relay fallback, so calls may fail on networks that prevent a
direct WebRTC connection. Remote microphone and camera access requires HTTPS;
localhost is suitable for development.

Capture targets 1280×720 at 30 fps; actual quality depends on the device,
browser, and connection. Each browser sends one copy to every other participant
in its call. Eight people sharing a carpet create 28 peer connections, with up
to seven outgoing streams per person. Hosting avoids media relay bandwidth, but
participants still need enough upload capacity for those copies.

Microphone and camera controls work independently. Disabling one stops only
its own track. Leaving the game stops all capture, including late permission
results. Use headphones when testing multiple windows in the same physical room.

### Camera backgrounds

Use **Background** beside the camera control to choose **Blur**, **Sky**,
**Forest**, or a custom JPG, PNG, or WebP image (up to 10 MB). You can also choose
an effect in the device prompt before enabling your camera. **None** restores
the original camera feed. Your choice lasts for the current page session.

Effects use Google's open source [MediaPipe Image Segmenter](https://github.com/google-ai-edge/mediapipe)
(`@mediapipe/tasks-vision` 0.10.32) and the Selfie Segmenter landscape model
(float16, version 1), licensed under Apache 2.0. The runtime and model are served
with the application; camera frames and custom images stay on the device until
the processed video is sent directly to conversation peers. No inference service
or CDN is required. See [third-party notices](public/models/NOTICE.txt) and the
[bundled license](public/models/MEDIAPIPE-LICENSE.txt).

Segmentation and compositing run in a dedicated worker, capped at 960 pixels
wide and 20 fps, with one frame in flight. Slower devices may deliver fewer
frames. Effects require WebAssembly, OffscreenCanvas, and canvas capture;
unsupported browsers can continue using **None**. If an active effect fails,
the camera stops instead of publishing the original background. Model-loading
failures preserve the previous effect.

## Production container

The multi-stage Docker build compiles the frontend and Go server into one
container. Go serves the built app, `/api`, and `/ws` on the same port. There is
no Vite server in production.

```sh
docker build -t bespingle .
docker run --rm -p 8080:8080 -e ALLOWED_ORIGINS=http://localhost:8080 bespingle
```

Open [http://localhost:8080](http://localhost:8080). The container uses
`HOST=0.0.0.0`, `PORT=8080`, and `STATIC_DIR=/app/dist` by default. Go reads process
environment variables; it does not automatically load `.env` files. See
[.env.example](.env.example) for the available settings.

## Deploy on Railway

Connect a Railway service to [DanbisDev/bespingle](https://github.com/DanbisDev/bespingle)
and select **master** as its deployment branch. Keep the repository root as the
build directory and use its `Dockerfile`. Set the healthcheck path to
`/api/health` with a 120-second timeout, and run **one replica**. Generate a public
HTTPS domain for the service.

The server listens on Railway's injected `PORT`. It allows WebSocket connections
from the exact HTTPS origin derived from `RAILWAY_PUBLIC_DOMAIN`. For an
additional domain, set `ALLOWED_ORIGINS` to comma-separated full origins such as
`https://office.example.com`; include every origin you intend to allow.

Pushes to the connected **master** branch trigger native GitHub autodeploys.
Railway provides the public HTTPS domain. See the official
[GitHub autodeploy documentation](https://docs.railway.com/deployments/github-autodeploys)
and [healthcheck documentation](https://docs.railway.com/deployments/healthchecks).

All participants and movement reservations live in the Go process. Deployments
restart that process and disconnect existing sessions. Multiple replicas would
create separate offices because state is not shared. This version needs no
database or persistent volume.

## Checks

```sh
npm run build
npm run test:backend
```

With the local development stack running in another terminal:

```sh
npx playwright install chromium
npm run test:grid
npm run test:browser
npm run test:chat
npm run test:backgrounds
```

Alternatively, use an existing Chrome installation:

```sh
CHROME_PATH=/absolute/path/to/google-chrome npm run test:grid
CHROME_PATH=/absolute/path/to/google-chrome npm run test:browser
CHROME_PATH=/absolute/path/to/google-chrome npm run test:chat
CHROME_PATH=/absolute/path/to/google-chrome npm run test:backgrounds
```

The browser checks use synthetic microphones and cameras. They cover grid
movement and collisions, carpet membership, game-area sizing, zoom, media
connections, device reuse, device shutdown, and temporary carpet chat delivery
and clearing. The backgrounds check runs real segmentation, tests custom image
compositing and live effect switching, and checks failure handling and capture
cleanup. Screenshots go to the ignored
`test-results/browser/` directory. Backend checks include race detection,
movement reservations, signaling isolation, and invalid messages and origins.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/App.tsx` | Join/profile UI, media prompt, video strip, and HUD |
| `src/GameCanvas.tsx` | Game rendering, follow camera, zoom, and tile movement |
| `src/art.ts`, `src/avatarArt.ts` | Code-drawn pixel office and avatars |
| `src/useGame.ts` | WebSocket state and signaling delivery |
| `src/usePeerMedia.ts` | Peer connections and device lifecycle |
| `src/cameraBackground.ts`, `src/cameraBackground.worker.ts` | Local camera segmentation and background compositing |
| `src/world.ts` | Shared map types, tile helpers, and wall collision |
| `server/world.json` | Map geometry, carpets, chairs, and furniture |
| `server/` | In-memory office, authoritative movement, signaling, and HTTP serving |

The Go binary embeds the map at build time. Restart Go after editing
`server/world.json`; Vite reloads the frontend automatically.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Bespingle's source and code-drawn artwork are MIT licensed. Dependencies retain
their respective licenses.
