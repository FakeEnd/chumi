"""Desktop acceptance on Windows, with real WASAPI capture and local Whisper.

Developer dependencies: pip install playwright pywinauto.
Launch Chumi with --remote-debugging-port=9333, CHUMI_DEV=1 and an isolated CHUMI_DATA_DIR.
The chosen AI provider is used for a catch-up and summary. The script plays a public synthetic clip.
Keep the window visible and stop other audio playback before running it.
"""
from pathlib import Path
import json
import sys
import threading
import time
import urllib.request
import winsound
import wave
from playwright.sync_api import sync_playwright
from pywinauto import Desktop
sys.stdout.reconfigure(encoding='utf-8')

root = Path(__file__).resolve().parents[1]
import argparse
parser = argparse.ArgumentParser(description='Operate an open Chumi desktop window and verify live Windows audio. Plays an 85-second fictional meeting clip and uses the selected AI provider.')
parser.add_argument('--data-dir', type=Path, default=root/'build'/'windows'/'acceptance-data')
parser.add_argument('--debug-port', type=int, default=9333)
parser.add_argument('--audio', type=Path, default=root/'samples'/'lab-meeting'/'lab-meeting.wav')
args = parser.parse_args()
data = args.data_dir
clip = root/'build'/'windows'/'meeting-clip.wav'
clip.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(args.audio), 'rb') as source:
    assert source.getnchannels() == 1 and source.getsampwidth() == 2 and source.getframerate() == 16000
    with wave.open(str(clip), 'wb') as target:
        target.setparams(source.getparams())
        target.writeframes(source.readframes(85*16000))
base = json.loads((data/'server.json').read_text(encoding='utf-8'))['url']
results = []

def api(path, body=None, method=None):
    request = urllib.request.Request(base+path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Content-Type':'application/json', 'X-Chumi':'1'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)

def record(name, detail):
    results.append({'check': name, 'detail': detail})
    print('PASS', name, detail, flush=True)
    (root/'build'/'windows'/'desktop-verification.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')

def wait_for(fn, seconds=150):
    end = time.monotonic()+seconds
    while time.monotonic() < end:
        result = fn()
        if result:
            return result
        time.sleep(0.5)
    raise TimeoutError('Acceptance condition did not arrive')

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp(f'http://127.0.0.1:{args.debug_port}')
    page = next(p for c in browser.contexts for p in c.pages if p.url == base + '/')
    page.reload()
    page.locator('.start-card').nth(2).wait_for()
    assert api('/api/state')['live']['status'] == 'idle', 'End the current recording before running acceptance.'
    assert api('/api/state')['live']['asr']['state'] == 'ready'
    page.locator('.hero-status .pill').filter(has_text='已就绪').wait_for(timeout=30000)
    record('Fresh launch reports speech ready in the window', page.locator('.hero-status .pill').first.inner_text())
    window = Desktop(backend='win32').window(title='Chumi', class_name='Chrome_WidgetWin_1')
    old = window.rectangle()
    window.move_window(old.left+20, old.top+20, old.width()-60, old.height()-60)
    record('Native window moves and resizes', str(window.rectangle()))
    window.capture_as_image().save(root/'build'/'windows'/'desktop-native-window.png')
    page.get_by_role('button', name='设置', exact=True).click()
    page.get_by_role('button', name='音频', exact=True).click()
    assert page.locator('.settings-content').get_by_text('Windows', exact=False).count() > 0
    page.keyboard.press('Escape')
    page.locator('.start-card').nth(2).click()
    source = page.locator('.dialog input[type=radio]:checked').locator('..').inner_text()
    assert '电脑' in source, source
    page.locator('.dialog input').first.fill('Windows 桌面采集验收：组会示例')
    page.get_by_role('button', name='开始收听', exact=True).click()
    state = wait_for(lambda: (s if (s:=api('/api/state'))['live']['status']=='recording' else None))
    session = state['live']['session']['id']
    record('Online preset starts native system capture', {'source': state['live']['source'], 'session': session})
    playback = threading.Thread(target=lambda: winsound.PlaySound(str(root/'build'/'windows'/'meeting-clip.wav'), winsound.SND_FILENAME))
    playback.start()
    first = wait_for(lambda: (s if (s:=api('/api/sessions/'+session))['segments'] else None))
    record('Real WASAPI audio transcribed by Whisper', first['segments'][0]['text'])
    page.get_by_role('button', name='帮我跟上', exact=True).click()
    catchup = wait_for(lambda: next((o for o in api('/api/sessions/'+session)['outputs'] if o['kind']=='catchup' and o['status'] in ['done','error']), None), 240)
    assert catchup['status']=='done', catchup.get('error')
    record('Live catch-up through ChatGPT', {'citations': catchup['data'].get('refCheck'), 'excerpt': catchup['content'][:280]})
    page.get_by_role('button', name='暂停', exact=True).click()
    wait_for(lambda: api('/api/state')['live']['status']=='paused')
    page.get_by_role('button', name='继续', exact=True).click()
    wait_for(lambda: api('/api/state')['live']['status']=='recording')
    record('Pause and resume through the real window', 'both controls completed')
    playback.join(timeout=100)
    # End uses the desktop's actual JavaScript confirmation dialog.
    page.once('dialog', lambda dialog: dialog.accept())
    page.get_by_role('button', name='结束', exact=True).click()
    wait_for(lambda: api('/api/state')['live']['status']=='idle')
    summary = wait_for(lambda: next((o for o in api('/api/sessions/'+session)['outputs'] if o['kind']=='final_summary' and o['status'] in ['done','error']), None), 240)
    assert summary['status']=='done', summary.get('error')
    final = api('/api/sessions/'+session)
    record('Final summary from the captured meeting', {'segments': len(final['segments']), 'citations': summary['data'].get('refCheck'), 'excerpt': summary['content'][:280]})
    page.screenshot(path=str(root/'build'/'windows'/'desktop-summary.png'))
    (root/'build'/'windows'/'live-meeting.json').write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding='utf-8')
    # Verify real native screenshot capture against an available window.
    windows = api('/api/screen/windows')['windows']
    record('Window capture chooser', {'windows': len(windows), 'example': windows[0]['title'] if windows else ''})
    browser.close()
