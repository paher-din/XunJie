#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path
import sys

lock = json.loads(Path(__file__).with_name('toolchain.lock.json').read_text())
sdk = Path(sys.argv[1])
for file, expected in lock['emsdk']['linuxX64Tools'].items():
    actual = hashlib.sha256((sdk / file).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f'SDK binary digest mismatch: {file}')
print('SDK compiler, optimizer and build Node digests match the fixed Linux x64 toolchain')
