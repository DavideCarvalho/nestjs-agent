#!/usr/bin/env node
// Loads every entry this package publishes, both formats, in a process with NO global `React`, and
// renders the providers and components. A build that compiles JSX to `React.createElement` in a
// module that never imports React passes every source-level test and then dies in the consumer's
// browser with `ReferenceError: React is not defined`; this is the check that catches it, because
// it runs the files people actually install.
//
//   pnpm --filter @dudousxd/nestjs-agent-react build && node packages/react/scripts/verify-dist.mjs
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, register } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
const require = createRequire(resolve(packageDir, 'package.json'));

if ('React' in globalThis) {
  throw new Error('verify-dist must run without a global React — something defined one');
}

// The markdown entry imports stylesheets, which a bundler handles and Node does not.
register(
  `data:text/javascript,${encodeURIComponent(
    "export async function load(url, context, next) { return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context); }",
  )}`,
  import.meta.url,
);
require.extensions['.css'] = () => undefined;

// `@streamdown/*` ship ESM only, so the CommonJS markdown entry cannot be `require`d by Node itself
// (a bundler resolves it). It is still scanned statically by scripts/check-dist-react.mjs.
const NOT_REQUIRABLE = new Set(['./markdown']);

const failures = [];
const checks = [];
function check(name, run) {
  checks.push(name);
  try {
    run();
  } catch (error) {
    failures.push(
      `${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
  }
}

const Card = ({ title, children }, h) => h('section', { 'data-title': title }, children);

/** Render everything a consumer mounts from these entries, with the React that `load` resolves. */
function mount(format, entries, React, renderToStaticMarkup) {
  const h = React.createElement;
  const registry = { Card: (props) => Card(props, h) };
  const uiPart = {
    kind: 'ui',
    key: 'k1',
    id: 'ui-1',
    component: 'Card',
    props: { title: 'Hi' },
    version: null,
    toolCallId: null,
  };
  const messages = [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hi there' }] },
  ];
  const root = entries['.'];
  const genui = entries['./genui'];
  const jsonRender = entries['./genui/json-render'];
  const markdown = entries['./markdown'];

  check(`${format} . <AgentProvider>`, () => {
    const html = renderToStaticMarkup(
      h(root.AgentProvider, { baseUrl: 'http://localhost' }, h('p', null, 'child')),
    );
    if (!html.includes('child')) throw new Error(`children were not rendered: ${html}`);
  });
  check(`${format} . <AgentProvider genui>`, () => {
    const html = renderToStaticMarkup(
      h(
        root.AgentProvider,
        { baseUrl: 'http://localhost', genui: { registry } },
        h(genui.GenerativeUI, { part: uiPart }),
      ),
    );
    if (!html.includes('data-title="Hi"'))
      throw new Error(`the component was not rendered: ${html}`);
  });
  check(`${format} . <MessageList>`, () => {
    const html = renderToStaticMarkup(h(root.MessageList, { messages, status: 'ready' }));
    if (!html.includes('hi there')) throw new Error(`messages were not rendered: ${html}`);
  });
  check(`${format} . <MessageItem>`, () => {
    const html = renderToStaticMarkup(h(root.MessageItem, { message: messages[1] }));
    if (!html.includes('hi there')) throw new Error(`the message was not rendered: ${html}`);
  });
  check(`${format} . <ChatInput>`, () => {
    const html = renderToStaticMarkup(h(root.ChatInput, { onSubmit: () => undefined }));
    if (!html.includes('<textarea')) throw new Error(`the composer was not rendered: ${html}`);
  });
  check(`${format} ./genui <GenuiProvider> + <GenerativeUI>`, () => {
    const html = renderToStaticMarkup(
      h(genui.GenuiProvider, { registry }, h(genui.GenerativeUI, { part: uiPart })),
    );
    if (!html.includes('data-title="Hi"'))
      throw new Error(`the component was not rendered: ${html}`);
  });
  check(`${format} ./genui <GenuiTree>`, () => {
    const tree = {
      type: 'Card',
      props: { title: 'Root' },
      children: [{ type: 'Card', props: { title: 'Leaf' } }],
    };
    const html = renderToStaticMarkup(
      h(genui.GenerativeUIScope, { registry }, h(genui.GenuiTree, { root: tree })),
    );
    if (!html.includes('data-title="Leaf"')) throw new Error(`the tree was not rendered: ${html}`);
  });
  check(`${format} ./genui/json-render <GenuiProvider jsonRender>`, () => {
    const html = renderToStaticMarkup(
      h(
        jsonRender.GenuiProvider,
        { registry, jsonRender: true },
        h(genui.GenerativeUI, { part: uiPart }),
      ),
    );
    if (!html.includes('data-title="Hi"'))
      throw new Error(`the component was not rendered: ${html}`);
  });
  check(`${format} ./genui/json-render <JsonRenderTree>`, () => {
    const html = renderToStaticMarkup(
      h(jsonRender.JsonRenderTree, {
        registry: jsonRender.toJsonRenderRegistry(registry),
        root: { type: 'Card', props: { title: 'Json' } },
      }),
    );
    if (!html.includes('data-title="Json"')) throw new Error(`the tree was not rendered: ${html}`);
  });
  if (markdown === undefined) return;
  check(`${format} ./markdown <AgentMarkdown>`, () => {
    const html = renderToStaticMarkup(h(markdown.AgentMarkdown, null, '**bold**'));
    if (!html.includes('bold')) throw new Error(`markdown was not rendered: ${html}`);
  });
}

const targets = Object.entries(manifest.exports).map(([subpath, conditions]) => ({
  subpath,
  esm: resolve(packageDir, conditions.import.default),
  cjs: resolve(packageDir, conditions.require.default),
}));

const missing = targets.flatMap(({ esm, cjs }) => [esm, cjs]).filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error(`verify-dist: not built — missing ${missing.join(', ')}`);
  process.exit(1);
}

const esmEntries = {};
const cjsEntries = {};
for (const { subpath, esm, cjs } of targets) {
  try {
    esmEntries[subpath] = await import(pathToFileURL(esm).href);
    checks.push(`esm ${subpath} loads`);
  } catch (error) {
    failures.push(
      `esm ${subpath} failed to load: ${error instanceof Error ? error.stack : String(error)}`,
    );
  }
  if (NOT_REQUIRABLE.has(subpath)) continue;
  try {
    cjsEntries[subpath] = require(cjs);
    checks.push(`cjs ${subpath} loads`);
  } catch (error) {
    failures.push(
      `cjs ${subpath} failed to load: ${error instanceof Error ? error.stack : String(error)}`,
    );
  }
}

{
  const esmReact = await import(pathToFileURL(require.resolve('react')).href);
  const esmServer = await import(pathToFileURL(require.resolve('react-dom/server')).href);
  mount(
    'esm',
    esmEntries,
    esmReact.default ?? esmReact,
    (esmServer.default ?? esmServer).renderToStaticMarkup,
  );
  mount('cjs', cjsEntries, require('react'), require('react-dom/server').renderToStaticMarkup);
}

if ('React' in globalThis) {
  failures.push('a dist entry defined a global React');
}

if (failures.length > 0) {
  console.error(`verify-dist: ${failures.length} of ${checks.length} checks failed\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}
console.log(`verify-dist: ${checks.length} checks passed with no global React`);
