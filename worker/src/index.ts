export { Room } from './room';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{4}$`);
const MAX_CREATE_ATTEMPTS = 10;

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function randomCode(): string {
  let code = '';
  while (code.length < 4) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    // 230 = 23 * 10: reject the top bytes so every letter is equally likely
    if (b < 230) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  }
  return code;
}

async function createRoom(env: Cloudflare.Env): Promise<Response> {
  for (let i = 0; i < MAX_CREATE_ATTEMPTS; i++) {
    const code = randomCode();
    const stub = env.ROOM.get(env.ROOM.idFromName(code));
    const res = await stub.fetch('https://room/init', { method: 'POST' });
    if (res.status === 201) return json({ code }, 201);
    if (res.status !== 409) break;
  }
  return json({ error: 'unavailable' }, 503);
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/rooms') {
      if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405, { allow: 'POST' });
      return createRoom(env);
    }

    const m = /^\/rooms\/([^/]+)\/ws$/.exec(pathname);
    if (m) {
      if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
      const code = m[1];
      if (!CODE_RE.test(code)) return json({ error: 'no-room' }, 404);
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      return stub.fetch(new Request('https://room/ws', request));
    }

    return json({ error: 'not-found' }, 404);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
