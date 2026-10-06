/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createTaskPolicy } from '@/agent/policy';
import { createRedactor } from '@/utils/redact';
import { hashString } from '@/utils/hash';
import * as publicApi from '@/index';

function sources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'browser') return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
}

// DOMRoot is the browser adapter for scoped automation roots; the task agent core must not use it.
const domRootAdapter = path.resolve(__dirname, '../src/utils/DOMRoot.ts');
const files = [
  ...sources(path.resolve(__dirname, '../src/agent')),
  ...sources(path.resolve(__dirname, '../src/utils')),
].filter(file => file !== domRootAdapter);
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2020,
  lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
  noResolve: true,
  types: [],
});
const checker = program.getTypeChecker();
const forbidden = new Set([
  'window',
  'document',
  'navigator',
  'location',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'getComputedStyle',
  'localStorage',
  'sessionStorage',
  'requestAnimationFrame',
]);

test.each(files)('%s contains no browser-global references', file => {
  const source = program.getSourceFile(file);
  if (source === undefined) throw new Error('Missing source file');
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && forbidden.has(node.text)) {
      const parent = node.parent;
      const property =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        ((ts.isPropertyAssignment(parent) ||
          ts.isPropertySignature(parent) ||
          ts.isMethodSignature(parent)) &&
          parent.name === node);
      const symbol = checker.getSymbolAtLocation(node);
      const browserGlobal =
        symbol?.declarations?.some(declaration =>
          /lib\.dom\.d\.ts$/.test(declaration.getSourceFile().fileName)
        ) ?? true;
      if (!property && browserGlobal) violations.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(violations).toEqual([]);
});

test('the task agent core never imports the DOM root adapter', () => {
  const importers = files.filter(file =>
    /from\s+['"]@\/utils\/DOMRoot['"]/.test(fs.readFileSync(file, 'utf8'))
  );
  expect(importers).toEqual([]);
});

test('pure paths and package imports work without a browser', () => {
  expect(typeof globalThis.window).toBe('undefined');
  expect(typeof publicApi.createTaskAgent).toBe('function');
  expect(typeof publicApi.installTaskBridge).toBe('function');
  expect(typeof createTaskPolicy().evaluate).toBe('function');
  expect(createRedactor({ secrets: ['private-value'] }).scrub('private-value')).toBe('[REDACTED]');
  expect(hashString('same')).toBe(hashString('same'));
});
