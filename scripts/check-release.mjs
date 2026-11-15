// Release gate: fails when a build is not ready to publish. Reads files only.
// Usage: node scripts/check-release.mjs [distDir]   (default: dist)
// Set VITE_WORKER_URL (the value used for the build) in the shell running it: the build is then
// checked to really contain that Worker URL.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Pure check. `privacyHtml` is the built privacy.html text or null when it is missing;
 * `scripts` are the built JS files; `workerUrl` is the VITE_WORKER_URL of the environment running
 * the check (undefined when it is not set). Returns the list of problems (empty = ready).
 */
export function checkRelease({ privacyHtml, scripts, workerUrl }) {
  const problems = [];
  if (privacyHtml === null) problems.push('privacy.html is missing from the build');
  else {
    if (privacyHtml.includes('OWNER_EMAIL')) {
      problems.push('privacy.html still contains OWNER_EMAIL: replace every occurrence in public/privacy.html and rebuild');
    }
    if (privacyHtml.includes('OWNER_NAME')) {
      problems.push('privacy.html still contains OWNER_NAME: replace every occurrence in public/privacy.html and rebuild');
    }
  }
  if (scripts.length === 0) problems.push('no built JavaScript found in assets/');
  for (const { name, text } of scripts) {
    if (text.includes('localhost:8787')) problems.push(`assets/${name} contains localhost:8787: build with VITE_WORKER_URL set`);
    if (text.includes('your-worker.workers.dev')) {
      problems.push(`assets/${name} contains your-worker.workers.dev (the .env.example placeholder): build with the real VITE_WORKER_URL`);
    }
  }
  if (workerUrl !== undefined && scripts.length > 0) {
    if (workerUrl.trim() === '') {
      problems.push('VITE_WORKER_URL is set but empty: the site would call Pages-relative URLs; build with the real Worker URL');
    } else if (!scripts.some(({ text }) => text.includes(workerUrl))) {
      problems.push(`no built script contains VITE_WORKER_URL (${workerUrl}): the build used another value, rebuild with it set`);
    }
  }
  return problems;
}

/** Things worth a look that do not stop a release. */
export function releaseWarnings({ workerUrl }) {
  if (workerUrl !== undefined) return [];
  return [
    'VITE_WORKER_URL is not set in this shell, so the Worker URL baked into the build was NOT checked: set it to the value used for the build and run check:release again',
  ];
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
  const input = { ...readDist(process.argv[2] ?? 'dist'), workerUrl: process.env.VITE_WORKER_URL };
  for (const w of releaseWarnings(input)) console.warn(`check-release: warning: ${w}`);
  const problems = checkRelease(input);
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-release: ${p}`);
    process.exit(1);
  }
  console.log('check-release: ok');
}
