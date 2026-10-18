import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const folder of ['src', 'tools', 'test']) {
  for (const filename of await readdir(`${root}${folder}`)) {
    if (!filename.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', `${root}${folder}/${filename}`], { encoding: 'utf8' });
    if (result.status) { process.stderr.write(result.stderr); process.exit(result.status); }
  }
}
console.log('JavaScript syntax checks passed.');
