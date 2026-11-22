#!/usr/bin/env node
// Render smoke check: every route must render CONTENT, not just its title.
//
// Why this is a separate script and not a unit test. Four defects in this project
// were invisible to the build, to `node --test`, and to the console:
//
//   * an i18n message with a bare brace  -> the component renders as a comment
//   * a template calling FL() that the <script setup> never defined -> same
//   * a `const` helper used above its own declaration (a TDZ)       -> same
//   * a kind with no form branch, so the modal rendered empty
//
// In every case the page loads, Vue throws at RENDER time, and the view becomes a
// comment node: the shell (sidebar, h1) looks fine and the body is empty. Only a
// real browser sees it, which is why this exists.
//
//   node scripts/smoke-routes.mjs
//   node scripts/smoke-routes.mjs --base http://127.0.0.1:8799 --session smoke2
//
// Needs a running console and `opencli` on PATH. It is deliberately not wired
// into `npm test`: a browser dependency has no place in the unit suite, and a
// check that silently skips itself when no browser is present is worse than no
// check at all. Run it before a release.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const base = flag('--base', process.env.SMOKE_BASE ?? 'http://127.0.0.1:8788');
const session = flag('--session', process.env.SMOKE_SESSION ?? 'smoke');
const settle = Number(flag('--settle', '4000'));

// The route list comes from the router itself, so a page added tomorrow cannot be
// forgotten here — the same reason the copy guards read the catalogue. Overridable
// because resolving it relative to this script breaks when the script is copied
// somewhere else (a colleague had to build a two-file tree to run it).
function findRouter() {
  const explicit = flag('--router', process.env.SMOKE_ROUTER);
  const candidates = [
    explicit,
    path.join(ROOT, 'web/src/router.js'),
    path.join(process.cwd(), 'web/src/router.js'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  console.error(`No router found. Tried: ${candidates.join(', ')}. Pass --router <path>.`);
  process.exit(2);
}

const routes = [...readFileSync(findRouter(), 'utf8').matchAll(/\bpath:\s*'([^']+)'/g)].map((m) => m[1]);
if (!routes.length) {
  console.error('No routes found — refusing to report a vacuous pass.');
  process.exit(2);
}

// The catalogue's detail pages are not routes: they are reached by clicking a card
// on /resources. These four are the ones the brace defect originally hit — their
// bands silently disappeared — so they need their own judgement rather than being
// covered by "the /resources route rendered".
const DETAIL_KINDS = ['mcp_servers', 'teams', 'cache_policies', 'rate_limit_policies'];

// What "rendered" means, stated as the failure signature rather than a length
// threshold: a healthy view has text beyond its own heading. A blank view keeps
// exactly the h1 and nothing else.
const PROBE = `(() => {
  // A logged-out console renders the login card, which would look healthy route
  // by route and turn this whole check into a rubber stamp — the exact failure
  // mode it exists to prevent. The sidebar only exists inside the app.
  if (!document.querySelector('aside a[href="/resources"]')) {
    return JSON.stringify({
      ok: false,
      why: 'not logged in: no sidebar, so every route shows the login page. Log in once in this browser session, then run again.',
    });
  }
  const main = document.querySelector('main');
  if (!main) return JSON.stringify({ ok: false, why: 'no <main> element' });
  const h1 = (main.querySelector('h1')?.textContent ?? '').trim();
  const text = (main.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const views = main.querySelectorAll('.card, .rcard, table').length;
  return JSON.stringify({
    ok: text.length > h1.length + 10,
    h1,
    len: text.length,
    views,
    bandRows: main.querySelectorAll('dl.facts .row').length,
    hasToggle: !!main.querySelector('dl.facts .facts-toggle'),
    head: main.innerHTML.replace(/data-v-[a-z0-9]+=""/g, '').replace(/\\s+/g, ' ').slice(0, 160),
  });
})()`;

// Expand the band and count what appeared. Kept as its own eval because a promise
// must never be returned from `opencli eval` — CDP waits for the value and times
// out (a colleague hit exactly this; see the note at the bottom of this file).
const EXPAND = `(() => {
  const b = document.querySelector('main dl.facts .facts-toggle');
  if (!b) return JSON.stringify({ clicked: false });
  b.click();
  return JSON.stringify({ clicked: true });
})()`;
const BAND_ROWS = `document.querySelectorAll('main dl.facts .row').length`;

// The probe travels base64-encoded: on Windows `opencli` is a .cmd, so Node runs
// it through a shell that joins arguments without quoting, and raw JS full of
// spaces and quotes does not survive that.
const b64 = Buffer.from(PROBE, 'utf8').toString('base64');

// On Windows `opencli` is a .cmd, and Node refuses to spawn one without a shell —
// which both warns (DEP0190) and concatenates arguments unescaped. The shim is a
// thin wrapper around a JS entry, so find and call that directly instead; fall
// back to the command itself if the layout ever changes.
function findCliEntry() {
  const explicit = flag('--opencli', process.env.OPENCLI_ENTRY);
  if (explicit) return explicit;
  const rel = path.join('node_modules', '@jackwener', 'opencli', 'dist', 'src', 'main.js');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const cliEntry = findCliEntry();

async function opencli(args) {
  const command = cliEntry ? process.execPath : 'opencli';
  const prefix = cliEntry ? [cliEntry] : [];
  const { stdout } = await execFileAsync(command, [...prefix, ...args], {
    shell: !cliEntry,
    maxBuffer: 8 * 1024 * 1024,
  });
  const envelope = JSON.parse(stdout.trim());
  if (envelope.ok === false) throw new Error(envelope.error?.message ?? 'opencli call failed');
  return envelope.data;
}

const failures = [];
console.log(`render smoke: ${routes.length} routes against ${base} (session "${session}")`);

// One band judgement, used by routes and detail pages alike. The hole this closes:
// a band showing a single row with NO toggle is indistinguishable from a collapsed
// band by row count alone, and an earlier version of this check passed it silently
// — which is the very "collapsed or missing?" confusion the check exists to end.
async function judgeBand(result) {
  if (!result.ok) return '';
  if (result.bandRows === 1 && result.hasToggle) {
    await opencli(['browser', 'eval', EXPAND, '--session', session]);
    await new Promise((r) => setTimeout(r, 400));
    const rows = Number(await opencli(['browser', 'eval', BAND_ROWS, '--session', session]));
    // Reset before the next page: the state is per-origin, and leaving it expanded
    // makes the following page skip its own collapse->expand check.
    await opencli(['browser', 'eval', `localStorage.removeItem('resourceFactsExpanded'); 1`, '--session', session]);
    if (rows <= 1) {
      result.ok = false;
      result.why = `the expand toggle did not reveal the rest: band stayed at ${rows} row(s) after clicking it`;
    }
    return ` band 1->${rows}`;
  }
  if (result.bandRows === 1 && !result.hasToggle) {
    result.ok = false;
    result.why = 'band shows one row and has no expand control — the other answers are missing, not collapsed';
    return ' band 1 (no toggle)';
  }
  if (result.bandRows > 1) {
    await opencli(['browser', 'eval', `localStorage.removeItem('resourceFactsExpanded'); 1`, '--session', session]);
    return ` band ${result.bandRows} (left over expanded, reset)`;
  }
  return '';
}

for (const route of routes) {
  await opencli(['browser', 'open', `${base}${route}`, '--session', session]);
  await new Promise((r) => setTimeout(r, settle));
  const raw = await opencli(['browser', 'eval', `(0,eval)(atob('${b64}'))`, '--session', session]);
  const result = JSON.parse(raw);

  // The explanation band is collapsed by default (that is what won the space
  // back), so "collapsed" has to be verified as collapsed-then-expandable rather
  // than mistaken for missing.
  const bandNote = await judgeBand(result);

  const verdict = result.ok ? 'ok  ' : 'FAIL';
  console.log(`  ${verdict} ${route.padEnd(16)} h1="${result.h1}" text=${result.len} views=${result.views}${bandNote}`);
  if (!result.ok) failures.push({ route, ...result });
}

if (failures.length) {
  // Failures are printed once, after the detail pages have also run — exiting here
  // would report the routes and skip the catalogue checks that matter most.
  console.error(`\n${failures.length} page(s) already failed among the routes; continuing to the detail pages.`);
}

console.log('\nevery route rendered content');

// ---- catalogue detail pages ------------------------------------------------
// Reached by clicking a card, not by URL. The check is the same one the routes get
// (something beyond the heading) plus the band: collapsed to 1 row, expanding to 7.
console.log(`\ndetail pages: ${DETAIL_KINDS.length} kinds via /resources`);

for (const kind of DETAIL_KINDS) {
  // The query string is not decoration: entering a detail page does not change the
  // URL, so opening the same /resources again is a no-op and the page stays in the
  // detail view where no card exists. A distinct URL forces the reload.
  await opencli(['browser', 'open', `${base}/resources?detail=${kind}`, '--session', session]);
  await new Promise((r) => setTimeout(r, settle));
  const click = JSON.parse(
    await opencli([
      'browser', 'eval',
      `(() => { const c = document.querySelector('main .rcard[data-kind="${kind}"]'); if (!c) return JSON.stringify({ ok: false }); c.click(); return JSON.stringify({ ok: true }); })()`,
      '--session', session,
    ]),
  );
  if (!click.ok) {
    console.log(`  FAIL ${kind.padEnd(22)} no card with data-kind="${kind}" on /resources`);
    failures.push({ route: `/resources -> ${kind}`, h1: '', len: 0, why: 'card not found' });
    continue;
  }
  await new Promise((r) => setTimeout(r, settle));
  const result = JSON.parse(await opencli(['browser', 'eval', `(0,eval)(atob('${b64}'))`, '--session', session]));

  const bandNote = await judgeBand(result);
  if (result.ok && result.bandRows < 1) {
    result.ok = false;
    result.why = 'no explanation band on this detail page';
  }

  const verdict = result.ok ? 'ok  ' : 'FAIL';
  console.log(`  ${verdict} ${kind.padEnd(22)} h1="${result.h1}" text=${result.len}${bandNote}`);
  if (!result.ok) failures.push({ route: `/resources -> ${kind}`, ...result });
}

if (failures.length) {
  console.error(`\n${failures.length} page(s) failed:`);
  for (const f of failures) {
    console.error(`\n  ${f.route}  h1="${f.h1}" text=${f.len}`);
    console.error(`    ${f.why ?? 'only the heading is present — the view rendered as a comment node'}`);
    console.error(`    main starts: ${f.head}`);
  }
  console.error('\nA render-time throw leaves no trace in the DOM. Open the route and read the');
  console.error('browser console — note that wrap console.error from inside the page if the');
  console.error('error happened during load, because it fires before any DevTools opens.');
  process.exit(1);
}

console.log('\nevery route and detail page rendered content');
