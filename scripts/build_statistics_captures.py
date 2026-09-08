"""Reproduce reviewed PDF excerpts with Poppler and Pillow (offline by default).

python scripts/build_statistics_captures.py [--download]
PDFs remain in .local/statistics; only the selected crops enter the static site.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true', help='Download missing source PDFs from their official links.')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'data/statistics_sources.json').read_text(encoding='utf-8'))
    cache = ROOT / '.local/statistics'
    cache.mkdir(parents=True, exist_ok=True)
    for doc in manifest['documents']:
        pdf = cache / (doc['id'] + '.pdf')
        if not pdf.exists() and args.download:
            request = urllib.request.Request(doc['downloadUrl'], headers={'User-Agent': 'Mozilla/5.0', 'Referer': doc['sourceUrl']})
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(request, timeout=45) as response:
                        content = response.read()
                    if not content.startswith(b'%PDF'):
                        raise ValueError('The source did not return a PDF: ' + doc['id'])
                    pdf.write_bytes(content)
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 429 or attempt == 2:
                        raise
                    time.sleep(3)
        if not pdf.exists():
            raise FileNotFoundError(f'{pdf}: provide the reviewed PDF or use --download')
        if hashlib.sha256(pdf.read_bytes()).hexdigest() != doc['sha256']:
            raise ValueError(f'{doc["id"]}: source changed; inspect and review its pages before updating the manifest')
        for capture in doc['captures']:
            prefix = cache / f'{doc["id"]}-{capture["pdfPage"]}'
            subprocess.run(['pdftoppm', '-f', str(capture['pdfPage']), '-l', str(capture['pdfPage']),
                            '-singlefile', '-scale-to', str(manifest['scaleTo']), '-png', str(pdf), str(prefix)], check=True)
            with Image.open(prefix.with_suffix('.png')) as image:
                left, top, right, bottom = capture['capture']
                if not (0 <= left < right <= image.width and 0 <= top < bottom <= image.height):
                    raise ValueError('Capture outside page: ' + capture['id'])
                output = (ROOT / capture['image'].lstrip('/')).resolve()
                if not output.is_relative_to(ROOT / 'assets/statistics'):
                    raise ValueError('Invalid capture output path')
                output.parent.mkdir(parents=True, exist_ok=True)
                image.crop((left, top, right, bottom)).save(output, optimize=True)
            print(f'{capture["id"]}: PDF {capture["pdfPage"]}, printed p. {capture["printedPage"]}')


if __name__ == '__main__':
    main()
