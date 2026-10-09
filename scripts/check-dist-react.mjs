#!/usr/bin/env node
// Fails when a built file calls `React.<something>` without binding `React` in that module.
//
// That is what the classic JSX transform emits (`React.createElement(...)`), and a module compiled
// that way only works where a GLOBAL `React` happens to exist — it throws
// `ReferenceError: React is not defined` in every app that does not set one. Every package here
// builds JSX with the automatic runtime (`react/jsx-runtime`), so a bare `React.` in a dist file
// means a build config regressed.
//
//   node scripts/check-dist-react.mjs            every packages/*/dist
//   node scripts/check-dist-react.mjs <dir> ...  these directories
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * `React.x` used as a value: not `foo.React.x`, not `$React.x`, and not code a module writes out as
 * a string (`'React.Fragment'`, `` `React.createElement(…)` `` — the sandbox's JSX transpiler).
 */
const USE = /(?<![\w$.'"`])React\s*\.\s*[A-Za-z_$]/;
/** Anything that binds the identifier `React` in the module. */
const BINDINGS = [
  /\bimport\s+React\b/, // import React from 'react' / import React, { … }
  /\bimport\s*\*\s*as\s+React\b/, // import * as React from 'react'
  /\bimport\s*\{[^}]*\bas\s+React\b[^}]*\}/, // import { default as React }
  /\b(?:var|let|const)\s+React\b/, // const React = require('react')
  /\bfunction\s+React\b/,
];

/** The first line that uses a bare `React.`, or `null` when the module is fine. */
export function bareReactUse(source) {
  if (!USE.test(source)) return null;
  if (BINDINGS.some((binding) => binding.test(source))) return null;
  const lines = source.split('\n');
  const index = lines.findIndex((line) => USE.test(line));
  return { line: index + 1, text: lines[index].trim().slice(0, 160) };
}

// Application bundles, not library modules: Vite bundles React itself into these (minified, with
// React's own error strings naming `React.…`), so there is no import to look for and nothing a
// consumer's bundler resolves.
const APP_BUNDLES = [join(root, 'packages/dashboard/dist/spa')];

function* walk(dir) {
  if (APP_BUNDLES.includes(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') yield* walk(path);
    } else if (/\.(?:js|cjs|mjs)$/.test(name)) {
      yield path;
    }
  }
}

function distDirs() {
  const packages = join(root, 'packages');
  return readdirSync(packages)
    .map((name) => join(packages, name, 'dist'))
    .filter((dir) => existsSync(dir));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs =
    process.argv.length > 2 ? process.argv.slice(2).map((dir) => resolve(dir)) : distDirs();
  if (dirs.length === 0) {
    console.error('check-dist-react: nothing is built — run `pnpm build` first');
    process.exit(1);
  }
  const problems = [];
  let scanned = 0;
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      scanned += 1;
      const found = bareReactUse(readFileSync(file, 'utf8'));
      if (found !== null) problems.push({ file: relative(root, file), ...found });
    }
  }
  if (problems.length > 0) {
    console.error(
      'These built files reference `React.` without importing it — they throw ' +
        '"React is not defined" in an app with no global React.\n' +
        'Build JSX with the automatic runtime (tsconfig `jsx: "react-jsx"`, esbuild `jsx: "automatic"`).\n',
    );
    for (const problem of problems) {
      console.error(`  ${problem.file}:${problem.line}  ${problem.text}`);
    }
    process.exit(1);
  }
  console.log(`check-dist-react: ${scanned} built files, none references an unbound React`);
}
