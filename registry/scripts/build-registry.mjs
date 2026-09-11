#!/usr/bin/env node
// Renders registry.json into the flat `/r/` files `shadcn add <url>` fetches: one JSON per item
// with every file's source inlined, plus an index listing the items without their contents.
//
//   node scripts/build-registry.mjs                       # → registry/dist/r
//   node scripts/build-registry.mjs --out ../../aviary/public/r
//
// The docs site serves the output as static assets, so this runs when the components change, not
// on every site build.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITEM_SCHEMA = 'https://ui.shadcn.com/schema/registry-item.json';

const outFlag = process.argv.indexOf('--out');
const outDir = resolve(
  REGISTRY_ROOT,
  outFlag === -1 ? 'dist/r' : (process.argv[outFlag + 1] ?? 'dist/r'),
);

const registry = JSON.parse(readFileSync(join(REGISTRY_ROOT, 'registry.json'), 'utf8'));

// Every .tsx under the components tree has to belong to an item, or it ships to nobody.
const sourceFiles = new Set(
  readdirSync(join(REGISTRY_ROOT, 'src/components/agent-chat'))
    .filter((name) => name.endsWith('.tsx') && !name.endsWith('.spec.tsx'))
    .map((name) => `src/components/agent-chat/${name}`),
);
const listed = new Set(registry.items.flatMap((item) => item.files.map((file) => file.path)));
const orphans = [...sourceFiles].filter((path) => !listed.has(path));
if (orphans.length > 0) {
  console.error(`✖ not listed in registry.json:\n  ${orphans.join('\n  ')}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const index = {
  $schema: registry.$schema,
  name: registry.name,
  homepage: registry.homepage,
  items: [],
};

for (const item of registry.items) {
  const files = item.files.map((file) => ({
    ...file,
    content: readFileSync(join(REGISTRY_ROOT, file.path), 'utf8'),
  }));
  writeFileSync(
    join(outDir, `${item.name}.json`),
    `${JSON.stringify({ $schema: ITEM_SCHEMA, ...item, files }, null, 2)}\n`,
  );
  const { files: _files, ...summary } = item;
  index.items.push(summary);
}

writeFileSync(join(outDir, 'registry.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`✔ ${registry.items.length} item(s) → ${outDir}`);
