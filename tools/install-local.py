"""Install only this extension, preserving existing Spicetify/SpotX assets."""
import argparse
import configparser
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FILENAME = 'jp-original-titles.js'
TAG = '<script defer src="/extensions/jp-original-titles.js" data-jpt-local="true"></script>'


def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def sha(path):
    return digest(path.read_bytes()) if path.exists() else None


def read_target(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError(f'Unsupported installation target: {path}')
    return path.read_bytes() if path.exists() else None


def atomic_write(path, data, mode=0o644, created_directories=None):
    if data is None:
        path.unlink(missing_ok=True)
        return
    missing = []
    parent = path.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    for directory in reversed(missing):
        directory.mkdir()
        if created_directories is not None:
            created_directories.append(directory)
    handle, temporary = tempfile.mkstemp(prefix='.jpt-', dir=path.parent)
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def manifest_write(path, record):
    atomic_write(path, (json.dumps(record, indent=2) + '\n').encode('utf-8'))


def update_config(data):
    text = data.decode('utf-8')
    section = re.search(r'(?m)^[ \t]*\[AdditionalOptions\][ \t]*(?:[#;][^\r\n]*)?(?:\r?\n|$)', text)
    if not section:
        raise ValueError('Spicetify AdditionalOptions section was not found.')
    following = re.search(r'(?m)^[ \t]*\[', text[section.end():])
    end = section.end() + following.start() if following else len(text)
    content = text[section.end():end]
    # INI whitespace here must never include a line break.
    extension = re.search(r'(?m)^([ \t]*extensions[ \t]*=[ \t]*)([^\r\n]*)', content)
    if not extension:
        raise ValueError('Spicetify AdditionalOptions.extensions was not found.')

    def parts(value):
        comment = re.search(r'(?<!\S)[#;]', value)
        body = value[:comment.start()] if comment else value
        core = body.rstrip(' \t')
        return core, value[len(core):]

    def add_extension(match):
        body, suffix = parts(match.group(2))
        if FILENAME in [item.strip() for item in body.split('|')]:
            return match.group(0)
        separator = '|' if body.strip() else ''
        if suffix.startswith(('#', ';')):
            suffix = ' ' + suffix
        return match.group(1) + body + separator + FILENAME + suffix

    content = re.sub(r'(?m)^([ \t]*extensions[ \t]*=[ \t]*)([^\r\n]*)', add_extension, content, count=1)

    def repair_custom_apps(match):
        body, suffix = parts(match.group(2))
        items = body.split('|')
        if not any(item.strip() == FILENAME for item in items):
            return match.group(0)
        return match.group(1) + '|'.join(item for item in items if item.strip() != FILENAME) + suffix

    content = re.sub(r'(?m)^([ \t]*custom_apps[ \t]*=[ \t]*)([^\r\n]*)', repair_custom_apps, content, count=1)
    return (text[:section.end()] + content + text[end:]).encode('utf-8')


def update_html(data):
    text = data.decode('utf-8')
    if TAG in text or re.search(r'<script\b[^>]*\bsrc\s*=\s*["\'](?:/|\./)?extensions/jp-original-titles\.js["\']', text):
        return data
    if '</body>' not in text:
        raise ValueError('Spotify index.html has no body closing tag.')
    newline = '\r\n' if '\r\n' in text else '\n'
    return text.replace('</body>', TAG + newline + '</body>', 1).encode('utf-8')


def planned_file(path, after):
    before = read_target(path)
    mode = stat.S_IMODE(path.stat().st_mode) if before is not None else 0o644
    return {'path': path, 'before': before, 'after': after, 'mode': mode, 'before_mode': mode}


def apply_files(plans, created_directories):
    for plan in plans:
        path = plan['path']
        if sha(path) != digest(plan['before']):
            raise ValueError(f'Refusing to overwrite a concurrent modification: {path}')
        mode_changed = path.exists() and stat.S_IMODE(path.stat().st_mode) != plan['mode']
        if plan['before'] != plan['after'] or mode_changed:
            atomic_write(path, plan['after'], plan['mode'], created_directories)


def rollback_files(plans, created_directories):
    failures = []
    for plan in reversed(plans):
        path = plan['path']
        try:
            current = sha(path)
            if current == digest(plan['before']):
                if path.exists():
                    path.chmod(plan['before_mode'])
                continue
            if current != digest(plan['after']):
                raise ValueError('Target was modified by another process.')
            atomic_write(path, plan['before'], plan['before_mode'])
        except Exception:
            failures.append(str(path))
    for directory in reversed(created_directories):
        try:
            directory.rmdir()
        except OSError:
            pass
    return failures


def restore_snapshot(manifest):
    record = json.loads(manifest.read_bytes().decode('utf-8'))
    plans = []
    for row in record['files']:
        target = Path(row['path'])
        current = read_target(target)
        acceptable = {row['installed_sha256']}
        if record.get('state') in {'prepared', 'rolled_back', 'rollback_incomplete'}:
            acceptable.add(row['before_sha256'])
        if digest(current) not in acceptable:
            raise ValueError(f'Refusing to overwrite a later modification: {target}')
        saved = Path(row['backup']) if row['backup'] else None
        restored = saved.read_bytes() if saved else None
        if digest(restored) != row['before_sha256']:
            raise ValueError(f'The installation backup failed verification: {target}')
        plan = planned_file(target, restored)
        if saved:
            plan['mode'] = stat.S_IMODE(saved.stat().st_mode)
        plans.append(plan)
    created_directories = []
    try:
        apply_files(plans, created_directories)
    except BaseException:
        failures = rollback_files(plans, created_directories)
        if failures:
            raise RuntimeError('Restore rollback was incomplete; retain the snapshot: ' + ', '.join(failures))
        raise
    print('Restored the installation snapshot. No other extension was changed.')


def install(config_path):
    source = ROOT / 'dist' / FILENAME
    if not source.is_file():
        raise ValueError('Run npm run build first.')
    config_path = config_path.expanduser().resolve()
    config_bytes = read_target(config_path)
    if config_bytes is None:
        raise ValueError(f'Spicetify configuration does not exist: {config_path}')
    config = configparser.ConfigParser(interpolation=None)
    config.read_string(config_bytes.decode('utf-8-sig'))
    resources = Path(config.get('Setting', 'spotify_path')).expanduser()
    app = resources / 'Apps' / 'xpui'
    index = app / 'index.html'
    if not index.is_file():
        raise ValueError(f'Unsupported Spotify asset layout: {app}')

    # Validate every payload before the first installed file is changed.
    bundle = source.read_bytes()
    plans = [planned_file(config_path, update_config(config_bytes)),
             planned_file(index, update_html(read_target(index))),
             planned_file(config_path.parent / 'Extensions' / FILENAME, bundle),
             planned_file(app / 'extensions' / FILENAME, bundle)]
    guards = {str(path): sha(path) for path in [app / 'xpui-snapshot.js', app / 'xpui-modules.js']}
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = ROOT / 'local' / ('installation-' + timestamp)
    backup.mkdir(parents=True, exist_ok=False)
    rows = []
    for number, plan in enumerate(plans):
        saved = backup / str(number)
        if plan['before'] is not None:
            atomic_write(saved, plan['before'], plan['mode'])
        rows.append({'path': str(plan['path']), 'backup': str(saved) if plan['before'] is not None else None,
                     'before_sha256': digest(plan['before']), 'installed_sha256': digest(plan['after'])})
    manifest = backup / 'manifest.json'
    record = {'name': 'JP Original Title (Spicetify)', 'channel': 'local-development',
              'state': 'prepared', 'files': rows, 'preserved_assets': guards}
    manifest_write(manifest, record)
    created_directories = []
    try:
        apply_files(plans, created_directories)
        for path, expected in guards.items():
            if sha(Path(path)) != expected:
                raise ValueError(f'Unexpected change to protected asset: {path}')
        record['state'] = 'installed'
        manifest_write(manifest, record)
    except BaseException as error:
        failures = rollback_files(plans, created_directories)
        record['state'] = 'rollback_incomplete' if failures else 'rolled_back'
        record['failure_type'] = type(error).__name__
        record['rollback_failures'] = failures
        try:
            manifest_write(manifest, record)
        except OSError:
            pass
        if failures:
            raise RuntimeError('Installation rollback was incomplete; retain the snapshot: ' + str(manifest)) from error
        raise
    print('Installed local development extension. Reload Spotify to load it.')
    print(f'Restore snapshot: {manifest}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path.home() / '.config/spicetify/config-xpui.ini')
    parser.add_argument('--restore', type=Path)
    args = parser.parse_args()
    try:
        if args.restore:
            restore_snapshot(args.restore)
        else:
            install(args.config)
    except (OSError, ValueError, configparser.Error, RuntimeError) as error:
        raise SystemExit(str(error)) from None


if __name__ == '__main__':
    main()
