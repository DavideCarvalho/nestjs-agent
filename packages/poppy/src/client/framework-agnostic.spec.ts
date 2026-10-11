import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `@dudousxd/nestjs-agent-poppy/client` is a Personal Agent for ANY runtime (a CLI, a worker, another
 * framework): its module tree must never reach NestJS — nor the rest of this package, which does.
 * Every import of every file under `src/client` is checked against this allow-list.
 */
const ROOT = dirname(fileURLToPath(import.meta.url));
const ALLOWED_PACKAGES = [/^node:/, /^jose$/, /^@modelcontextprotocol\/sdk\/client\//];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    // Specs and their helpers run under vitest; only what ships is checked.
    return path.endsWith('.ts') && !/\.spec(-helper)?\.ts$/.test(path) ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  }
  return found;
}

describe('the Poppy client is framework-agnostic', () => {
  it('imports only node:, jose, the MCP SDK client, and its own modules', () => {
    const offending: string[] = [];
    const sources = files(ROOT);
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          const target = resolve(dirname(file), spec);
          if (relative(ROOT, target).startsWith('..')) {
            offending.push(`${relative(ROOT, file)} → ${spec} (leaves poppy-client)`);
          }
        } else if (!ALLOWED_PACKAGES.some((allowed) => allowed.test(spec))) {
          offending.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it('catches a Nest import (the guard itself works)', () => {
    expect(specifiers("import { Injectable } from '@nestjs/common';")).toEqual(['@nestjs/common']);
    expect(ALLOWED_PACKAGES.some((allowed) => allowed.test('@nestjs/common'))).toBe(false);
    expect(ALLOWED_PACKAGES.some((allowed) => allowed.test('@dudousxd/nestjs-agent'))).toBe(false);
  });
});

describe('the Poppy client is shipped: subpath export and the poppy-agent bin', () => {
  const pkgDir = resolve(ROOT, '../..');
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    exports: Record<string, { import: { types: string; default: string } }>;
    bin: Record<string, string>;
  };

  it('declares ./client and the poppy-agent bin, both built from src/client', () => {
    expect(pkg.exports['./client']?.import).toEqual({
      types: './dist/client/index.d.ts',
      default: './dist/client/index.js',
    });
    expect(pkg.bin['poppy-agent']).toBe('./dist/client/bin/poppy-agent.js');
    const bin = readFileSync(join(ROOT, 'bin/poppy-agent.ts'), 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  const built = join(pkgDir, 'dist/client/index.js');
  const distExists = (() => {
    try {
      return statSync(built).isFile();
    } catch {
      return false;
    }
  })();
  it.skipIf(!distExists)(
    'the built subpath loads without NestJS and exposes the client',
    async () => {
      const mod = (await import(built)) as Record<string, unknown>;
      for (const name of [
        'PoppyAgent',
        'ConversationClient',
        'StateStore',
        'AgentIdentity',
        'discover',
      ]) {
        expect(typeof mod[name], name).toBe('function');
      }
    },
  );
});
