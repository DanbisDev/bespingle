# Contributing to Bespingle

Clone the repository, install Node.js 22.12+ and Go 1.26+, then run:

```sh
npm ci
npm run dev
```

The frontend is at `http://localhost:5555`; Go listens on `127.0.0.1:6666`.

Keep changes focused and describe the resulting behavior in your pull request.
Include a screenshot for visible artwork or UI changes. Target the `master`
branch. Never commit credentials, `.env` files, local recordings, or generated
test output.

Before submitting, run the checks relevant to your change:

```sh
npm run build
npm run test:backend
```

For movement, game-area, or media changes, keep the development stack running
and run the browser checks as well:

```sh
npx playwright install chromium
npm run test:grid
npm run test:browser
```

Set `CHROME_PATH` to an existing Chrome executable if you prefer. Browser tests
use synthetic devices. Test media with two windows, and verify that leaving a
carpet disconnects the call while leaving the game stops local devices.

The map in `server/world.json` is shared with TypeScript and embedded in Go.
Restart Go after editing it. Keep collision, seating, and carpet membership
consistent between clients and the authoritative server.

The deployed app uses one Go process with in-memory state. Preserve direct
browser-to-browser media: no media relay is part of this proof of concept.
Contributions are distributed under the repository's [MIT license](LICENSE).
