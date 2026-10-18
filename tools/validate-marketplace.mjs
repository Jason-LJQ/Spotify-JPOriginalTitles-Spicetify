import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(`${root}manifest.json`, 'utf8'));
const { version } = JSON.parse(await readFile(`${root}package.json`, 'utf8'));
for (const key of ['name', 'description', 'main', 'preview', 'readme']) {
  assert.equal(typeof manifest[key], 'string', `Missing Marketplace field: ${key}`);
  assert.ok(manifest[key].trim(), `Empty Marketplace field: ${key}`);
}
assert.equal(manifest.branch, 'main');
for (const key of ['main', 'preview', 'readme']) {
  const path = resolve(root, manifest[key]);
  assert.ok(path.startsWith(root.endsWith(sep) ? root : root + sep), `Path leaves repository: ${key}`);
  assert.ok((await stat(path)).isFile(), `Missing Marketplace asset: ${key}`);
}
assert.ok(manifest.main.endsWith('.js'));
for (const author of manifest.authors) {
  assert.ok(author.name.trim());
  assert.equal(new URL(author.url).protocol, 'https:');
}
assert.ok(manifest.tags.every(tag => typeof tag === 'string'));
const image = await readFile(resolve(root, manifest.preview));
assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Preview must be a PNG');
assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0);
const bundle = await readFile(resolve(root, manifest.main));
new Script(bundle.toString(), { filename: manifest.main });
const build = JSON.parse(await readFile(`${root}dist/build.json`, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(build.version, version);
assert.equal(build.channel, 'release');
assert.equal(build.sha256, sha(bundle));
for (const [name, digest] of Object.entries(build.sources)) {
  assert.equal(sha(await readFile(`${root}src/${name}`)), digest, `Stale bundle source: ${name}`);
}
assert.ok(bundle.toString().includes(`v${version}`));
console.log(`Marketplace manifest, preview and bundled v${version} assets are valid.`);
