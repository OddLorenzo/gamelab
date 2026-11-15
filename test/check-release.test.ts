import { describe, expect, it } from 'vitest';
import { checkRelease, releaseWarnings } from '../scripts/check-release.mjs';

const good = {
  privacyHtml: '<a href="mailto:me@real.example">me@real.example</a> Jane Doe',
  scripts: [{ name: 'index-1.js', text: 'var u="https://w.example";' }],
};

describe('check-release', () => {
  it('passes a clean build', () => {
    expect(checkRelease(good)).toEqual([]);
    expect(checkRelease({ ...good, workerUrl: 'https://w.example' })).toEqual([]);
  });

  it('fails while OWNER_EMAIL is still in privacy.html', () => {
    const p = checkRelease({ ...good, privacyHtml: '<a href="mailto:OWNER_EMAIL">OWNER_EMAIL</a>' });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('OWNER_EMAIL');
  });

  it('fails while OWNER_NAME is still in privacy.html', () => {
    const p = checkRelease({ ...good, privacyHtml: 'Responsible: OWNER_NAME, me@real.example' });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('OWNER_NAME');
  });

  it('fails when a built script holds the localhost:8787 fallback, naming the file', () => {
    const p = checkRelease({ ...good, scripts: [{ name: 'a.js', text: 'ok' }, { name: 'b.js', text: 'x=`http://localhost:8787`' }] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('b.js');
    expect(p[0]).toContain('localhost:8787');
  });

  it('fails when a built script holds the .env.example placeholder, naming the file', () => {
    const p = checkRelease({ ...good, scripts: [{ name: 'a.js', text: 'ok' }, { name: 'c.js', text: 'u="https://your-worker.workers.dev"' }] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('c.js');
    expect(p[0]).toContain('your-worker.workers.dev');
  });

  it('a real workers.dev URL is not the placeholder', () => {
    expect(checkRelease({ ...good, scripts: [{ name: 'a.js', text: 'u="https://monkey-bomb-signal.me.workers.dev"' }] })).toEqual([]);
  });

  it('other localhost values in the bundle do not fail it', () => {
    expect(checkRelease({ ...good, scripts: [{ name: 'a.js', text: 'http://localhost:5173' }] })).toEqual([]);
  });

  it('fails when privacy.html is missing or there is no script', () => {
    expect(checkRelease({ ...good, privacyHtml: null })).toHaveLength(1);
    expect(checkRelease({ ...good, scripts: [] })).toHaveLength(1);
  });

  it('reports every problem at once', () => {
    expect(checkRelease({ privacyHtml: 'OWNER_EMAIL', scripts: [{ name: 'a.js', text: 'localhost:8787' }] })).toHaveLength(2);
    expect(
      checkRelease({ privacyHtml: 'OWNER_EMAIL OWNER_NAME', scripts: [{ name: 'a.js', text: 'localhost:8787 your-worker.workers.dev' }] }),
    ).toHaveLength(4);
  });
});

describe('check-release: the Worker URL actually built in', () => {
  const url = 'https://monkey-bomb-signal.me.workers.dev';
  const built = { ...good, scripts: [{ name: 'a.js', text: `var w="${url}";` }] };

  it('passes when the bundle contains the VITE_WORKER_URL of the environment', () => {
    expect(checkRelease({ ...built, workerUrl: url })).toEqual([]);
  });

  it('fails when VITE_WORKER_URL is set and no built script contains it', () => {
    const p = checkRelease({ ...built, workerUrl: 'https://other.example' });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('VITE_WORKER_URL');
    expect(p[0]).toContain('https://other.example');
  });

  it('fails when VITE_WORKER_URL is set but empty (an empty string would be baked in)', () => {
    for (const workerUrl of ['', '   ']) {
      const p = checkRelease({ ...good, workerUrl });
      expect(p).toHaveLength(1);
      expect(p[0]).toContain('empty');
    }
  });

  it('one script holding it is enough', () => {
    const scripts = [{ name: 'x.js', text: 'nothing' }, { name: 'y.js', text: `f("${url}")` }];
    expect(checkRelease({ ...good, scripts, workerUrl: url })).toEqual([]);
  });

  it('does not stack a second problem when there is no script at all', () => {
    expect(checkRelease({ ...good, scripts: [], workerUrl: url })).toHaveLength(1);
  });

  it('is only a warning, never a failure, when VITE_WORKER_URL is not set', () => {
    expect(checkRelease({ ...built })).toEqual([]);
    const w = releaseWarnings({});
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('VITE_WORKER_URL');
    expect(w[0]).toContain('not set');
  });

  it('gives no warning when it is set', () => {
    expect(releaseWarnings({ workerUrl: url })).toEqual([]);
    expect(releaseWarnings({ workerUrl: '' })).toEqual([]); // set but empty is a failure instead
  });
});
