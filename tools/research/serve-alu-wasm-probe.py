#!/usr/bin/env python3
"""Serve a disposable browser experiment with pinned Icarus/WASM artifacts."""
import argparse
import hashlib
import importlib.util
import json
import shutil
import tempfile
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

COMMIT = 'dc391801af44ec8e99fcdc12c12a3d9a47a5758b'
HASHES = {
    'ivlpp.js': '97d41e9cd11588b7bdbc952873cd71658165e6bd7938c5d39275cedb9ddad405',
    'ivlpp.wasm': '039bfd9a34d5fb527f1309a680a8361c259bd4d6d4d1e6e91020e28da39487c0',
    'ivl.js': 'a2f56ba8611135d43971053605fb013550dc30d1671e9808a7f82ab02838e915',
    'ivl.wasm': '8e909e2d9c7e7ee7a59c25694fa923eae3d60b78993b6e42cc2f53701dc42cea',
    'vvp.js': '7bb3762198fb5297726bdd0714b4bcc2ac09d99122deefba544d45c6beaebb05',
    'vvp.wasm': 'c38bf14a399b66a226fecc90285f35f465eeb759bf37aee59f6aed9cb7e948bd',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--assets', type=Path, help='Optional previously downloaded artifacts; hashes are still checked')
    parser.add_argument('--port', type=int, default=8754)
    args = parser.parse_args()
    output = args.output.resolve()
    scripts = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location('native_probe', scripts / 'probe-alu-iverilog.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    with tempfile.TemporaryDirectory(prefix='xunjie-wasm-serve-') as temporary:
        root = Path(temporary)
        manifest = []
        for name, expected in HASHES.items():
            if args.assets:
                data = (args.assets / name).read_bytes()
            else:
                url = f'https://raw.githubusercontent.com/senolgulgonul/verisim/{COMMIT}/{name}'
                with urllib.request.urlopen(url, timeout=40) as response:
                    data = response.read()
            assert hashlib.sha256(data).hexdigest() == expected, name
            (root / name).write_bytes(data)
            manifest.append({'file': name, 'bytes': len(data), 'sha256': expected})
        fixtures = {'dut': native.DUT, 'testbench': native.TESTBENCH}
        (root / 'fixture.json').write_text(json.dumps(fixtures))
        shutil.copyfile(scripts / 'alu-wasm-probe.html', root / 'index.html')

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *values, **kwargs):
                super().__init__(*values, directory=str(root), **kwargs)

            def log_message(self, *values):
                pass

            def do_GET(self):
                if self.path == '/':
                    shutil.copyfile(scripts / 'alu-wasm-probe.html', root / 'index.html')
                super().do_GET()

            def do_POST(self):
                size = int(self.headers.get('Content-Length', '0'))
                if self.path != '/result' or not 0 < size < 65536:
                    self.send_error(400)
                    return
                report = json.loads(self.rfile.read(size))
                report.update({'upstream_commit': COMMIT, 'artifacts': manifest,
                               'fixture_sha256': hashlib.sha256(json.dumps(fixtures).encode()).hexdigest()})
                output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'saved')
                print(f'Report saved: {output}', flush=True)

        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
        print(f'Open http://127.0.0.1:{args.port}/ ; Ctrl-C cleans the temporary files.', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == '__main__':
    main()
