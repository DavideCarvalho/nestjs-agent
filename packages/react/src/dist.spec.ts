import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain .mjs script, no declarations
import { bareReactUse } from '../../../scripts/check-dist-react.mjs';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const verifyScript = fileURLToPath(new URL('../scripts/verify-dist.mjs', import.meta.url));
const scanScript = fileURLToPath(new URL('../../../scripts/check-dist-react.mjs', import.meta.url));
const built = existsSync(`${packageDir}dist/index.js`);

describe('the bare-React scan', () => {
  it('flags classic-JSX output that never imports React', () => {
    const source = [
      'import { useMemo } from "react";',
      'function Provider() {',
      '  return /* @__PURE__ */ React.createElement(Context.Provider, null);',
      '}',
    ].join('\n');
    expect(bareReactUse(source)).toEqual({
      line: 3,
      text: 'return /* @__PURE__ */ React.createElement(Context.Provider, null);',
    });
  });

  it('accepts automatic-runtime output', () => {
    expect(
      bareReactUse('import { jsx } from "react/jsx-runtime";\nconst a = jsx("div", {});'),
    ).toBeNull();
  });

  it.each([
    'import React from "react";',
    'import React, { useMemo } from "react";',
    'import * as React from "react";',
    'var React = require("react");',
    'const React = __toESM(require("react"));',
  ])('accepts a module that binds React itself: %s', (binding: string) => {
    expect(bareReactUse(`${binding}\nconst a = React.createElement("div");`)).toBeNull();
  });

  it('does not mistake a member or a longer identifier for React', () => {
    expect(bareReactUse('const a = import_react.React.version; const b = $React.x;')).toBeNull();
    expect(bareReactUse('const a = MyReact.createElement;')).toBeNull();
  });

  it('does not mistake code written out as a string for a use', () => {
    expect(
      bareReactUse("const tag = 'React.Fragment'; const c = `React.createElement(${tag})`;"),
    ).toBeNull();
  });
});

// The built package is what this guards, so it needs a build. CI always has one (`pnpm build` runs
// before `pnpm test`) and must not skip; locally it runs whenever dist/ is there.
describe.skipIf(!built && process.env.CI === undefined)('the built package', () => {
  it('loads every entry and renders its providers with no global React', () => {
    const output = execFileSync(process.execPath, [verifyScript], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(output).toMatch(/checks passed with no global React/);
  }, 60_000);

  it('has no file that references React without importing it', () => {
    const output = execFileSync(process.execPath, [scanScript, `${packageDir}dist`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toMatch(/none references an unbound React/);
  });
});
