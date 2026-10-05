import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packagesRoot = new URL('../../', import.meta.url);
const isAgora = (name: string) => name.startsWith('@adonis-agora/');

async function sourceFiles(root: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), root);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name))
      files.push(path);
  }
  return files;
}

/** Parse import/export syntax so comments and compatible protocol names never count as coupling. */
function importedPackages(source: string): string[] {
  const packages: string[] = [];
  const tree = ts.createSourceFile(
    'module.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      packages.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteral(argument)) packages.push(argument.text);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      packages.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return packages;
}

describe('Aviary remains independent of Agora', () => {
  it('recognizes all package-loading syntax without confusing protocol compatibility with dependencies', () => {
    expect(
      importedPackages(`
      // Compatible protocol producer: @adonis-agora/agent/ag-ui
      const eventName = 'agora.ui';
      import { value } from '@adonis-agora/agent';
      export * from '@adonis-agora/agent/react';
      import '@adonis-agora/agent/genui';
      import('@adonis-agora/agent/react/genui/server');
      require('@adonis-agora/agent');
      type Foreign = import('@adonis-agora/agent').Foreign;
    `),
    ).toEqual([
      '@adonis-agora/agent',
      '@adonis-agora/agent/react',
      '@adonis-agora/agent/genui',
      '@adonis-agora/agent/react/genui/server',
      '@adonis-agora/agent',
      '@adonis-agora/agent',
    ]);
  });

  it('declares no Agora dependency in any Aviary package', async () => {
    const violations: string[] = [];
    for (const name of await readdir(packagesRoot)) {
      const manifest = JSON.parse(
        await readFile(new URL(`${name}/package.json`, packagesRoot), 'utf8'),
      ) as Record<string, unknown>;
      for (const key of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const dependencies = manifest[key] as Record<string, string> | undefined;
        for (const dependency of Object.keys(dependencies ?? {})) {
          if (isAgora(dependency)) violations.push(`${name}/package.json ${key}: ${dependency}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('owns its implementations without Agora imports or re-exports', async () => {
    const violations: string[] = [];
    for (const name of await readdir(packagesRoot)) {
      const files = await sourceFiles(new URL(`${name}/src/`, packagesRoot));
      for (const file of files) {
        const source = await readFile(file, 'utf8');
        for (const dependency of importedPackages(source)) {
          if (isAgora(dependency)) violations.push(`${fileURLToPath(file)} imports ${dependency}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
