/** @jest-environment node */
import * as publicApi from '@/index';
import * as agentApi from '@/agent';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const names = [
  'createTaskAgent',
  'createRemoteTaskHost',
  'createAutomationTaskHost',
  'installTaskBridge',
  'createTypeSafeTaskDecider',
  'createTaskPolicy',
  'createRedactor',
  'redactEnvelope',
  'toResearchResult',
  'createResearchRequest',
] as const;

test.each(names)('public function %s is exported through both barrels', name => {
  expect(typeof publicApi[name]).toBe('function');
  expect(publicApi[name]).toBe(agentApi[name]);
});

test('public exports have no duplicate names', () => {
  const file = path.resolve(__dirname, '../src/index.ts');
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2020,
    true
  );
  const exported: string[] = [];
  source.forEachChild(node => {
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause)
    ) {
      node.exportClause.elements.forEach(element => exported.push(element.name.text));
    }
  });
  expect(exported.length).toBe(new Set(exported).size);
});

test('legacy engine factory retains its public surface in plain Node', () => {
  const engine = publicApi.createAutomationEngine();
  expect(typeof engine.executeAction).toBe('function');
  expect(typeof engine.registerForm).toBe('function');
  expect(typeof publicApi.ResearchGuide).toBe('function');
  expect(typeof publicApi.createClickGuide).toBe('function');
  engine.dispose();
});
