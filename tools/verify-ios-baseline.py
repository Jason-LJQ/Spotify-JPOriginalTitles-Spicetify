"""Compare the optional development iOS checkout with the recorded source baseline."""
import argparse
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('ios', type=Path, nargs='?', default=root.parent / 'ios')
args = parser.parse_args()
baseline = json.loads((root / 'ios-baseline.json').read_text())
different = []
for filename, digest in baseline['sha256'].items():
    source = args.ios / filename
    current = hashlib.sha256(source.read_bytes()).hexdigest() if source.exists() else None
    if current != digest:
        different.append(filename)
if different:
    raise SystemExit('iOS baseline changed; review and rerun parity fixtures: ' + ', '.join(different))
print('The optional iOS source checkout matches the recorded baseline. This does not replace behavior tests.')
