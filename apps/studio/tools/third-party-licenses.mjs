/**
 * Prints the license text of every npm package in the Studio's production
 * dependency tree, which is the code a Studio build can bundle. The hosted
 * demo ships the output as THIRD_PARTY_LICENSES.txt (see build-pages.sh).
 *
 *   node apps/studio/tools/third-party-licenses.mjs > THIRD_PARTY_LICENSES.txt
 *
 * Vendored files (tree-sitter grammars, DejaVu Sans and its atlas) are covered
 * by THIRD_PARTY_NOTICES.md at the repository root.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = execFileSync(
  'pnpm',
  ['licenses', 'list', '--prod', '--json', '--filter', '@meridian/studio...'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const packages = Object.values(JSON.parse(raw))
  .flat()
  .sort((a, b) => a.name.localeCompare(b.name));

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;

function licenseTexts(dir) {
  let names;
  try {
    names = readdirSync(dir).filter((name) => LICENSE_FILE.test(name)).sort();
  } catch {
    return [];
  }
  return names.map((name) => readFileSync(join(dir, name), 'utf8').trim());
}

const lines = [
  'Third-party software bundled with Meridian Studio',
  '',
  `${packages.length} npm packages from the Studio's production dependency tree,`,
  'as reported by `pnpm licenses list --prod --filter @meridian/studio...`.',
  'Meridian itself is MIT-licensed (LICENSE.txt). Vendored grammars and the',
  'DejaVu Sans font are covered by THIRD_PARTY_NOTICES.md and fonts/LICENSE-DejaVu.txt.',
];
for (const pkg of packages) {
  const versions = pkg.versions ?? [pkg.version];
  lines.push('', '='.repeat(78), `${pkg.name}@${versions.join(', ')}  (${pkg.license})`);
  if (pkg.homepage) lines.push(pkg.homepage);
  lines.push('-'.repeat(78));
  const texts = (pkg.paths ?? []).slice(0, 1).flatMap(licenseTexts);
  lines.push(texts.length > 0 ? texts.join('\n\n') : `(No license file in the package; declared license: ${pkg.license}.)`);
}
process.stdout.write(`${lines.join('\n')}\n`);
