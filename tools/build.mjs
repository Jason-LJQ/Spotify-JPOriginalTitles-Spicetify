import { build } from 'esbuild';
import { readFile, readdir, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
const sourceNames = (await readdir(`${root}src`)).filter(name => name.endsWith('.mjs')).sort();
const sources = await Promise.all(sourceNames.map(name => readFile(`${root}src/${name}`)));
const hash = createHash('sha256');
hash.update(version).update('\0');
sourceNames.forEach((name, i) => hash.update(name).update('\0').update(sources[i]).update('\0'));
const buildID = hash.digest('hex').slice(0, 12);
await mkdir(`${root}dist`, { recursive: true });
await build({ entryPoints: [`${root}src/index.mjs`], bundle: true,
  outfile: `${root}dist/.jp-original-titles.js.building`, format: 'iife', target: ['chrome120'],
  sourcemap: false, minify: false, legalComments: 'none',
  define: { __JPT_BUILD__: JSON.stringify(buildID), __JPT_VERSION__: JSON.stringify(version) },
  banner: { js: `// JP Original Title (Spicetify) v${version}` }
});
for (let i = 0; i < sourceNames.length; i++) {
  if (!(await readFile(`${root}src/${sourceNames[i]}`)).equals(sources[i])) {
    await unlink(`${root}dist/.jp-original-titles.js.building`);
    throw new Error('Sources changed during compilation; rebuild the local extension.');
  }
}
await rename(`${root}dist/.jp-original-titles.js.building`, `${root}dist/jp-original-titles.js`);
const output = await readFile(`${root}dist/jp-original-titles.js`);
await writeFile(`${root}dist/build.json`, JSON.stringify({ name: 'JP Original Title (Spicetify)',
  channel: 'release', version, buildID, iosBaseline: 'v7.0.2',
  sha256: createHash('sha256').update(output).digest('hex'), bytes: output.length,
  sources: Object.fromEntries(sourceNames.map((name, i) => [name, createHash('sha256').update(sources[i]).digest('hex')])) }, null, 2) + '\n');
console.log(`Built extension v${version}, ${buildID} (${output.length} bytes).`);
