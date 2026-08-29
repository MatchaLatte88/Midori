/* Reports any place the version has drifted from version.json.
 * Writes nothing, so it is safe as a gate before committing or in CI.
 */
import {
  canonicalVersion,
  collectChangelogProblems,
  collectVersionProblems,
  readJson,
  readText,
} from './version-lib.mjs';

const version = canonicalVersion();

const problems = collectVersionProblems(version, {
  packageJson: readJson('package.json'),
  packageLock: readJson('package-lock.json'),
  frontend: readText('src/generated/version.js'),
});

let changelog = null;
try {
  changelog = readJson('src/data/changelog.json');
} catch (err) {
  problems.push(`src/data/changelog.json: ${err.message}`);
}
if (changelog) problems.push(...collectChangelogProblems(version, changelog));

if (problems.length) {
  process.stderr.write(`Version drift detected; expected ${version}:\n- ${problems.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Version check passed: ${version}.\n`);
}
