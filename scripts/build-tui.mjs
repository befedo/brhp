import { writeFile } from 'node:fs/promises';
import solidPlugin from '@opentui/solid/bun-plugin';

const result = await Bun.build({
  entrypoints: ['./src/tui/index.tsx'],
  outdir: './dist/tui',
  target: 'bun',
  format: 'esm',
  splitting: false,
  packages: 'external',
  plugins: [solidPlugin],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }

  process.exit(1);
}

// Emit root-level shims so opencode can resolve by path (not just package exports)
await writeFile('tui.js', 'export { default } from "./dist/tui/index.js";\n');
await writeFile('index.js', 'export { default } from "./dist/src/index.js";\n');
