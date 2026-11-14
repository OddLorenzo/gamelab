import { describe, expect, it } from 'vitest';
import { checkRelease } from '../scripts/check-release.mjs';

const good = {
  privacyHtml: '<a href="mailto:me@real.example">me@real.example</a>',
  scripts: [{ name: 'index-1.js', text: 'var u="https://w.example";' }],
};

describe('check-release', () => {
  it('passes a clean build', () => {
    expect(checkRelease(good)).toEqual([]);
  });

  it('fails while OWNER_EMAIL is still in privacy.html', () => {
    const p = checkRelease({ ...good, privacyHtml: '<a href="mailto:OWNER_EMAIL">OWNER_EMAIL</a>' });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('OWNER_EMAIL');
  });

  it('fails when a built script holds the localhost:8787 fallback, naming the file', () => {
    const p = checkRelease({ ...good, scripts: [{ name: 'a.js', text: 'ok' }, { name: 'b.js', text: 'x=`http://localhost:8787`' }] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('b.js');
    expect(p[0]).toContain('localhost:8787');
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
  });
});
