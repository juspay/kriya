import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Accept regular-file CLI candidates; treat filesystem metadata errors as an unavailable candidate. */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Select npm's CLI for shell-free Node execution, with POSIX fallback or Windows guidance. */
export function npmCommand(
  args,
  {
    platform = process.platform,
    execPath = process.execPath,
    npmExecPath = process.env.npm_execpath,
    fileExists = isFile,
  } = {}
) {
  const path = platform === 'win32' ? win32 : posix;
  const candidates = [
    npmExecPath,
    path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find(
    candidate =>
      typeof candidate === 'string' &&
      path.isAbsolute(candidate) &&
      path.basename(candidate).toLowerCase() === 'npm-cli.js' &&
      fileExists(candidate)
  );
  if (cli) {
    return { file: execPath, args: [cli, ...args] };
  }
  if (platform === 'win32') {
    throw new Error(
      'Cannot locate npm-cli.js. Run "npm run verify:package" so npm supplies npm_execpath, or install npm beside Node in node_modules/npm/bin/npm-cli.js.'
    );
  }
  return { file: 'npm', args: [...args] };
}
