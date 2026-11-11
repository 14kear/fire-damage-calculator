"""Локальный HTTP-сервер калькулятора последствий пожаров (чистый Python 3, без сторонних пакетов).
Запуск: python3 server.py --port 8765
"""
import argparse
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
sys.path.insert(0, str(ROOT))

from model import InputError, dispatch  # noqa: E402


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/health':
            self.send_json({'ok': True})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path != '/api/compute':
            self.send_json({'error': 'Не найдено'}, 404)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not (0 < length <= 1_000_000):
                raise InputError('Некорректный размер запроса.')
            req = json.loads(self.rfile.read(length).decode('utf-8'))
            self.send_json({'result': dispatch(req)})
        except (InputError, ValueError, TypeError, KeyError) as exc:
            self.send_json({'error': str(exc)}, 400)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Сервер моделирования последствий пожаров')
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    print(f'http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
