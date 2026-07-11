/**
 * ADR-0020 reproducible MSDF atlas regeneration.
 *
 *   pnpm --filter @meridian/renderer font:regen
 *
 * Bakes an MSDF `BitmapFont` atlas from the vendored DejaVu Sans source using the
 * pinned `msdf-bmfont-xml` generator. The baked code points mirror the coverage
 * manifest in `src/labels/atlas-manifest.ts`; `test/atlas-coverage.test.ts` fails
 * if the two ever drift. Generated files (`meridian-msdf.fnt`, `meridian-msdf.png`)
 * are checked in and MUST only change through this command.
 */
import generateBMFont from 'msdf-bmfont-xml';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'assets', 'fonts');
const HARNESS = join(HERE, '..', 'harness', 'public', 'fonts');

// Mirror of src/labels/atlas-manifest.ts. Keep in sync — the coverage test guards it.
const RANGES = [
  [0x20, 0x7e], // ASCII printable
  [0xa0, 0xff], // Latin-1 Supplement
];
const EXTRAS = [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026];

function codePoints() {
  const points = [];
  for (const [start, end] of RANGES) {
    for (let cp = start; cp <= end; cp++) points.push(cp);
  }
  return [...points, ...EXTRAS];
}

const charset = codePoints()
  .map((cp) => String.fromCodePoint(cp))
  .join('');

const OPTIONS = {
  outputType: 'xml',
  fieldType: 'msdf',
  charset,
  fontSize: 42,
  textureSize: [512, 512],
  distanceRange: 4,
  texturePadding: 2,
};

const FNT_NAME = 'meridian-msdf.fnt';
const PNG_NAME = 'meridian-msdf.png';

generateBMFont(join(ASSETS, 'DejaVuSans.ttf'), OPTIONS, (error, textures, font) => {
  if (error) {
    console.error('font:regen failed:', error);
    process.exitCode = 1;
    return;
  }
  mkdirSync(ASSETS, { recursive: true });
  mkdirSync(HARNESS, { recursive: true });
  if (textures.length !== 1) {
    console.error(`font:regen expected a single texture page, got ${textures.length}`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(join(ASSETS, PNG_NAME), textures[0].texture);
  // Point the descriptor page at the sibling PNG by its stable, unhashed name.
  const descriptor = font.data.replace(/file="[^"]*"/, `file="${PNG_NAME}"`);
  writeFileSync(join(ASSETS, FNT_NAME), descriptor);
  copyFileSync(join(ASSETS, FNT_NAME), join(HARNESS, FNT_NAME));
  copyFileSync(join(ASSETS, PNG_NAME), join(HARNESS, PNG_NAME));
  console.log(`font:regen wrote ${FNT_NAME} + ${PNG_NAME} (${charset.length} glyphs)`);
});
