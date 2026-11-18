"""Exercise resuming, checksums and exclusive writes without external network access."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.machinery import SourceFileLoader
from pathlib import Path
import hashlib
import tempfile
import threading

module = SourceFileLoader('asset_downloader', str(Path(__file__).with_name('download-separation-assets.py'))).load_module()
data = b'shiyin download check' * 2000
checksum = hashlib.sha256(data).hexdigest()

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/ignore':
            self.send_response(200)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        requested = self.headers.get('Range')
        start, finish = (requested or 'bytes=0-').split('=')[1].split('-')
        offset, end = int(start), int(finish) if finish else len(data)-1
        self.send_response(206 if requested else 200)
        self.send_header('Content-Length', str(end - offset + 1))
        if requested:
            self.send_header('Content-Range', f'bytes {offset}-{end}/{len(data)}')
        self.end_headers()
        self.wfile.write(data[offset:end+1])
    def log_message(self, *_): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix='shiyin-asset-test-') as tmp:
        root = Path(tmp)
        url = f'http://127.0.0.1:{server.server_port}/asset'
        (root / 'sample.part').write_bytes(data[:1000])
        module.acquire(root, 'sample', url, checksum)
        assert (root / 'sample').read_bytes() == data
        assert not (root / 'sample.part').exists()
        (root / 'already.part').write_bytes(data)
        module.acquire(root, 'already', url, checksum)
        assert (root / 'already').read_bytes() == data
        module.acquire(root, 'sample', url, checksum)
        try:
            module.acquire(root, 'sample', url, '0' * 64)
            raise AssertionError('existing mismatched file was accepted')
        except RuntimeError: pass
        try:
            module.acquire(root, 'bad', url, '0' * 64)
            raise AssertionError('bad checksum was accepted')
        except RuntimeError: pass
        assert not (root / 'bad').exists()
        assert (root / 'bad.part').exists()
        parts = root / 'segmented.parts'
        parts.mkdir()
        (parts / '0').write_bytes(data[:100])
        module._segments(root, 'segmented', [url], len(data), checksum, count=4)
        assert (root / 'segmented').read_bytes() == data
        assert not parts.exists()
        try:
            module._segments(root, 'unsupported', [url.replace('/asset', '/ignore')], len(data), checksum, count=1)
            raise AssertionError('server ignoring range was accepted')
        except RuntimeError: pass
        assert not (root / 'unsupported').exists()
        print('PASS resumed and segmented downloads, hash validation and no overwrite')
finally:
    server.shutdown()
    thread.join()
    server.server_close()
