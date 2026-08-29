/* Writes version.json out to every place that carries a version number.
 * Run once after editing version.json; check-version.mjs verifies the result.
 */
import {
  canonicalVersion,
  frontendSource,
  readJson,
  writeJson,
  writeText,
} from './version-lib.mjs';

const version = canonicalVersion();

const packageJson = readJson('package.json');
packageJson.version = version;
writeJson('package.json', packageJson);

const packageLock = readJson('package-lock.json');
packageLock.version = version;
if (packageLock.packages?.['']) packageLock.packages[''].version = version;
writeJson('package-lock.json', packageLock);

writeText('src/generated/version.js', frontendSource(version));

process.stdout.write(`Synchronized Midori version ${version}.\n`);
