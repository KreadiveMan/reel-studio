import {existsSync} from 'node:fs';
import path from 'node:path';

// Windows portable Node keeps npm beside node.exe; POSIX installs keep it under <prefix>/lib.
const nodeDir=path.dirname(process.execPath);
const candidates=[
  path.join(nodeDir,'node_modules','npm','bin','npm-cli.js'),
  path.join(nodeDir,'..','lib','node_modules','npm','bin','npm-cli.js'),
];

export const npmCliPath=path.resolve(candidates.find(file=>existsSync(file))??candidates[0]);

export const resolveNpmCommand=(args=[])=>({
  command:process.execPath,
  args:[npmCliPath,...args],
});
