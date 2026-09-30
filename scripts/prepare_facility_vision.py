"""Vendor official PDF/OCR browser distributions; never run downloaded installers."""
from pathlib import Path
import gzip
import hashlib
import io
import json
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / 'assets' / 'vendor'


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'facility-viewer-build'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def package(name, version, folder, accepts):
    url = f'https://registry.npmjs.org/{name}/-/{name}-{version}.tgz'
    archive = fetch(url)
    target = ROOT / folder
    target.mkdir(parents=True, exist_ok=True)
    count = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for member in tar.getmembers():
            relative = member.name.removeprefix('package/')
            if not member.isfile() or not accepts(relative):
                continue
            destination = target / relative
            if not destination.resolve().is_relative_to(target.resolve()):
                raise ValueError('Unsafe archive path')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(tar.extractfile(member).read())
            count += 1
    (target / 'SOURCES.md').write_text(f'# {name}\n\nVersion: {version}\n\nOfficial source: {url}\n\nArchive SHA-256: {hashlib.sha256(archive).hexdigest()}\n\nLoaded from this site only. See included license.\n', encoding='utf-8')
    print(name, version, count, 'files')


if __name__ == '__main__':
    package('pdfjs-dist', '6.3.289', 'pdfjs', lambda p: p in ('LICENSE', 'build/pdf.mjs', 'build/pdf.worker.mjs') or p.startswith(('cmaps/', 'standard_fonts/', 'wasm/')))
    package('tesseract.js', '6.0.1', 'tesseract', lambda p: p in ('LICENSE', 'LICENSE.md', 'dist/tesseract.min.js', 'dist/worker.min.js'))
    package('tesseract.js-core', '6.1.2', 'tesseract/core', lambda p: p == 'LICENSE' or (p.startswith('tesseract-core') and p.endswith(('.wasm', '.wasm.js'))))
    commit = json.loads(fetch('https://api.github.com/repos/tesseract-ocr/tessdata_fast/commits/main'))['sha']
    target = ROOT / 'tesseract' / 'tessdata'
    target.mkdir(parents=True, exist_ok=True)
    for lang in ('kor', 'eng'):
        data = fetch(f'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/{commit}/{lang}.traineddata')
        (target / (lang + '.traineddata.gz')).write_bytes(gzip.compress(data, mtime=0))
    (target / 'LICENSE').write_bytes(fetch(f'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/{commit}/LICENSE'))
    (target / 'SOURCES.md').write_text(f'# Korean and English OCR language data\n\nApache-2.0, official tessdata_fast repository, commit {commit}.\n\nhttps://github.com/tesseract-ocr/tessdata_fast/tree/{commit}\n\nOriginal traineddata files are gzip compressed for browser loading.\n', encoding='utf-8')
    print('Korean and English language data ready')
