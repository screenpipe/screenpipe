# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Bounded synthetic WebRTC probe against an isolated remote development session."""
import asyncio, json, os, secrets, subprocess, signal, urllib.request, urllib.error, time, tempfile
from aiortc import RTCPeerConnection, RTCSessionDescription, AudioStreamTrack
import aiohttp

async def main():
    token = secrets.token_urlsafe(32)
    print('::add-mask::'+token, flush=True)
    # Override only this temporary dev session; production secrets and traffic are unchanged.
    with tempfile.TemporaryFile(mode='w+') as logs:
        process = subprocess.Popen(['bunx','wrangler','dev','--remote','--ip','127.0.0.1','--port','8791','--var','ADMIN_SECRET:'+token,'--log-level','error','--show-interactive-dev-session','false'], stdout=logs, stderr=logs, start_new_session=True)
        pc = RTCPeerConnection()
        call_id = None
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25)) as http:
                for _ in range(60):
                    try:
                        async with http.get('http://127.0.0.1:8791/test') as response:
                            if response.status == 200: break
                    except Exception: pass
                    if process.poll() is not None: raise RuntimeError('remote_dev_exited')
                    await asyncio.sleep(1)
                else: raise RuntimeError('remote_dev_timeout')
                pc.addTrack(AudioStreamTrack())  # Synthetic silence; no device capture.
                channel = pc.createDataChannel('oai-events')
                started = asyncio.Event()
                @channel.on('message')
                def message(data):
                    try:
                        event=json.loads(data)
                        if event.get('type') == 'session.started': started.set()
                    except Exception: pass
                await pc.setLocalDescription(await pc.createOffer())
                headers={'Authorization':'Bearer '+token,'OpenAI-Safety-Identifier':'a'*64}
                payload={'session':{'model':'gpt-live-1','store':False,'delegation':{'type':'client'},'instructions':'Synthetic connectivity check. Wait silently for client instructions.'},'transport':{'type':'webrtc','sdp':pc.localDescription.sdp}}
                async with http.post('http://127.0.0.1:8791/v1/admin/studio-voice',headers=headers,json=payload) as response:
                    result=await response.json()
                    print('live_create_status',response.status,flush=True)
                    if response.status != 201:
                        print('safe_error',json.dumps(result.get('error',{})),flush=True)
                        raise RuntimeError('live_create_failed')
                call_id=result['session']['id']
                await pc.setRemoteDescription(RTCSessionDescription(sdp=result['transport']['sdp'],type='answer'))
                await asyncio.wait_for(started.wait(),30)
                print('live_session_started',True,flush=True)
        finally:
            await pc.close()
            try:
                if call_id:
                    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=12)) as http:
                        async with http.delete('http://127.0.0.1:8791/v1/admin/studio-voice',headers={'Authorization':'Bearer '+token},json={'call_id':call_id}) as response:
                            print('live_cleanup_status',response.status,flush=True)
            except Exception:
                print('live_cleanup_failed',True,flush=True)
            if process.poll() is None: os.killpg(process.pid,signal.SIGTERM)
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: os.killpg(process.pid,signal.SIGKILL); process.wait()
            logs.seek(0)
            import re
            text=logs.read()
            for status in re.findall(r'\[studio-voice\] Provider rejected connection (\d{3})',text): print('provider_status',status,flush=True)
            print('remote_dev_stopped',process.poll() is not None,flush=True)

asyncio.run(main())
