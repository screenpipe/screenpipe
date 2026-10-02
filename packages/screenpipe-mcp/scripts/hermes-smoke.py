# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

"""Run with Hermes's Python: hermes-smoke.py HERMES_REPO GENERATED_CONFIG.
Uses an isolated profile and synthetic authenticated API; no model or recording access.
"""
import os, sys, tempfile, threading, json
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
root = Path(tempfile.mkdtemp(prefix='screenpipe-hermes-smoke-'))
os.environ['HERMES_HOME'] = str(root)
os.environ['SCREENPIPE_LOCAL_API_KEY'] = 'sp-fixture-only'
requests = []
reject = False
class API(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        requests.append({'path': self.path, 'authorized': self.headers.get('Authorization') == 'Bearer sp-fixture-only'})
        if reject or not requests[-1]['authorized']:
            self.send_response(401); self.end_headers(); self.wfile.write(b'{"error":"fixture authorization required"}'); return
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(json.dumps({'data':[{'type':'OCR','content':{'frame_id':42,'text':'Synthetic Hermes integration acceptance','timestamp':'2026-10-02T12:30:00Z','app_name':'Fixture','window_name':'Acceptance'}}], 'pagination':{'limit':1,'offset':0,'total':1}}).encode())
    def do_POST(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
api = ThreadingHTTPServer(('127.0.0.1',0), API)
threading.Thread(target=api.serve_forever,daemon=True).start()
os.environ['SCREENPIPE_API_URL'] = f'http://127.0.0.1:{api.server_port}'
sys.path.insert(0, sys.argv[1])
from tools import mcp_tool
import yaml, shutil
config = yaml.safe_load(Path(sys.argv[2]).read_text())['mcp_servers']
config = {'screenpipe': config['screenpipe']}
# Exercise the generated entry with this checkout's MCP build and a fixture API.
# Only the executable/package location and API address differ from desktop setup.
config['screenpipe']['command'] = shutil.which('bun')
config['screenpipe']['args'] = [str(Path(__file__).resolve().parents[1]/'dist/cli.js')]
config['screenpipe']['env']['SCREENPIPE_API_URL'] = os.environ['SCREENPIPE_API_URL']

try:
    names=mcp_tool.register_mcp_servers(config)
    assert any(n.endswith('search_content') for n in names), names
    from tools.registry import registry
    result=registry.dispatch(next(n for n in names if n.endswith('search_content')),{'start_time':'2026-10-02T12:00:00Z','end_time':'2026-10-02T13:00:00Z','limit':1})
    assert 'Synthetic Hermes integration acceptance' in str(result), result
    assert '2026-10-02T12:30:00Z' in str(result), result
    req=next(r for r in requests if '/search?' in r['path'])
    query=parse_qs(urlparse(req['path']).query)
    assert req['authorized'] and query['start_time']==['2026-10-02T12:00:00Z'] and query['end_time']==['2026-10-02T13:00:00Z']
    reject = True
    denied = registry.dispatch(next(n for n in names if n.endswith('search_content')), {'limit':1})
    assert '401' in str(denied), denied
    print(json.dumps({'passed':True,'tools_discovered':len(names),'authenticated_bounded_search':True,'timestamped_source_returned':True,'auth_failure_reported':True,'data':'synthetic','profile':str(root)}))
finally:
    mcp_tool.shutdown_mcp_servers(); api.shutdown()
