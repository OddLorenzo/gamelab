// Release gate: fails when a build is not ready to publish. Reads files only.
// Usage: node scripts/check-release.mjs [distDir]   (default: dist)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Pure check. `privacyHtml` is the built privacy.html text or null when it is missing;
 * `scripts` are the built JS files. Returns the list of problems (empty = ready).
 */
export function checkRelease({ privacyHtml, scripts }) {
  const problems = [];
  if (privacyHtml === null) problems.push('privacy.html is missing from the build');
  else if (privacyHtml.includes('OWNER_EMAIL')) {
    problems.push('privacy.html still contains OWNER_EMAIL: replace every occurrence in public/privacy.html and rebuild');
  }
  if (scripts.length === 0) problems.push('no built JavaScript found in assets/');
  for (const { name, text } of scripts) {
    if (text.includes('localhost:8787')) problems.push(`assets/${name} contains localhost:8787: build with VITE_WORKER_URL set`);
  }
  return problems;
}

function readDist(dist) {
  const privacy = join(dist, 'privacy.html');
  const assets = join(dist, 'assets');
  const names = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  return {
    privacyHtml: existsSync(privacy) ? readFileSync(privacy, 'utf8') : null,
    scripts: names.map((name) => ({ name, text: readFileSync(join(assets, name), 'utf8') })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkRelease(readDist(process.argv[2] ?? 'dist'));
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-release: ${p}`);
    process.exit(1);
  }
  console.log('check-release: ok');
}
