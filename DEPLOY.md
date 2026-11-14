# Monkey Bomb: deploying version 0

All commands are for the OWNER. Nothing here has been run by the implementer. No secret value belongs in the repo.

Layout: the game (static site, `dist/`) goes on Cloudflare Pages. The signaling Worker (`worker/`) goes on workers.dev. They are different origins, so the Worker only answers browsers whose origin is in `ALLOWED_ORIGINS`.

## a) One time

1. Create a Cloudflare account (free plan is enough to start).
2. Log in from the CLI:

```
cd worker
npx wrangler login
```

## b) TURN secrets

In the Cloudflare dashboard, open Realtime, TURN, and create a TURN key. It gives a key id and an API token.

```
cd worker
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
```

Paste each value at the prompt. Without them `/turn` still works but serves STUN only (some mobile networks will then fail to connect).

The provider response shape is ASSUMED in `worker/src/turn.ts` (`{ iceServers: { urls, username, credential } }`) and has never been checked against the live API. After the Worker is deployed, check it once:

```
curl https://<worker-url>/turn
```

The answer must contain an entry whose `urls` start with `turn:` or `turns:`. If it only shows `stun:`, the shape or the secrets are wrong: fix `fetchTurnServer` in `turn.ts`.

## c) Allowed origins and compatibility date

`worker/wrangler.toml` ships with local-development origins only. For production set the real list: the Pages origin(s), plus `capacitor://localhost` and `https://localhost` when the store apps exist. Either edit `ALLOWED_ORIGINS` under `[vars]` or pass it on deploy:

```
npx wrangler deploy --var ALLOWED_ORIGINS:https://<pages-domain>
```

Exact origins only (scheme, host, port; no path, no trailing slash, no `*`). Empty or missing means no browser is allowed.

`compatibility_date` in `wrangler.toml` is pinned on purpose. Bump it deliberately, run `npm test` in `worker/`, then deploy.

## d) Deploy the Worker

```
cd worker
npx wrangler deploy
```

Note the printed URL (`https://monkey-bomb-signal.<account>.workers.dev`).

## e) Build and deploy the site

From `game-lab/monkey-bomb`:

```
VITE_WORKER_URL=https://<worker-url> VITE_APP_VERSION=v0 npm run build
npx wrangler pages deploy dist --project-name <name>
```

(Windows PowerShell: set `$env:VITE_WORKER_URL = "https://<worker-url>"` first. You can also put the values in `.env.local`, which is git-ignored; see `.env.example`. Or upload `dist/` in the Pages dashboard.)

Then add the Pages origin (`https://<name>.pages.dev` or your custom domain) to `ALLOWED_ORIGINS` and redeploy the Worker (step c, d). Until then the browser gets 403 `origin-not-allowed`.

## f) Privacy page

Replace the two `OWNER_EMAIL` placeholders in `public/privacy.html` with a real contact address, then rebuild and redeploy the site (step e). Do not publish with the placeholder.

## g) Live smoke test

Three devices: one desktop, two phones, at least one phone on mobile data (this exercises TURN).

1. Device 1 opens the site, taps Create, allows the microphone, reads out the 4-letter code.
2. Devices 2 and 3 open the site, tap Join, enter the code, allow the microphone.
3. Device 1 starts level 1 and the three players clear it using voice.

Expected:
- All three connect; the lobby shows 3 of 3 players.
- The three roles are distinct (blind, deaf, mute).
- The microphone prompt appears on each device (and the page still works if it is refused).
- The mute player is silent; the deaf player hears nothing from the others.
- The footer shows `v0` and a working Privacy link.

Report failures with the version label and the room code.

## h) Known limits

- Worker tests (`worker/`, `npx vitest run`) need the VC++ runtime for workerd on Windows; without it they crash with access violation 0xc0000005.
- Do not run `npm install` in `worker/` on the dev machine that holds the copied DLLs: it removes them.
- Safari/iOS audio autoplay behaviour is unverified; the smoke test should include an iPhone if possible.
- The TURN provider response shape is unverified (step b).
- The origin check protects users' browsers. A request with no `Origin` header (curl, scripts) is accepted by design; abuse of `/turn` is bounded by the per-IP limit (20 per minute).
- The store apps (Capacitor) come later; their origins must then be added to `ALLOWED_ORIGINS`.
