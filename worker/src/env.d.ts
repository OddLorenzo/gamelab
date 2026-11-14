declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./index');
  }
  interface Env {
    ROOM: DurableObjectNamespace<import('./room').Room>;
    RATE_LIMITER: DurableObjectNamespace<import('./rate-limiter').RateLimiter>;
    /** Worker secrets (wrangler secret put). Optional: without them /turn serves STUN only. */
    TURN_KEY_ID?: string;
    TURN_API_TOKEN?: string;
    /** Comma-separated browser origins allowed to call the Worker (wrangler.toml [vars]). Missing or empty allows none. */
    ALLOWED_ORIGINS?: string;
  }
}
