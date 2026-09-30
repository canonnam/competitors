"""Required local OCR/PDF binaries are served without exposing repository data."""
from http.server import ThreadingHTTPServer
from threading import Thread
import urllib.request
import urllib.error
import unittest
from app import App


class QuietApp(App):
    def log_message(self, *args):
        pass


class FacilityAssetTests(unittest.TestCase):
    def test_scoped_resources_and_private_file_boundaries(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),QuietApp)
        thread=Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            base=f'http://127.0.0.1:{server.server_port}'
            public=('/facility-3d.html','/assets/facility-3d/example-floorplan.pdf',
                '/assets/vendor/tesseract/tessdata/kor.traineddata.gz',
                '/assets/vendor/tesseract/core/tesseract-core-simd-lstm.wasm',
                '/assets/vendor/pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap',
                '/assets/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf')
            for path in public:
                with self.subTest(path=path),urllib.request.urlopen(urllib.request.Request(base+path,method='HEAD')) as response:
                    self.assertEqual(response.status,200)
            for path in ('/.env','/app.py','/assets/vendor/tesseract/tessdata/SOURCES.md','/data/statistics_knowledge.json'):
                with self.subTest(path=path),self.assertRaises(urllib.error.HTTPError) as result:
                    urllib.request.urlopen(urllib.request.Request(base+path,method='HEAD'))
                self.assertEqual(result.exception.code,404)
        finally:
            server.shutdown();server.server_close();thread.join()
