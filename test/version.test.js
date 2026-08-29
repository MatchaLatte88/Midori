import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSemver, canonicalVersion, collectChangelogProblems, collectVersionProblems,
  frontendSource, readJson, readText,
} from '../scripts/version-lib.mjs';

/* ─── SemVer ────────────────────────────────────────────────────────────── */

test('valid SemVer is accepted, including prereleases and build metadata', () => {
  for (const version of ['0.1.0', '0.1.0-dev', '1.0.0-dev.1', '1.0.0-rc.2+build.7']) {
    assert.equal(assertSemver(version), version);
  }
});

test('near-miss versions are rejected rather than quietly accepted', () => {
  // A leading "v" or a padded zero would sort and compare wrongly later.
  for (const invalid of ['v1.0.0', '1.0', '01.0.0', '1.0.0-dev.01', 'latest', '', null, 42]) {
    assert.throws(() => assertSemver(invalid), /Invalid SemVer/, `${JSON.stringify(invalid)}`);
  }
});

/* ─── Drift detection ───────────────────────────────────────────────────── */

const VERSION = '1.2.3-dev';

function synchronizedSources(version = VERSION) {
  return {
    packageJson: { version },
    packageLock: { version, packages: { '': { version } } },
    frontend: frontendSource(version),
  };
}

test('a fully synchronized tree reports no problems', () => {
  assert.deepEqual(collectVersionProblems(VERSION, synchronizedSources()), []);
});

test('every derived location is checked on its own', () => {
  const mutations = [
    ['package.json', (s) => { s.packageJson.version = '9.9.9'; }],
    ['package-lock.json root', (s) => { s.packageLock.version = '9.9.9'; }],
    ['package-lock.json packages', (s) => { s.packageLock.packages[''].version = '9.9.9'; }],
    ['generated module', (s) => { s.frontend = frontendSource('9.9.9'); }],
    ['missing generated module', (s) => { s.frontend = null; }],
  ];

  for (const [label, mutate] of mutations) {
    const drifted = synchronizedSources();
    mutate(drifted);
    const problems = collectVersionProblems(VERSION, drifted);
    assert.equal(problems.length, 1, `${label} should produce exactly one problem`);
  }
});

test('several drifted files are all reported, not just the first', () => {
  const drifted = synchronizedSources();
  drifted.packageJson.version = '9.9.9';
  drifted.frontend = frontendSource('9.9.9');
  assert.equal(collectVersionProblems(VERSION, drifted).length, 2);
});

test('the generated module is exact, so a hand edit counts as drift', () => {
  const drifted = synchronizedSources();
  // Same version, but reformatted by hand.
  drifted.frontend = `export const APP_VERSION = '${VERSION}'\n`;
  assert.equal(collectVersionProblems(VERSION, drifted).length, 1);
});

/* ─── Changelog ─────────────────────────────────────────────────────────── */

test('the newest changelog entry has to name the current version', () => {
  const good = { releases: [{ version: `v${VERSION}`, date: 'Aug 2026', changes: [{ type: 'feat', text: 'x' }] }] };
  assert.deepEqual(collectChangelogProblems(VERSION, good), []);

  const stale = { releases: [{ version: 'v1.0.0', date: 'Aug 2026', changes: [{ type: 'feat', text: 'x' }] }] };
  assert.equal(collectChangelogProblems(VERSION, stale).length, 1,
    'otherwise the app would mark the wrong entry as latest');
});

test('an empty or shapeless changelog is a problem, not a crash', () => {
  assert.equal(collectChangelogProblems(VERSION, null).length, 1);
  assert.equal(collectChangelogProblems(VERSION, {}).length, 1);
  assert.equal(collectChangelogProblems(VERSION, { releases: [] }).length, 1);
  assert.equal(collectChangelogProblems(VERSION, {
    releases: [{ version: `v${VERSION}`, date: 'Aug 2026', changes: [] }],
  }).length, 1, 'a release with nothing in it says nothing');
});

/* ─── The real project ──────────────────────────────────────────────────── */

test('this checkout is synchronized', () => {
  // The same check `npm run check:version` runs, so drift fails the test suite
  // too rather than only a separate command someone has to remember.
  const version = canonicalVersion();
  const problems = collectVersionProblems(version, {
    packageJson: readJson('package.json'),
    packageLock: readJson('package-lock.json'),
    frontend: readText('src/generated/version.js'),
  });
  assert.deepEqual(problems, [], `run "npm run sync:version" — expected ${version}`);
});

test('this checkout has a changelog entry for its version', () => {
  const version = canonicalVersion();
  const problems = collectChangelogProblems(version, readJson('src/data/changelog.json'));
  assert.deepEqual(problems, []);
});

test('every changelog entry is well formed', () => {
  const KNOWN_TYPES = ['feat', 'fix', 'perf', 'style', 'break'];
  const changelog = readJson('src/data/changelog.json');
  const seen = new Set();

  for (const release of changelog.releases) {
    assert.match(release.version, /^v\d+\.\d+\.\d+/, `${release.version} needs a leading v`);
    assert.ok(release.date, `${release.version} needs a date`);
    assert.equal(seen.has(release.version), false, `${release.version} appears twice`);
    seen.add(release.version);

    for (const change of release.changes) {
      assert.ok(KNOWN_TYPES.includes(change.type),
        `${release.version}: unknown change type "${change.type}"`);
      assert.ok(change.text?.length > 10,
        `${release.version}: a change needs text a user can read`);
    }
  }
});
