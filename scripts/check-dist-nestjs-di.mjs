#!/usr/bin/env node
// Fails when a class shipped in a secondary entry of `@dudousxd/nestjs-agent` (`/durable`, `/genui`,
// `/media`, …) asks Nest for a dependency BY CLASS and that class also lives in the main entry.
//
// Every entry is its own bundle, so `/durable` carries a private copy of each class it imports.
// A copy is a different injection token from the one `AgentModule` (main entry) provides: a required
// dependency fails at boot, and an `@Optional()` one resolves to `undefined` without a word — which
// is how the durable workflow once lost the message queue in every app built from the published
// package while the suite, which runs the sources, stayed green. Such a dependency must be asked for
// by a token that is the same value in every bundle (a `Symbol.for`, a string).
//
//   node scripts/check-dist-nestjs-di.mjs      packages/nestjs/dist (build first)
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkgDir = join(root, 'packages/nestjs');
const require = createRequire(join(pkgDir, 'package.json'));
require('reflect-metadata');

const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const entries = Object.entries(pkg.exports)
  .filter(([name, target]) => name !== '.' && typeof target?.require?.default === 'string')
  .map(([name, target]) => ({ name, file: join(pkgDir, target.require.default) }));
const mainFile = join(pkgDir, pkg.exports['.'].require.default);

if (!existsSync(mainFile)) {
  console.error(`check-dist-nestjs-di: ${mainFile} is missing — build the package first.`);
  process.exit(1);
}

const main = require(mainFile);
const mainClasses = new Map(
  Object.entries(main).filter(([, value]) => typeof value === 'function'),
);

/** Nest's explicit `@Inject(token)` parameters, by index. */
function explicitTokens(target) {
  const declared = Reflect.getMetadata('self:paramtypes', target) ?? [];
  return new Map(declared.map((entry) => [entry.index, entry.param]));
}

const problems = [];
for (const entry of entries) {
  const exported = require(entry.file);
  for (const [exportName, target] of Object.entries(exported)) {
    if (typeof target !== 'function') continue;
    const types = Reflect.getMetadata('design:paramtypes', target);
    if (!Array.isArray(types)) continue;
    const explicit = explicitTokens(target);
    types.forEach((type, index) => {
      if (explicit.has(index) || typeof type !== 'function') return;
      const twin = mainClasses.get(type.name);
      if (twin !== undefined && twin !== type) {
        problems.push(
          `${pkg.name}${entry.name.slice(1)}: ${exportName} constructor parameter #${index} injects ${type.name} by class, but this bundle's ${type.name} is a copy of the main entry's. Inject it by a shared token instead.`,
        );
      }
    });
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(
  `check-dist-nestjs-di: ${entries.length} secondary entries, no class injected across bundles.`,
);
