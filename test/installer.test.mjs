import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FILENAME = 'jp-original-titles.js';
const source = new URL('../tools/install-local.py', import.meta.url);
const bundle = Buffer.from('globalThis.installerFixture = true;\n');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jpt-installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const resources = path.join(root, 'Spotify.app', 'Contents', 'Resources');
  const app = path.join(resources, 'Apps', 'xpui');
  const config = path.join(root, 'config', 'config-xpui.ini');
  const script = path.join(project, 'tools', 'install-local.py');
  for (const directory of [path.dirname(script), path.join(project, 'dist'), app, path.dirname(config)]) fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(source, script);
  fs.writeFileSync(path.join(project, 'dist', FILENAME), bundle);
  const text = options.config?.(resources) ?? `[Setting]\nspotify_path = ${resources}\n\n[AdditionalOptions]\nextensions = \ncustom_apps = marketplace\nother = unchanged\n\n[Patch]\npart = keep\n`;
  fs.writeFileSync(config, text);
  fs.writeFileSync(path.join(app, 'index.html'), options.html ?? '<!DOCTYPE html>\n<body><script src="/xpui-snapshot.js"></script>\n</body>\n');
  fs.writeFileSync(path.join(app, 'xpui-snapshot.js'), 'protected Spotify snapshot\n');
  fs.writeFileSync(path.join(app, 'xpui-modules.js'), 'protected Spotify modules\n');
  const targets = [config, path.join(app, 'index.html'), path.join(path.dirname(config), 'Extensions', FILENAME), path.join(app, 'extensions', FILENAME)];
  if (options.existing) for (const target of targets.slice(2)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'previous local bundle\n');
  }
  const capture = () => targets.map(target => fs.existsSync(target) ? fs.readFileSync(target) : null);
  const initial = capture();
  const guards = [path.join(app, 'xpui-snapshot.js'), path.join(app, 'xpui-modules.js')];
  const guardBytes = guards.map(target => fs.readFileSync(target));
  const assertGuards = () => guards.forEach((target, index) => assert.deepEqual(fs.readFileSync(target), guardBytes[index]));
  function run(args = [], inject = '') {
    const prelude = `import importlib.util,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('jpt_installer',sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nsys.argv=sys.argv[1:]\n`;
    const result = inject ? spawnSync('python3', ['-c', prelude + inject + '\nm.main()\n', script, ...args], { encoding: 'utf8' })
      : spawnSync('python3', [script, ...args], { encoding: 'utf8' });
    if (result.error) throw result.error;
    return result;
  }
  const install = inject => run(['--config', config], inject);
  const snapshots = () => fs.existsSync(path.join(project, 'local')) ? fs.readdirSync(path.join(project, 'local')).sort().map(name => path.join(project, 'local', name, 'manifest.json')) : [];
  return { root, project, app, config, script, targets, initial, capture, install, run, snapshots, text, assertGuards };
}

test('real installer keeps custom_apps on its own line when extensions is empty', t => {
  const f = fixture(t);
  const result = f.install();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.config, 'utf8'), f.text.replace('extensions = \n', `extensions = ${FILENAME}\n`));
  for (const target of f.targets.slice(2)) assert.deepEqual(fs.readFileSync(target), bundle);
  const record = JSON.parse(fs.readFileSync(f.snapshots()[0]));
  assert.equal(record.state, 'installed'); assert.equal(record.files.length, 4);
  f.assertGuards();
});

test('migration removes only its exact filename from custom_apps and preserves CRLF and other bytes', t => {
  const f = fixture(t, { config: resources => `; untouched\r\n[Setting]\r\nspotify_path = ${resources}\r\n\r\n[AdditionalOptions]\r\nextensions\t=\t\r\ncustom_apps = marketplace | ${FILENAME} | other-app\t\r\ninject_css = 0\r\n\r\n[Patch]\r\nextensions = unrelated.js` });
  assert.equal(f.install().status, 0);
  const expected = f.text.replace('extensions\t=\t\r\n', `extensions\t=\t${FILENAME}\r\n`).replace(`marketplace | ${FILENAME} | other-app`, 'marketplace | other-app');
  assert.deepEqual(fs.readFileSync(f.config), Buffer.from(expected));
  f.assertGuards();
});

test('installer preserves unrelated extension formatting and is idempotent', t => {
  const f = fixture(t, { config: resources => `[Setting]\nspotify_path=${resources}\n[AdditionalOptions]\nextensions = first.js | second.js  \ncustom_apps = marketplace|other\n` });
  assert.equal(f.install().status, 0);
  assert.equal(fs.readFileSync(f.config, 'utf8'), f.text.replace('second.js  ', `second.js|${FILENAME}  `));
  const installed = f.capture();
  assert.equal(f.install().status, 0);
  assert.deepEqual(f.capture(), installed);
  assert.equal(f.snapshots().length, 2);
  assert.equal(fs.readFileSync(f.targets[1], 'utf8').split('data-jpt-local="true"').length - 1, 1);
});

test('migration preserves similar app filenames and same-name values in other sections', t => {
  const f = fixture(t, { config: resources => `[Setting]\nspotify_path=${resources}\n[AdditionalOptions]\nextensions = \ncustom_apps = marketplace|folder/${FILENAME}|${FILENAME}.backup|${FILENAME}\n[Other]\ncustom_apps = ${FILENAME}\n` });
  assert.equal(f.install().status, 0);
  const expected = f.text.replace('extensions = \n', `extensions = ${FILENAME}\n`).replace(`|${FILENAME}\n[Other]`, '\n[Other]');
  assert.equal(fs.readFileSync(f.config, 'utf8'), expected);
});

test('extension and custom-app inline comments are retained', t => {
  const f = fixture(t, { config: resources => `[Setting]\nspotify_path=${resources}\n[AdditionalOptions]\nextensions = alpha.js  # keep\ncustom_apps = marketplace|${FILENAME}  ; keep too\n` });
  assert.equal(f.install().status, 0);
  assert.equal(fs.readFileSync(f.config, 'utf8'), f.text.replace('alpha.js  #', `alpha.js|${FILENAME}  #`).replace(`|${FILENAME}  ;`, '  ;'));
});

test('pre-existing Spicetify script tag prevents duplicate local script insertion', t => {
  const html = `<body>\n<script defer src='extensions/${FILENAME}'></script>\n</body>`;
  const f = fixture(t, { html });
  assert.equal(f.install().status, 0);
  assert.equal(fs.readFileSync(f.targets[1], 'utf8'), html);
});

test('invalid configuration fails before modifying any installed target', t => {
  const f = fixture(t, { existing: true, config: resources => `[Setting]\nspotify_path=${resources}\n[AdditionalOptions]\ncustom_apps=marketplace\n` });
  const result = f.install();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /extensions was not found/);
  assert.deepEqual(f.capture(), f.initial); assert.deepEqual(f.snapshots(), []); f.assertGuards();
});

test('invalid HTML fails before modifying installed bundles or configuration', t => {
  const f = fixture(t, { existing: true, html: '<html><body>missing closing tag' });
  const result = f.install();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /no body closing tag/);
  assert.deepEqual(f.capture(), f.initial); assert.deepEqual(f.snapshots(), []); f.assertGuards();
});

function failReplaceAt(target) {
  return `real_replace=m.os.replace\nfailed=False\ndef replace(source,target):\n global failed\n if Path(target)==Path(${JSON.stringify(target)}) and not failed:\n  failed=True\n  raise PermissionError('injected target failure')\n return real_replace(source,target)\nm.os.replace=replace\n`;
}

test('a fourth-target write failure rolls back all previously changed existing files', t => {
  const f = fixture(t, { existing: true });
  fs.chmodSync(f.config, 0o600);
  const result = f.install(failReplaceAt(f.targets[3]));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /injected target failure/);
  assert.deepEqual(f.capture(), f.initial); f.assertGuards();
  assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
  const record = JSON.parse(fs.readFileSync(f.snapshots()[0]));
  assert.equal(record.state, 'rolled_back'); assert.deepEqual(record.rollback_failures, []);
  assert.ok(fs.readdirSync(path.dirname(f.targets[3])).every(name => !name.startsWith('.jpt-')));
});

test('failed first installation removes its new bundle and only its empty created directories', t => {
  const f = fixture(t);
  assert.notEqual(f.install(failReplaceAt(f.targets[3])).status, 0);
  assert.deepEqual(f.capture(), f.initial); f.assertGuards();
  assert.equal(fs.existsSync(path.dirname(f.targets[2])), false);
  assert.equal(fs.existsSync(path.dirname(f.targets[3])), false);
});

test('failure to commit the final installation manifest rolls back the installed files', t => {
  const f = fixture(t, { existing: true });
  const inject = `real_write=m.manifest_write\ndef manifest_write(target,record):\n if record.get('state')=='installed':\n  raise OSError('injected manifest failure')\n return real_write(target,record)\nm.manifest_write=manifest_write\n`;
  assert.notEqual(f.install(inject).status, 0);
  assert.deepEqual(f.capture(), f.initial); f.assertGuards();
  assert.equal(JSON.parse(fs.readFileSync(f.snapshots()[0])).state, 'rolled_back');
});

test('restore round trip verifies backups and restores both prior bundles and new-file absence', t => {
  for (const existing of [false, true]) {
    const f = fixture(t, { existing });
    fs.chmodSync(f.config, 0o600);
    assert.equal(f.install().status, 0);
    const result = f.run(['--restore', f.snapshots()[0]]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.capture(), f.initial); f.assertGuards();
    assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
  }
});

test('restore preflight refuses later edits without restoring any other target', t => {
  const f = fixture(t, { existing: true }); assert.equal(f.install().status, 0);
  fs.appendFileSync(f.targets[3], '// later edit\n');
  const before = f.capture();
  const result = f.run(['--restore', f.snapshots()[0]]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /later modification/);
  assert.deepEqual(f.capture(), before); f.assertGuards();
});

test('restore preflight rejects a corrupt snapshot before touching any installed file', t => {
  const f = fixture(t, { existing: true }); assert.equal(f.install().status, 0);
  const manifest = f.snapshots()[0];
  const record = JSON.parse(fs.readFileSync(manifest));
  fs.writeFileSync(record.files[1].backup, 'corrupted');
  const installed = f.capture();
  const result = f.run(['--restore', manifest]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /backup failed verification/);
  assert.deepEqual(f.capture(), installed); f.assertGuards();
});

test('restore failure rolls already-restored files back to their installed state', t => {
  const f = fixture(t, { existing: true }); assert.equal(f.install().status, 0);
  const installed = f.capture();
  const result = f.run(['--restore', f.snapshots()[0]], failReplaceAt(f.targets[1]));
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.capture(), installed); f.assertGuards();
});

test('a prepared snapshot can recover an externally terminated partial installation', t => {
  const f = fixture(t, { existing: true });
  const inject = `real_replace=m.os.replace\ndef replace(source,target):\n if Path(target)==Path(${JSON.stringify(f.targets[3])}):\n  m.os._exit(23)\n return real_replace(source,target)\nm.os.replace=replace\n`;
  const interrupted = f.install(inject);
  assert.equal(interrupted.status, 23);
  const manifest = f.snapshots()[0];
  assert.equal(JSON.parse(fs.readFileSync(manifest)).state, 'prepared');
  assert.notDeepEqual(f.capture(), f.initial);
  const restore = f.run(['--restore', manifest]);
  assert.equal(restore.status, 0, restore.stderr);
  assert.deepEqual(f.capture(), f.initial); f.assertGuards();
});

test('commented section headers and an empty extension inline comment retain other fields', t => {
  const f = fixture(t, { config: resources => `[Setting]\nspotify_path=${resources}\n[AdditionalOptions] # retain header\nextensions =  # retain empty comment\ncustom_apps = marketplace\n` });
  const result = f.install();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.config, 'utf8'), f.text.replace('extensions =  #', `extensions =  ${FILENAME} #`));
});
