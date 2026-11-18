"""Check archive integrity and extraction safety using synthetic archives."""
from importlib.machinery import SourceFileLoader
from pathlib import Path
import hashlib
import io
import tarfile
import tempfile

extractor = SourceFileLoader('extractor', str(Path(__file__).with_name('extract-separation-python.py'))).load_module()

def archive_at(path, name):
    with tarfile.open(path, 'w:gz') as tar:
        info = tarfile.TarInfo(name)
        data = b'test executable'
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    return hashlib.sha256(path.read_bytes()).hexdigest()

with tempfile.TemporaryDirectory(prefix='shiyin-extract-test-') as tmp:
    root = Path(tmp)
    good = root / 'good.tar.gz'
    checksum = archive_at(good, 'python/bin/python3')
    try:
        extractor.extract_verified(good, root / 'wrong-hash', '0' * 64)
        raise AssertionError('bad checksum was accepted')
    except ValueError: pass
    assert not (root / 'wrong-hash').exists()
    extractor.extract_verified(good, root / 'output', checksum)
    try:
        extractor.extract_verified(good, root / 'output', checksum)
        raise AssertionError('existing directory was overwritten')
    except FileExistsError: pass
    bad = root / 'bad.tar.gz'
    bad_hash = archive_at(bad, 'python/../../escaped')
    try:
        extractor.extract_verified(bad, root / 'bad-output', bad_hash)
        raise AssertionError('path traversal was accepted')
    except (ValueError, tarfile.TarError): pass
    assert not (root / 'escaped').exists()
    assert not (root / 'bad-output').exists()
    print('PASS verified extraction, traversal rejection and no overwrite')
