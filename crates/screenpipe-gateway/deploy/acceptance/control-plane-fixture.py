# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
# Synthetic loopback-only control plane for live VM acceptance. No real tokens.
import base64, datetime, hashlib, json
from http.server import BaseHTTPRequestHandler, HTTPServer
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
KEY=Ed25519PrivateKey.from_private_bytes(bytes([42])*32)
TOKEN='sk_ent_'+'a'*64
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def reply(self,code,data):
  body=json.dumps(data).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_POST(self):
  data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')
  if self.path.endswith('/register'):
   if data.get('enrollment_token')!='sge_live_fixture_0918': return self.reply(401,{'error':'fixture enrollment rejected'})
   return self.reply(200,{'gateway_id':'fixture-gateway','gateway_token':'sgw_live_fixture_0918','policy_refresh_seconds':30,'policy_validity_seconds':3600})
  return self.reply(200,{'ok':True})
 def do_GET(self):
  if self.headers.get('x-gateway-token')!='sgw_live_fixture_0918': return self.reply(401,{'error':'fixture gateway rejected'})
  now=datetime.datetime.now(datetime.timezone.utc)
  payload=json.dumps({'license_id':'lic-live','issued_at':now.isoformat(),'valid_until':(now+datetime.timedelta(hours=1)).isoformat(),'token_grants':[{'digest':hashlib.sha256(TOKEN.encode()).hexdigest(),'scopes':['read:search','read:records','read:devices']}]}).encode()
  return self.reply(200,{'version':1,'alg':'ed25519','key_id':'live-fixture','payload_b64':base64.b64encode(payload).decode(),'signature_b64':base64.b64encode(KEY.sign(payload)).decode()})
HTTPServer(('127.0.0.1',9000),Handler).serve_forever()
