"""python server.py --port 8765; all calculations stay on this computer."""
import sys,json,argparse
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
ROOT=Path(__file__).parent.resolve()
STATIC=ROOT/'site' if (ROOT/'site').is_dir() else ROOT
sys.path.insert(0,str(STATIC))
try:from model import dispatch
except ImportError:raise SystemExit('Установите библиотеки: python -m pip install -r requirements.txt')
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*a,**kw):super().__init__(*a,directory=str(STATIC),**kw)
    def send_json(self,payload,status=200):
        body=json.dumps(payload,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_GET(self):
        if self.path=='/api/health':self.send_json({'ok':True})
        elif self.path.split('?',1)[0]=='/report.docx' and (ROOT/'Отчёт.docx').exists():
            b=(ROOT/'Отчёт.docx').read_bytes();self.send_response(200);self.send_header('Content-Type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
        else:super().do_GET()
    def do_POST(self):
        if self.path!='/api/compute':self.send_json({'error':'Не найдено'},404);return
        try:
            n=int(self.headers.get('Content-Length','0'))
            if not 0<n<=1000000:raise ValueError('Некорректный запрос')
            self.send_json({'result':dispatch(json.loads(self.rfile.read(n)))})
        except (ValueError,TypeError,KeyError) as e:self.send_json({'error':str(e)},400)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8765);a=p.parse_args()
    print(f'http://127.0.0.1:{a.port}',flush=True);ThreadingHTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
