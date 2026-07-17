import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export default function phase11GlobalSetup(): void {
  if (process.env.MERIDIAN_PHASE11_BENCH !== '1') return;
  rmSync(
    fileURLToPath(new URL('../../../benchmarks/results/studio.json', import.meta.url)),
    { force: true },
  );
}
