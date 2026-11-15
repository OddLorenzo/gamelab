# Monkey Bomb: deploying version 0

All commands are for the OWNER. Nothing here has been run by the implementer. No secret value belongs in the repo.

Layout: the game (static site, `dist/`) goes on Cloudflare Pages. The signaling Worker (`worker/`) goes on workers.dev. They are different origins, so the Worker only answers browsers whose origin is in `ALLOWED_ORIGINS`.

Order of the steps matters: a) account, b) TURN secrets, c) privacy page, d) Worker, e) site, f) smoke test. The privacy page comes BEFORE the build because the build copies it.

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

Paste each value at the prompt. Without them `/turn` still works but serves STUN only (some mobile networks will then fail to connect, and the lobby shows "could not be established" after about 20 seconds).

The provider response shape is ASSUMED in `worker/src/turn.ts` (`{ iceServers: { urls, username, credential } }`) and has never been checked against the live API. After the Worker is deployed (step d), check it once:

```
curl https://<worker-url>/turn
```

The answer must contain an entry whose `urls` start with `turn:` or `turns:`. If it only shows `stun:`, the shape or the secrets are wrong: fix `fetchTurnServer` in `turn.ts`.

## c) Privacy page (before any build)

Open `public/privacy.html` and replace EVERY placeholder, in both the English and the French section:

- `OWNER_EMAIL`: a real contact address (an `href` and a visible text in each language: four occurrences).
- `OWNER_NAME`: the name of the person responsible for the game (one in each language: two occurrences).

`npm run check:release` (step e) fails while any placeholder is left. The page makes no legal claim: read it once and check it says what is true for your deployment (what Cloudflare logs for your account, your contact).

## d) Allowed origins and deploy the Worker

`worker/wrangler.toml` ships with local-development origins only. For production the real list is: the Pages origin(s), plus `capacitor://localhost` and `https://localhost` when the store apps exist. The Pages origin is `https://<name>.pages.dev` for the project name you will give in step e (or your custom domain): pick the name now so the list is complete on the first deploy.

There is ONE command to deploy the Worker, and it always carries `--var`:

```
cd worker
npx wrangler deploy --var ALLOWED_ORIGINS:https://<pages-domain>
```

In PowerShell a list with commas must be quoted, or PowerShell splits it into an array:

```
cd worker
npx wrangler deploy --var "ALLOWED_ORIGINS:https://<pages-domain>,capacitor://localhost,https://localhost"
```

WARNING: a plain `npx wrangler deploy` WITHOUT `--var ALLOWED_ORIGINS:...` resets the value to the localhost-only list in `wrangler.toml`, and production then fails closed (403 `origin-not-allowed` for every browser). Rule: EVERY production deploy of the Worker passes `--var`, including a redeploy after a code change (the repo keeps no real domain). If you prefer a plain `wrangler deploy`, put the production list in the `ALLOWED_ORIGINS` line under `[vars]` in your local copy instead and do not commit it.

Exact origins only (scheme, host, port; no path, no trailing slash, no `*`). Empty or missing means no browser is allowed.

Note the printed URL (`https://monkey-bomb-signal.<account>.workers.dev`): it is the `VITE_WORKER_URL` of step e.

`compatibility_date` in `wrangler.toml` is pinned on purpose. Bump it deliberately (never as a side effect of another change), run `npm test` in `worker/`, then deploy.

Updating a Worker that is already deployed: no new migration is needed for the current code (no new Durable Object class). The rate limiter changed shape; its old counters (named by bare IP) simply expire by their own alarm.

## e) Build and deploy the site

`VITE_WORKER_URL` is REQUIRED at build time and must be the real Worker URL from step d. If it is missing, the production site silently calls `http://localhost:8787`; if it is empty, it calls Pages-relative URLs; if it is the `.env.example` placeholder (`https://your-worker.workers.dev`), it calls a host that is not yours. None of these must ever reach a release.

From `game-lab/monkey-bomb`:

```
VITE_WORKER_URL=https://<worker-url> VITE_APP_VERSION=v0 npm run build
VITE_WORKER_URL=https://<worker-url> npm run check:release
npx wrangler pages deploy dist --project-name <name>
```

(Windows PowerShell: `$env:VITE_WORKER_URL = "https://<worker-url>"` first, then the same three commands without the prefix. You can also put the values in `.env.local`, which is git-ignored; see `.env.example`, whose Worker URL is a PLACEHOLDER you must replace. Or upload `dist/` in the Pages dashboard.)

`npm run check:release` is the last step before `pages deploy`, and it needs the same `VITE_WORKER_URL` in the shell that runs it. It exits non-zero if `dist/privacy.html` still contains `OWNER_EMAIL` or `OWNER_NAME`, if the built JS contains `localhost:8787` or `your-worker.workers.dev`, or if `VITE_WORKER_URL` is set and no built script contains it (or it is set but empty). Without `VITE_WORKER_URL` in the shell it only prints a warning and cannot check the Worker URL: do not skip it. Do not deploy while it fails.

`wrangler pages deploy` also prints a per-deployment URL like `https://<hash>.<name>.pages.dev`. That origin is NOT in `ALLOWED_ORIGINS`, so the game opened there gets 403. Smoke-test on the production alias (`https://<name>.pages.dev`) or your custom domain, or add that exact origin for the test (a redeploy of the Worker with `--var`, step d).

## f) Live smoke test

Three devices: one desktop, two phones, at least one phone on mobile data (this exercises TURN). Everybody wears HEADPHONES: three devices in one room feed back through their speakers and the test is useless.

1. Device 1 opens the site, taps Create, allows the microphone, reads out the 4-letter code.
2. Devices 2 and 3 open the site, tap Join, enter the code, allow the microphone.
3. Device 1 (the room CREATOR) is the host: the host is the first player who joined the room, and only the host sees Start and the level chips. Device 1 starts level 1 and the three players clear it using voice.
4. Host handover check: Device 1 reloads the page and rejoins with the same code. It now has a later place than the other two, so another device becomes the host and sees Start. This is expected, not a bug.

Expected:
- All three connect; the lobby shows 3 of 3 players.
- The three roles are distinct (blind, deaf, mute).
- The microphone prompt appears on each device (and the page still works if it is refused).
- The mute player is silent for both others; the deaf player hears nothing from the others.
- Emotes show the SAME label on every screen, by role ("Mute: Yes").
- On the results screen every player has a Back to the lobby button; stars appear on every device's level list after a win.
- The footer shows `v0` and a Privacy link that opens in a new tab (the room stays connected).
- A network that blocks direct connections and relay: after about 20 seconds the lobby says a connection could not be established and Leave works.

Report failures with the version label and the room code.

## g) Abuse limits and cost

The Worker limits requests per client IP, per minute:

| Route | Limit |
| --- | --- |
| relay credentials (`GET /turn`) | 20 |
| create a room (`POST /rooms`) | 10 |
| join a room (the WebSocket on `/rooms/<code>/ws`, any attempt) | 40 |

Over the limit the answer is 429 with `Retry-After`. IPv6 clients are counted per /64 network (one household or one provider prefix is one client), IPv4-mapped IPv6 as the IPv4 address. A room code expires 10 minutes after the room empties (or after it was created, if nobody joined). The WebSocket sends a small ping every 25 seconds and the Worker answers it without waking up, so an idle waiting room costs almost nothing.

What the limits do NOT stop:

- The origin check protects users' browsers only. A request with NO `Origin` header (curl, a script) is accepted by design, so anybody can ask the Worker for relay credentials, within 20 per minute per IP. Each answer is a TURN credential valid for one hour (`TURN_TTL_SEC`): a determined abuser with many IPs can run traffic through YOUR TURN account. Ruling R20: in version 0 credentials are not tied to room membership.
- Counters are per IP, not global.

So, before the first public link: in the Cloudflare dashboard set a usage or billing notification (Notifications) for Workers / Durable Objects usage and for the Realtime TURN usage, with a threshold you are comfortable paying. Look at the current TURN price and free allowance on Cloudflare's pricing page. The exact names of the notification types in the dashboard have not been checked by the implementer. If the TURN bill ever surprises you, delete the TURN key (step b): the game then runs on direct connections and STUN only.

## h) Known limits

- Worker tests (`worker/`, `npx vitest run`) need the VC++ runtime for workerd on Windows; without it they crash with access violation 0xc0000005.
- Do not run `npm install` in `worker/` on the dev machine that holds the copied DLLs: it removes them.
- Safari/iOS audio autoplay behaviour is unverified; a refused `play()` is retried on the next tap or key press, but only a real iPhone in the smoke test proves it works.
- The TURN provider response shape is unverified (step b).
- Version 0 has levels 1 to 10; the engine has more, the level picker and the stars stop at 10.
- The store apps (Capacitor) come later; their origins must then be added to `ALLOWED_ORIGINS`.
