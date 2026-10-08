/** @jest-environment node */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

type ReleaseContext = {
  cwd: string;
  logger: { log: jest.Mock; error: jest.Mock };
  nextRelease: { notes: string };
};

type PreparePlugin = {
  prepare: (config: Record<string, unknown>, context: ReleaseContext) => Promise<void>;
};

type ReleasePlugin = string | [string, Record<string, unknown>];

const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE_ROOT =
  process.env.KRIYA_RELEASE_FORMAT_FIXTURE_ROOT ?? join(tmpdir(), 'kriya-release-format-fixtures');
const FORMAT_PLUGIN = './scripts/semantic-release-format-plugin.cjs';
const loadPlugin = createRequire(join(REPO_ROOT, 'package.json'));
const formatPlugin = loadPlugin(join(REPO_ROOT, FORMAT_PLUGIN)) as PreparePlugin;
const changelogPlugin = loadPlugin('@semantic-release/changelog') as PreparePlugin;
const prettierCli = require.resolve('prettier/bin/prettier.cjs');
const releaseConfig = JSON.parse(readFileSync(join(REPO_ROOT, '.releaserc.json'), 'utf8')) as {
  plugins: ReleasePlugin[];
};

describe('release changelog formatting', () => {
  let fixture: string;
  let context: ReleaseContext;

  beforeEach(() => {
    mkdirSync(FIXTURE_ROOT, { recursive: true });
    fixture = mkdtempSync(join(FIXTURE_ROOT, 'release with spaces-'));
    writeFileSync(join(fixture, '.prettierrc'), readFileSync(join(REPO_ROOT, '.prettierrc')));
    context = {
      cwd: fixture,
      logger: { log: jest.fn(), error: jest.fn() },
      nextRelease: {
        notes: '# 2.2.0\n\n### Features\n\n*   regenerated   notes\n',
      },
    };
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  test('formats actual regenerated notes in configured prepare order before the Git stage', async () => {
    const names = releaseConfig.plugins.map(plugin =>
      typeof plugin === 'string' ? plugin : plugin[0]
    );
    expect(names.indexOf(FORMAT_PLUGIN)).toBe(names.indexOf('@semantic-release/changelog') + 1);
    expect(names.indexOf(FORMAT_PLUGIN)).toBeLessThan(names.indexOf('@semantic-release/git'));

    const changelogPath = join(fixture, 'CHANGELOG.md');
    const previousNotes = '# 2.1.0\n\n- Earlier release\n';
    writeFileSync(changelogPath, previousNotes);
    let observedGitStage = false;

    for (const plugin of releaseConfig.plugins) {
      const [name, config] = typeof plugin === 'string' ? [plugin, {}] : plugin;
      if (name === '@semantic-release/changelog') {
        await changelogPlugin.prepare(config, context);
        expect(readFileSync(changelogPath, 'utf8')).toContain('*   regenerated   notes');
      } else if (name === FORMAT_PLUGIN) {
        await formatPlugin.prepare(config, context);
      } else if (name === '@semantic-release/git') {
        expect(config.assets).toContain('CHANGELOG.md');
        expect(readFileSync(changelogPath, 'utf8')).toBe(
          '# 2.2.0\n\n### Features\n\n- regenerated notes\n\n# 2.1.0\n\n- Earlier release\n'
        );
        expect(() =>
          execFileSync(process.execPath, [prettierCli, '--check', changelogPath], {
            cwd: fixture,
            stdio: 'pipe',
          })
        ).not.toThrow();
        observedGitStage = true;
      }
    }
    expect(observedGitStage).toBe(true);
    expect(context.logger.error).not.toHaveBeenCalled();
  });

  test('formatting is idempotent in context.cwd, independently of process.cwd', async () => {
    expect(context.cwd).not.toBe(process.cwd());
    const changelogPath = join(fixture, 'CHANGELOG.md');
    writeFileSync(changelogPath, context.nextRelease.notes);
    await formatPlugin.prepare({}, context);
    const firstPass = readFileSync(changelogPath);
    expect(firstPass.toString()).toBe('# 2.2.0\n\n### Features\n\n- regenerated notes\n');
    await formatPlugin.prepare({}, context);
    expect(readFileSync(changelogPath)).toEqual(firstPass);
  });

  test('missing changelog skips formatting without creating a file', async () => {
    writeFileSync(join(fixture, '.prettierrc'), '{invalid config');
    await expect(formatPlugin.prepare({}, context)).resolves.toBeUndefined();
    expect(existsSync(join(fixture, 'CHANGELOG.md'))).toBe(false);
    expect(context.logger.log).toHaveBeenCalledWith(expect.stringContaining('not found'));
    expect(context.logger.error).not.toHaveBeenCalled();
  });

  test('real formatter failure rejects prepare and prevents the next prepare stage', async () => {
    const changelogPath = join(fixture, 'CHANGELOG.md');
    writeFileSync(changelogPath, context.nextRelease.notes);
    writeFileSync(join(fixture, '.prettierrc'), '{invalid config');
    const gitStage = jest.fn();

    await expect(formatPlugin.prepare({}, context).then(gitStage)).rejects.toThrow(
      'Command failed'
    );

    expect(gitStage).not.toHaveBeenCalled();
    expect(context.logger.error).toHaveBeenCalledTimes(1);
    expect(readFileSync(changelogPath, 'utf8')).toBe(context.nextRelease.notes);
    expect(context.logger.log).not.toHaveBeenCalledWith(expect.stringContaining('successfully'));
  });
});
