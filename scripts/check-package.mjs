#!/usr/bin/env node
/**
 * Lints every published package the way a consumer would install it: `publint` checks the
 * package.json against the files that ship, and `@arethetypeswrong/cli` resolves the types of
 * every export from the packed tarball. Run after the build.
 *
 * Usage:
 *   node scripts/check-package.mjs            # every non-private package under packages/
 *   node scripts/check-package.mjs <dir>...   # the given package directories
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Extra `attw` flags per package. The dashboard's `./client` entry is the browser `AgentClient` and
 * ships as ESM only, so a CommonJS `require()` of it resolving to ESM is expected (and loads anyway on
 * Node 24, which has `require(esm)`).
 */
const attwExtra = {
  '@dudousxd/nestjs-agent-dashboard': ['--ignore-rules', 'cjs-resolves-to-esm'],
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = (name) => join(repoRoot, 'node_modules', '.bin', name);

const args = process.argv.slice(2);
const dirs =
  args.length > 0
    ? args.map((d) => resolve(d))
    : readdirSync(join(repoRoot, 'packages'))
        .map((d) => join(repoRoot, 'packages', d))
        .filter((d) => existsSync(join(d, 'package.json')));

let failed = 0;
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.private === true) continue;
  console.log(`\n▸ ${pkg.name}`);
  const out = mkdtempSync(join(tmpdir(), 'check-package-'));
  try {
    execFileSync(bin('publint'), ['run', '--strict', dir], { stdio: 'inherit' });
    execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'ignore' });
    const tarball = readdirSync(out).find((f) => f.endsWith('.tgz'));
    if (tarball === undefined) throw new Error(`pnpm pack wrote no .tgz to ${out}`);
    // `node16` profile: the packages need Node 24, so the pre-`exports` node10 resolution is moot.
    execFileSync(
      bin('attw'),
      [
        join(out, tarball),
        '--profile',
        'node16',
        '--format',
        'table',
        ...(attwExtra[pkg.name] ?? []),
      ],
      { stdio: 'inherit' },
    );
  } catch (error) {
    // publint and attw print their findings above; this names the package and covers a
    // failed `pnpm pack`, whose output is not shown.
    console.error(`✗ ${pkg.name}: ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`\n${failed} package(s) failed the package checks.`);
  process.exit(1);
}
