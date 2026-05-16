"""
NEXUS — Multi-Agent AI OS
Flask backend with streaming, file uploads, image generation, terminal, GitHub, proxy.
"""

import hashlib, io, json, os, queue, subprocess, tempfile, threading, time, uuid, zipfile
from functools import wraps
from typing import Dict, Any, Optional

# ── PUSH NOTIFICATIONS (VAPID / Web Push) ──
_PUSH_SUBS: list = []
_PUSH_LOCK = threading.Lock()
_PUSH_SUBS_FILE  = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'push_subs.json')
_VAPID_KEYS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vapid_keys.json')
_VAPID_PRIVATE_KEY = None
_VAPID_PUBLIC_KEY  = None   # urlsafe-base64 unpadded, no-compress EC point

def _load_push_state():
    global _PUSH_SUBS, _VAPID_PRIVATE_KEY, _VAPID_PUBLIC_KEY
    # Load subscriptions
    try:
        if os.path.exists(_PUSH_SUBS_FILE):
            with open(_PUSH_SUBS_FILE) as f:
                _PUSH_SUBS = json.load(f)
    except Exception:
        _PUSH_SUBS = []
    # Load or generate VAPID keys
    try:
        if os.path.exists(_VAPID_KEYS_FILE):
            with open(_VAPID_KEYS_FILE) as f:
                keys = json.load(f)
            _VAPID_PRIVATE_KEY = keys.get('private')
            _VAPID_PUBLIC_KEY  = keys.get('public')
        else:
            try:
                from py_vapid import Vapid
                import base64
                from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
                v = Vapid()
                v.generate_keys()
                priv_pem = v.private_pem().decode('utf-8')
                raw_pub  = v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
                pub_b64  = base64.urlsafe_b64encode(raw_pub).rstrip(b'=').decode('utf-8')
                _VAPID_PRIVATE_KEY = priv_pem
                _VAPID_PUBLIC_KEY  = pub_b64
                with open(_VAPID_KEYS_FILE, 'w') as f:
                    json.dump({'private': priv_pem, 'public': pub_b64}, f)
            except Exception as e:
                print(f'[NEXUS] VAPID key gen failed: {e}')
    except Exception as e:
        print(f'[NEXUS] Push state load error: {e}')

def _save_push_subs():
    try:
        with open(_PUSH_SUBS_FILE, 'w') as f:
            json.dump(_PUSH_SUBS, f)
    except Exception:
        pass

def _send_push_notification(title: str, body: str, url: str = '/'):
    """Fire-and-forget push to all subscriptions. Runs in a background thread."""
    if not _PUSH_SUBS or not _VAPID_PRIVATE_KEY:
        return
    def _do_push():
        try:
            from pywebpush import webpush, WebPushException
            payload = json.dumps({'title': title, 'body': body[:200], 'url': url, 'tag': 'nexus-task'})
            dead_endpoints = []
            with _PUSH_LOCK:
                subs_copy = list(_PUSH_SUBS)
            for sub in subs_copy:
                try:
                    webpush(
                        subscription_info=sub,
                        data=payload,
                        vapid_private_key=_VAPID_PRIVATE_KEY,
                        vapid_claims={'sub': 'mailto:nexus@nexus.ai'},
                        ttl=86400,
                    )
                except WebPushException as ex:
                    if ex.response and ex.response.status_code in (404, 410):
                        dead_endpoints.append(sub.get('endpoint'))
                except Exception:
                    pass
            if dead_endpoints:
                with _PUSH_LOCK:
                    _PUSH_SUBS[:] = [s for s in _PUSH_SUBS if s.get('endpoint') not in dead_endpoints]
                _save_push_subs()
        except Exception as e:
            print(f'[NEXUS] Push send error: {e}')
    threading.Thread(target=_do_push, daemon=True).start()

_load_push_state()

# ── TASK PERSISTENCE DIRECTORY ──
# Stored inside the app directory so it survives Gunicorn restarts (not /tmp which is ephemeral)
_TASK_STORE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'task_store')
os.makedirs(_TASK_STORE_DIR, exist_ok=True)

def _task_file(task_id: str) -> str:
    return os.path.join(_TASK_STORE_DIR, f'{task_id}.jsonl')

def _persist_chunk(task_id: str, chunk: str):
    """Append a chunk to the task's persistent JSONL file."""
    try:
        with open(_task_file(task_id), 'a', encoding='utf-8') as f:
            f.write(chunk + '\n')
    except Exception:
        pass

def _load_task_chunks(task_id: str):
    """Load all persisted chunks for a task from disk. Returns list of chunk strings."""
    try:
        path = _task_file(task_id)
        if not os.path.exists(path):
            return None
        with open(path, 'r', encoding='utf-8') as f:
            lines = [ln.rstrip('\n') for ln in f if ln.strip()]
        return lines
    except Exception:
        return None

def _save_task_meta(task_id: str, message: str):
    """Save task metadata (message, start time) to a separate meta file."""
    try:
        meta = {'task_id': task_id, 'message': message[:200], 'started': time.time(), 'done': False}
        with open(_task_file(task_id) + '.meta', 'w', encoding='utf-8') as f:
            json.dump(meta, f)
    except Exception:
        pass

def _mark_task_done(task_id: str):
    """Mark a task as done in its meta file."""
    try:
        path = _task_file(task_id) + '.meta'
        if os.path.exists(path):
            with open(path, 'r+', encoding='utf-8') as f:
                meta = json.load(f)
                meta['done'] = True
                meta['finished'] = time.time()
                f.seek(0); json.dump(meta, f); f.truncate()
    except Exception:
        pass

def _list_tasks(limit: int = 20):
    """List recent tasks with metadata."""
    tasks = []
    try:
        meta_files = [f for f in os.listdir(_TASK_STORE_DIR) if f.endswith('.meta')]
        for mf in sorted(meta_files, reverse=True)[:limit]:
            try:
                with open(os.path.join(_TASK_STORE_DIR, mf), 'r') as f:
                    meta = json.load(f)
                tasks.append(meta)
            except Exception:
                pass
    except Exception:
        pass
    return sorted(tasks, key=lambda x: x.get('started', 0), reverse=True)

from flask import Flask, Response, jsonify, redirect, render_template, request, session, stream_with_context, url_for
from flask_cors import CORS

from agents import CoordinatorAgent
from agents.coordinator_agent import _IMAGE_HISTORY, _MEMORY, _PROCESSES, _WORKSPACE, _kali_warmup, _custom_api_warmup

app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', os.urandom(32).hex())
CORS(app, supports_credentials=True)

# ── USER STORE (JSON file, no DB needed) ──
_USERS_FILE = os.path.join(os.path.dirname(__file__), 'users.json')

def _load_users() -> dict:
    if not os.path.exists(_USERS_FILE):
        return {}
    try:
        with open(_USERS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def _save_users(users: dict):
    with open(_USERS_FILE, 'w') as f:
        json.dump(users, f, indent=2)

def _hash_pw(pw: str) -> str:
    return hashlib.sha256(pw.encode()).hexdigest()

def _auth_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        # Skip auth if not configured (dev mode / no users yet)
        if not os.path.exists(_USERS_FILE) or not _load_users():
            return f(*args, **kwargs)
        if not session.get('user'):
            if request.is_json:
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), 'uploads')
GIT_DIR    = os.path.join(os.path.dirname(__file__), 'git_imports')
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(GIT_DIR,    exist_ok=True)

coordinator = CoordinatorAgent()

_public_url_set = False

@app.before_request
def _detect_public_url():
    """Auto-detect and cache the public base URL from the first real HTTP request.
    This ensures the proxy URL is always correct on Replit, Render, and any host."""
    global _public_url_set
    if _public_url_set:
        return
    # Respect pre-set env vars first
    if os.environ.get('RENDER_EXTERNAL_URL') or os.environ.get('REPLIT_DEV_DOMAIN'):
        _public_url_set = True
        return
    # Derive from Flask request headers (works on any reverse-proxy host)
    try:
        scheme = (request.headers.get('X-Forwarded-Proto')
                  or request.headers.get('X-Scheme')
                  or request.scheme
                  or 'https')
        host = (request.headers.get('X-Forwarded-Host')
                or request.headers.get('Host')
                or request.host)
        if host and 'localhost' not in host and '127.0.0.1' not in host:
            url = f"{scheme}://{host}"
            os.environ['NEXUS_PUBLIC_URL'] = url
            _public_url_set = True
    except Exception:
        pass

# Warm up Kali Linux server in background immediately on startup
_kali_warmup()
_custom_api_warmup()

_tasks: Dict[str, Dict[str, Any]] = {}
_tasks_lock = threading.Lock()
_previews:   Dict[str, Dict[str, Any]] = {}


def _new_task(task_id: str, message: str = '') -> Dict[str, Any]:
    t = {'id': task_id, 'chunks': [], 'done': False, 'stopped': False,
         'queue': queue.Queue(), 'created': time.time()}
    with _tasks_lock:
        _tasks[task_id] = t
        if len(_tasks) > 100:
            oldest = sorted(_tasks.keys(), key=lambda k: _tasks[k]['created'])
            for k in oldest[:-100]: del _tasks[k]
    _save_task_meta(task_id, message)
    return t


def _run_chat_task(task_id, message, conversation, file_context, image_b64, image_mime, images=None):
    t = _tasks.get(task_id)
    if not t: return
    try:
        for raw_chunk in coordinator.chat_stream(
            message=message, conversation=conversation,
            file_context=file_context, image_b64=image_b64, image_mime=image_mime,
            images=images,
        ):
            if t['stopped']: break
            t['chunks'].append(raw_chunk)
            t['queue'].put(raw_chunk)
            _persist_chunk(task_id, raw_chunk)   # ← disk persistence
    except Exception as e:
        err = json.dumps({'type':'content','content':f'\n[Error: {e}]'})
        t['chunks'].append(err); t['queue'].put(err)
        _persist_chunk(task_id, err)
    finally:
        t['done'] = True; t['queue'].put(None)
        _mark_task_done(task_id)
        # Fire push notification so user knows task is done even if away from the page
        short_msg = message[:100] + ('…' if len(message) > 100 else '')
        _send_push_notification('NEXUS — Task Done ✓', short_msg)


def _sse(data: str) -> str:
    return f'data: {data}\n\n'


# ── PUSH NOTIFICATION API ──
@app.route('/api/push/vapid-key')
def push_vapid_key():
    if not _VAPID_PUBLIC_KEY:
        return jsonify({'error': 'Push not configured'}), 503
    return jsonify({'public_key': _VAPID_PUBLIC_KEY})

@app.route('/api/push/subscribe', methods=['POST'])
def push_subscribe():
    sub = request.get_json(force=True) or {}
    endpoint = sub.get('endpoint')
    if not endpoint:
        return jsonify({'error': 'Missing endpoint'}), 400
    with _PUSH_LOCK:
        existing = [s for s in _PUSH_SUBS if s.get('endpoint') != endpoint]
        existing.append(sub)
        _PUSH_SUBS[:] = existing
    _save_push_subs()
    return jsonify({'ok': True})

@app.route('/api/push/unsubscribe', methods=['POST'])
def push_unsubscribe():
    body = request.get_json(force=True) or {}
    endpoint = body.get('endpoint')
    if endpoint:
        with _PUSH_LOCK:
            _PUSH_SUBS[:] = [s for s in _PUSH_SUBS if s.get('endpoint') != endpoint]
        _save_push_subs()
    return jsonify({'ok': True})


# ── CONFIG ──
@app.route('/api/config')
def config():
    return jsonify({
        'workspace': _WORKSPACE,
        'has_github_token': bool(os.environ.get('GITHUB_PERSONAL_ACCESS_TOKEN', '')),
    })


# ── AUTH ROUTES ──
@app.route('/login', methods=['GET', 'POST'])
def login():
    users = _load_users()
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '').strip().lower()
        password = request.form.get('password', '')
        if username in users and users[username]['pw'] == _hash_pw(password):
            session['user'] = username
            session.permanent = True
            return redirect(url_for('index'))
        error = 'Invalid username or password.'
    # If no users exist yet, redirect to register
    if not users:
        return redirect(url_for('register'))
    return render_template('login.html', error=error)


@app.route('/register', methods=['GET', 'POST'])
def register():
    users = _load_users()
    error = None
    if request.method == 'POST':
        username = request.form.get('username', '').strip().lower()
        password = request.form.get('password', '')
        confirm  = request.form.get('confirm', '')
        if not username or len(username) < 3:
            error = 'Username must be at least 3 characters.'
        elif not password or len(password) < 6:
            error = 'Password must be at least 6 characters.'
        elif password != confirm:
            error = 'Passwords do not match.'
        elif username in users:
            error = 'Username already taken.'
        else:
            users[username] = {'pw': _hash_pw(password), 'created': time.time()}
            _save_users(users)
            session['user'] = username
            return redirect(url_for('index'))
    return render_template('login.html', mode='register', error=error)


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


# ── ROUTES ──
@app.route('/')
@_auth_required
def index():
    return render_template('index.html', workspace=_WORKSPACE,
                           current_user=session.get('user', ''))


@app.route('/api/me')
def api_me():
    return jsonify({'user': session.get('user'), 'logged_in': bool(session.get('user'))})


@app.route('/api/status')
def status():
    return jsonify(coordinator.get_system_status())


@app.route('/api/chat/stream', methods=['POST'])
@_auth_required
def chat_stream():
    body         = request.get_json(force=True) or {}
    message      = body.get('message', '')
    conversation = body.get('conversation', [])
    file_context = body.get('file_context')
    image_b64    = body.get('image_b64')
    image_mime   = body.get('image_mime')
    images       = body.get('images')   # list of {b64, mime, name}

    if not message:
        return jsonify({'error': 'No message'}), 400

    task_id = uuid.uuid4().hex
    task    = _new_task(task_id, message)

    t = threading.Thread(target=_run_chat_task,
        args=(task_id, message, conversation, file_context, image_b64, image_mime, images), daemon=False)
    t.start()

    def generate():
        yield _sse(json.dumps({'type':'task_id','task_id':task_id}))
        yield _sse(json.dumps({'type':'agent','agent':'orchestrator','agent_label':'Orchestrator'}))
        while True:
            try:
                chunk = task['queue'].get(timeout=25)
            except queue.Empty:
                if task['done']:
                    break
                # Still running — send SSE keepalive comment so connection stays open
                yield ': keepalive\n\n'
                continue
            if chunk is None:
                break
            yield _sse(chunk)
        yield _sse(json.dumps({'done': True}))
        yield _sse('[DONE]')

    return Response(stream_with_context(generate()), mimetype='text/event-stream',
                    headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no','Connection':'keep-alive'})


@app.route('/api/tasks/<task_id>/stream')
def task_stream(task_id: str):
    with _tasks_lock:
        task = _tasks.get(task_id)

    # ── Disk fallback: task not in memory (server restarted or task evicted) ──
    if not task:
        disk_chunks = _load_task_chunks(task_id)
        if disk_chunks is None:
            return jsonify({'error': 'Task not found'}), 404
        # Task finished — replay from disk
        def replay():
            for chunk in disk_chunks:
                yield _sse(chunk)
            yield _sse(json.dumps({'done': True}))
            yield _sse('[DONE]')
        return Response(stream_with_context(replay()), mimetype='text/event-stream',
                        headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no'})

    def generate():
        for chunk in list(task['chunks']): yield _sse(chunk)
        if not task['done']:
            start_idx = len(task['chunks'])
            while not task['done']:
                time.sleep(0.05)
                new = task['chunks'][start_idx:]
                for c in new: yield _sse(c)
                start_idx = len(task['chunks'])
        yield _sse(json.dumps({'done': True}))
        yield _sse('[DONE]')

    return Response(stream_with_context(generate()), mimetype='text/event-stream',
                    headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no','Connection':'keep-alive'})


@app.route('/api/tasks', methods=['GET'])
def list_tasks():
    """Return metadata for recent tasks (for reconnect UI)."""
    tasks = _list_tasks(limit=20)
    return jsonify({'tasks': tasks})


@app.route('/api/tasks/<task_id>/stop', methods=['POST'])
def task_stop(task_id: str):
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task: return jsonify({'error':'Task not found'}), 404
    task['stopped'] = True; task['done'] = True; task['queue'].put(None)
    return jsonify({'ok': True})


@app.route('/api/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({'success':False,'error':'No file'}), 400
    f        = request.files['file']
    filename = f.filename or 'upload'
    ext      = filename.rsplit('.',1)[-1].lower() if '.' in filename else ''
    uid      = uuid.uuid4().hex[:8]
    path     = os.path.join(UPLOAD_DIR, f'{uid}_{filename}')
    f.save(path)
    size = os.path.getsize(path)

    IMAGE_EXTS = {'png','jpg','jpeg','gif','webp','bmp','svg'}
    TEXT_EXTS  = {'txt','md','py','js','ts','html','css','json','yaml','yml','csv','xml',
                  'sh','bash','go','rs','rb','java','c','cpp','h','sql','toml','ini','cfg','env','log'}

    if ext in IMAGE_EXTS:
        import base64
        with open(path,'rb') as fh: b64 = base64.b64encode(fh.read()).decode()
        mime = {'jpg':'image/jpeg','jpeg':'image/jpeg','png':'image/png','gif':'image/gif',
                'webp':'image/webp','svg':'image/svg+xml'}.get(ext,'image/png')
        return jsonify({'success':True,'type':'image','filename':filename,'b64':b64,'mime':mime,'size':size,'ext':ext})

    if ext == 'zip':
        extract_dir = os.path.join(UPLOAD_DIR, uid + '_extracted')
        os.makedirs(extract_dir, exist_ok=True)
        try:
            with zipfile.ZipFile(path,'r') as zf: zf.extractall(extract_dir)
            content = _read_dir_as_text(extract_dir, max_chars=80000)
            return jsonify({'success':True,'type':'zip','filename':filename,'content':content,'size':size,'ext':ext,'saved_path':path})
        except Exception as e:
            return jsonify({'success':False,'error':str(e)}), 500

    if ext in TEXT_EXTS or size < 500_000:
        try:
            with open(path,'r',errors='replace') as fh: content = fh.read(80000)
            return jsonify({'success':True,'type':'text','filename':filename,'content':content,'size':size,'ext':ext,'saved_path':path})
        except Exception: pass

    return jsonify({'success':True,'type':'binary','filename':filename,'size':size,'ext':ext,'saved_path':path,'content':f'[Binary: {filename}, {size} bytes]'})


def _read_dir_as_text(directory: str, max_chars: int = 80000) -> str:
    parts, total = [], 0
    TEXT_EXTS = {'.txt','.md','.py','.js','.ts','.html','.css','.json','.yaml','.yml',
                 '.csv','.xml','.sh','.go','.rs','.rb','.java','.c','.cpp','.h','.sql',
                 '.toml','.ini','.cfg','.env','.log','.gitignore'}
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('node_modules','__pycache__','.git')]
        for fname in sorted(files):
            if total >= max_chars: break
            fpath = os.path.join(root, fname)
            _, fext = os.path.splitext(fname.lower())
            if fext not in TEXT_EXTS: continue
            rel = os.path.relpath(fpath, directory)
            try:
                with open(fpath,'r',errors='replace') as fh: content = fh.read(10000)
                chunk = f'=== {rel} ===\n{content}'
                parts.append(chunk); total += len(chunk)
            except Exception: pass
    return '\n\n'.join(parts)


@app.route('/api/shell', methods=['POST'])
def run_shell():
    """Terminal panel — routes to Kali Linux, falls back to local."""
    body    = request.get_json(force=True) or {}
    command = body.get('command','').strip()
    cwd     = body.get('cwd', _WORKSPACE)
    slot    = body.get('session', 'terminal')
    timeout = min(int(body.get('timeout', 60)), 120)
    if not command: return jsonify({'success':False,'error':'No command'}), 400

    from agents.coordinator_agent import _kali_available, _kali_exec
    if _kali_available():
        result = _kali_exec(command, timeout=timeout, slot=slot)
        out    = result['output']
        return jsonify({
            'success': result['ok'],
            'stdout':  out,
            'stderr':  '',
            'returncode': 0 if result['ok'] else 1,
            'kali': True,
            'session_token': result.get('token',''),
        })

    # Local fallback
    if not os.path.isdir(cwd): cwd = _WORKSPACE
    try:
        r = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=timeout, cwd=cwd)
        return jsonify({'success':r.returncode==0,'stdout':r.stdout,'stderr':r.stderr,'returncode':r.returncode,'kali':False})
    except subprocess.TimeoutExpired:
        return jsonify({'success':False,'stdout':'','stderr':'Timed out','returncode':-1,'kali':False})
    except Exception as e:
        return jsonify({'success':False,'error':str(e)}), 500


@app.route('/api/kali-exec', methods=['POST'])
def kali_exec():
    """Direct proxy to Kali Linux remote execution API."""
    from agents.coordinator_agent import _KALI_URL, _KALI_KEY, _kali_exec, _kali_available, _KALI_TOKEN
    body    = request.get_json(force=True) or {}
    command = body.get('cmd', body.get('command', '')).strip()
    timeout = min(int(body.get('timeout', 60)), 120)
    slot    = body.get('session', body.get('slot', 'terminal'))
    if not command:
        return jsonify({'ok':False,'error':'No command'}), 400
    if not _kali_available():
        return jsonify({'ok':False,'error':'Kali API not configured'}), 503
    result = _kali_exec(command, timeout=timeout, slot=slot)
    return jsonify({
        'ok':      result['ok'],
        'output':  result['output'],
        'token':   result.get('token',''),
        'kali_url': _KALI_URL,
    })


@app.route('/api/kali-session/reset', methods=['POST'])
def kali_session_reset():
    """Clear all Kali session tokens (start fresh sessions)."""
    from agents.coordinator_agent import _KALI_TOKEN, _KALI_LOCK
    import threading
    with _KALI_LOCK:
        _KALI_TOKEN.clear()
    return jsonify({'ok': True, 'msg': 'Kali sessions cleared'})


@app.route('/api/kali-status', methods=['GET'])
def kali_status():
    """Check if Kali Linux is reachable."""
    from agents.coordinator_agent import _kali_exec, _kali_available, _KALI_URL
    if not _kali_available():
        return jsonify({'ok':False,'error':'Not configured','url':''})
    result = _kali_exec('echo KALI_OK && uname -a', timeout=20, slot='status_check')
    return jsonify({
        'ok':     result['ok'],
        'output': result['output'],
        'url':    _KALI_URL,
    })


@app.route('/api/run-code', methods=['POST'])
def run_code():
    body = request.get_json(force=True) or {}
    code = body.get('code','')
    lang = body.get('lang','py')
    if not code: return jsonify({'success':False,'error':'No code'}), 400
    import sys as _sys, shutil as _shutil
    PY  = _sys.executable
    NODE = _shutil.which('node') or 'node'
    cmd_map = {'py':[PY],'js':[NODE],'sh':['bash']}
    cmd = cmd_map.get(lang,[PY])
    with tempfile.NamedTemporaryFile(suffix='.'+lang, delete=False, mode='w') as f:
        f.write(code); tmp = f.name
    try:
        r = subprocess.run(cmd+[tmp], capture_output=True, text=True, timeout=30)
        return jsonify({'success':r.returncode==0,'stdout':r.stdout,'stderr':r.stderr,
                        'returncode':r.returncode,'output':r.stdout+('\n'+r.stderr if r.stderr else '')})
    except subprocess.TimeoutExpired:
        return jsonify({'success':False,'stdout':'','stderr':'Timed out (30s)','returncode':-1,'output':'Timed out'})
    except Exception as e:
        return jsonify({'success':False,'error':str(e)}), 500
    finally:
        try: os.unlink(tmp)
        except: pass


@app.route('/api/run-node', methods=['POST'])
def run_node():
    import shutil as _shutil
    body = request.get_json(force=True) or {}
    code = body.get('code','')
    if not code: return jsonify({'success':False,'error':'No code'}), 400
    node = _shutil.which('node')
    if not node:
        return jsonify({'success':False,'error':'Node.js is not installed on this server. Use Python instead.',
                        'output':'Node.js not available','stdout':'','stderr':'node: not found','returncode':127}), 200
    with tempfile.NamedTemporaryFile(suffix='.js', delete=False, mode='w') as f:
        f.write(code); tmp = f.name
    try:
        r = subprocess.run([node, tmp], capture_output=True, text=True, timeout=30)
        return jsonify({'success':r.returncode==0,'stdout':r.stdout,'stderr':r.stderr,
                        'returncode':r.returncode,'output':r.stdout+('\n[stderr]\n'+r.stderr if r.stderr.strip() else '')})
    except subprocess.TimeoutExpired:
        return jsonify({'success':False,'stdout':'','stderr':'Timed out (30s)','returncode':-1,'output':'Timed out'})
    except Exception as e:
        return jsonify({'success':False,'error':str(e)}), 500
    finally:
        try: os.unlink(tmp)
        except: pass


@app.route('/api/run-file', methods=['POST'])
def run_file():
    body = request.get_json(force=True) or {}
    path = body.get('path','')
    if not path or not os.path.exists(path):
        return jsonify({'success':False,'error':'File not found'}), 400
    import sys as _sys, shutil as _shutil
    ext  = path.rsplit('.',1)[-1].lower()
    PY   = _sys.executable
    NODE = _shutil.which('node') or 'node'
    cmd  = {'py':[PY,path],'js':[NODE,path],'sh':['bash',path]}.get(ext,['bash',path])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return jsonify({'success':r.returncode==0,'stdout':r.stdout,'stderr':r.stderr,
                        'returncode':r.returncode,'output':r.stdout+('\n'+r.stderr if r.stderr else '')})
    except Exception as e:
        return jsonify({'success':False,'error':str(e)}), 500


@app.route('/api/import-github', methods=['POST'])
def import_github():
    body = request.get_json(force=True) or {}
    raw  = body.get('url','').strip()
    if not raw: return jsonify({'success':False,'error':'No URL'}), 400
    url  = raw if raw.startswith('http') else 'https://github.com/' + raw.strip('/')
    repo_name = url.rstrip('/').split('/')[-1]
    uid       = uuid.uuid4().hex[:8]
    clone_dir = os.path.join(GIT_DIR, f'{uid}_{repo_name}')
    try:
        r = subprocess.run(['git','clone','--depth','1',url,clone_dir], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return jsonify({'success':False,'error':r.stderr.strip() or 'Clone failed'}), 400
    except subprocess.TimeoutExpired:
        return jsonify({'success':False,'error':'Clone timed out'}), 400
    except Exception as e:
        return jsonify({'success':False,'error':str(e)}), 500

    file_tree = []
    for root, dirs, files in os.walk(clone_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in ('node_modules','__pycache__'))
        rel = os.path.relpath(root, clone_dir)
        prefix = '' if rel == '.' else rel + '/'
        for fname in sorted(files): file_tree.append(prefix + fname)

    context     = _read_dir_as_text(clone_dir, max_chars=120000)
    files_read  = context.count('=== ')
    total_kb    = round(len(context.encode())/1024, 1)
    return jsonify({'success':True,'url':url,'repo_name':repo_name,'context':context,
                    'file_tree':file_tree,'files_read':files_read,
                    'files_skipped':max(0,len(file_tree)-files_read),'total_size_kb':total_kb})


@app.route('/api/preview', methods=['POST'])
def create_preview():
    body = request.get_json(force=True) or {}
    html = body.get('html','')
    if not html: return jsonify({'error':'No HTML'}), 400
    pid = uuid.uuid4().hex
    _previews[pid] = {'html':html,'created':time.time()}
    if len(_previews) > 100:
        oldest = sorted(_previews.keys(), key=lambda k: _previews[k]['created'])
        for k in oldest[:-100]: del _previews[k]
    return jsonify({'id':pid,'url':f'/preview/{pid}'})


@app.route('/preview/<pid>')
def serve_preview(pid):
    p = _previews.get(pid)
    if not p: return '<h1>Preview expired</h1>', 404
    return Response(p['html'], mimetype='text/html',
                    headers={'Cache-Control':'no-store','X-Frame-Options':'ALLOWALL'})


# ── REVERSE PROXY for launched servers ──
@app.route('/proxy/<int:port>/', defaults={'path': ''})
@app.route('/proxy/<int:port>/<path:path>', methods=['GET','POST','PUT','DELETE','PATCH','OPTIONS'])
def proxy_server(port, path):
    """Proxy requests to a subprocess server running on localhost:<port>."""
    import urllib.request as _urlreq
    import urllib.error

    if port < 2000 or port > 9999:
        return jsonify({'error': 'Port out of allowed range'}), 403

    target_url = f'http://localhost:{port}/{path}'
    if request.query_string:
        target_url += '?' + request.query_string.decode('utf-8', errors='replace')

    try:
        req_body = request.get_data() or None
        req = _urlreq.Request(
            target_url,
            data=req_body if req_body else None,
            method=request.method,
        )
        for header in ['Content-Type', 'Accept', 'Authorization', 'Cookie']:
            val = request.headers.get(header)
            if val:
                req.add_header(header, val)

        with _urlreq.urlopen(req, timeout=30) as resp:
            content = resp.read()
            content_type = resp.headers.get('Content-Type', 'text/html')
            status = resp.status

            # Rewrite absolute URLs in HTML/CSS so assets load through the proxy
            if 'text/html' in content_type or 'text/css' in content_type or 'javascript' in content_type:
                try:
                    text = content.decode('utf-8', errors='replace')
                    p = f'/proxy/{port}'
                    # HTML attribute rewrites
                    text = text.replace('src="/',    f'src="{p}/')
                    text = text.replace("src='/",    f"src='{p}/")
                    text = text.replace('href="/',   f'href="{p}/')
                    text = text.replace("href='/",   f"href='{p}/")
                    text = text.replace('action="/', f'action="{p}/')
                    text = text.replace("action='/", f"action='{p}/")
                    text = text.replace('data-src="/', f'data-src="{p}/')
                    # CSS url() rewrites — handles single, double, and no quotes
                    import re as _re
                    text = _re.sub(r'url\(\s*["\']?(/[^)"\'\s]+)["\']?\s*\)',
                                   lambda m: f'url("{p}{m.group(1)}")', text)
                    # fetch/XHR calls to absolute paths in JS
                    text = text.replace("fetch('/",  f"fetch('{p}/")
                    text = text.replace('fetch("/',  f'fetch("{p}/')
                    content = text.encode('utf-8')
                except Exception:
                    pass

            response = Response(content, status=status, content_type=content_type)
            response.headers['X-Frame-Options'] = 'ALLOWALL'
            response.headers['Access-Control-Allow-Origin'] = '*'
            response.headers['Access-Control-Allow-Headers'] = '*'
            response.headers['Access-Control-Allow-Methods'] = '*'
            return response

    except urllib.error.HTTPError as e:
        return Response(e.read(), status=e.code, content_type='text/html')
    except Exception as e:
        # Server might be starting up
        return Response(
            f'<html><body style="background:#111;color:#fff;font-family:monospace;padding:40px">'
            f'<h2>⏳ Server starting on port {port}...</h2>'
            f'<p>Error: {str(e)}</p>'
            f'<p><a href="" style="color:#4d9eff" onclick="setTimeout(()=>location.reload(),1000);return false">↺ Retry</a></p>'
            f'<script>setTimeout(()=>location.reload(),2000)</script>'
            f'</body></html>',
            status=503, content_type='text/html'
        )


@app.route('/api/base-url')
def get_base_url():
    """Return the public base URL — used by the AI to build correct proxy links."""
    nexus = os.environ.get('NEXUS_PUBLIC_URL','')
    render = os.environ.get('RENDER_EXTERNAL_URL','')
    replit = os.environ.get('REPLIT_DEV_DOMAIN','')
    if nexus:   base = nexus
    elif render: base = render
    elif replit: base = f"https://{replit}"
    else:
        scheme = (request.headers.get('X-Forwarded-Proto') or request.scheme or 'https')
        host   = (request.headers.get('X-Forwarded-Host') or request.host)
        base   = f"{scheme}://{host}"
    return jsonify({'url': base.rstrip('/')})


@app.route('/api/push-github', methods=['POST'])
def push_github():
    body    = request.get_json(force=True) or {}
    repo    = body.get('repo','').strip()
    message = body.get('message','Update from NEXUS').strip()
    token   = os.environ.get('GITHUB_PERSONAL_ACCESS_TOKEN','')
    if not token: return jsonify({'success':False,'error':'GITHUB_PERSONAL_ACCESS_TOKEN not set. Add it in your environment variables.'}), 400
    if not repo:  return jsonify({'success':False,'error':'No repo specified'}), 400
    if not repo.startswith('http'): repo = 'https://github.com/' + repo.strip('/')
    auth_url = repo.replace('https://', f'https://{token}@')
    src = body.get('directory', _WORKSPACE).strip() or _WORKSPACE
    # Safety: only allow paths inside workspace or /home or /opt
    if not (src.startswith('/home') or src.startswith('/opt') or src.startswith(_WORKSPACE)):
        src = _WORKSPACE

    import shutil as _shutil
    tmp_dir = tempfile.mkdtemp(prefix='gh_push_')
    try:
        SKIP = {'.git','__pycache__','node_modules','.pythonlibs','.cache','.upm','.local',
                'uploads','git_imports','attached_assets'}
        for item in os.listdir(src):
            if item in SKIP or item.startswith('.'): continue
            s, d = os.path.join(src,item), os.path.join(tmp_dir,item)
            if os.path.isdir(s):
                _shutil.copytree(s,d,ignore=_shutil.ignore_patterns('__pycache__','*.pyc','node_modules','.git'))
            elif not item.endswith(('.pyc','.pyo','.pyd')):
                _shutil.copy2(s,d)

        # Get git identity from env or use defaults
        git_email = os.environ.get('GIT_USER_EMAIL', 'nexus@agent.ai')
        git_name  = os.environ.get('GIT_USER_NAME', 'NEXUS Agent')

        def _t(cmd):
            return subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=tmp_dir)

        _t('git init -b main')
        _t(f'git config user.email "{git_email}"')
        _t(f'git config user.name "{git_name}"')
        _t(f'git remote add origin "{auth_url}"')
        _t('git add -A')
        _t(f'git commit -m "{message}"')
        r = _t('git push -u origin main --force')
        if r.returncode != 0:
            err = (r.stderr or r.stdout or 'Push failed').replace(token,'***')
            return jsonify({'success':False,'error':err})
        return jsonify({'success':True,'repo':repo})
    except Exception as e:
        return jsonify({'success':False,'error':str(e)})
    finally:
        import shutil
        try: shutil.rmtree(tmp_dir, ignore_errors=True)
        except: pass


@app.route('/api/generate-zip', methods=['POST'])
def generate_zip():
    body  = request.get_json(force=True) or {}
    files = body.get('files',[])
    if not files: return jsonify({'error':'No files'}), 400
    buf = io.BytesIO()
    with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as zf:
        for f in files: zf.writestr(f.get('filename','file.txt'), f.get('content',''))
    buf.seek(0)
    return Response(buf.read(), mimetype='application/zip',
                    headers={'Content-Disposition':'attachment; filename=nexus_code.zip'})


# ── IMAGE ROUTES ──
@app.route('/api/images', methods=['GET'])
def get_images():
    return jsonify({'images': list(reversed(_IMAGE_HISTORY))})


@app.route('/api/images/generate', methods=['POST'])
def generate_image_api():
    body   = request.get_json(force=True) or {}
    prompt = body.get('prompt','').strip()
    style  = body.get('style','realistic')
    width  = int(body.get('width', 1024))
    height = int(body.get('height', 1024))
    if not prompt: return jsonify({'success':False,'error':'No prompt'}), 400

    import urllib.parse, hashlib
    style_map = {
        'realistic':  '',
        'cartoon':    ' cartoon style, vibrant colors',
        'artistic':   ' oil painting, artistic masterpiece',
        'cyberpunk':  ' cyberpunk neon aesthetic, dark futuristic',
        'anime':      ' anime style, detailed illustration',
        'photographic': ' photorealistic, DSLR quality',
    }
    full_prompt = prompt + style_map.get(style,'')
    encoded = urllib.parse.quote(full_prompt)
    seed    = abs(hash(full_prompt + str(time.time()))) % 99999
    img_url = f"https://image.pollinations.ai/prompt/{encoded}?width={width}&height={height}&seed={seed}&nologo=true"

    entry = {'id':uuid.uuid4().hex[:8],'prompt':prompt,'style':style,
             'url':img_url,'width':width,'height':height,'ts':time.time()}
    _IMAGE_HISTORY.append(entry)
    if len(_IMAGE_HISTORY) > 100: _IMAGE_HISTORY.pop(0)

    return jsonify({'success':True,'image':entry})


@app.route('/api/images/<img_id>/delete', methods=['DELETE'])
def delete_image(img_id: str):
    global _IMAGE_HISTORY
    before = len(_IMAGE_HISTORY)
    _IMAGE_HISTORY[:] = [i for i in _IMAGE_HISTORY if i['id'] != img_id]
    return jsonify({'ok': True, 'deleted': before - len(_IMAGE_HISTORY)})


# ── MEMORY ROUTES ──
@app.route('/api/memory', methods=['GET','POST','DELETE'])
def memory_api():
    if request.method == 'GET':
        return jsonify({'memory':dict(_MEMORY),'count':len(_MEMORY)})
    if request.method == 'POST':
        data  = request.get_json(silent=True) or {}
        key   = str(data.get('key','')).strip()
        value = str(data.get('value','')).strip()
        if not key: return jsonify({'error':'key required'}), 400
        _MEMORY[key] = value
        return jsonify({'ok':True,'key':key,'value':value})
    if request.method == 'DELETE':
        data = request.get_json(silent=True) or {}
        key  = str(data.get('key','')).strip()
        if key and key in _MEMORY:
            del _MEMORY[key]
            return jsonify({'ok':True,'deleted':key})
        _MEMORY.clear()
        return jsonify({'ok':True,'cleared':True})


# ── TEST AI ──
@app.route('/api/test-ai', methods=['GET'])
def test_ai():
    from agents.coordinator_agent import (_custom_client, _replit_client, _user_client,
                                           _CUSTOM_BASE, CUSTOM_MODELS, REPLIT_MODELS, USER_MODELS)
    results = {}

    def _probe(client, models, label):
        for model in models:
            try:
                resp = client.chat.completions.create(model=model,
                    messages=[{"role":"user","content":"Reply OK"}], max_tokens=5, stream=False)
                return {"ok":True,"model":model,"reply":resp.choices[0].message.content.strip()}
            except Exception as e:
                err = str(e)[:200]
                if "model" in err.lower() or "404" in err or "not found" in err.lower(): continue
                return {"ok":False,"model":model,"error":err}
        return {"ok":False,"error":"all models failed"}

    results["custom_api"] = {"base":_CUSTOM_BASE,**_probe(_custom_client, CUSTOM_MODELS,"custom")} if _custom_client else {"ok":False,"error":"not init"}
    results["replit"]     = _probe(_replit_client, REPLIT_MODELS,"replit") if _replit_client else {"ok":False,"error":"not configured"}
    results["user_key"]   = _probe(_user_client, USER_MODELS,"user")       if _user_client  else {"ok":False,"error":"not configured"}
    return jsonify(results)


# ── PROCESS MONITOR ROUTES ──
@app.route('/api/processes', methods=['GET'])
def list_processes():
    procs = []
    for pid, p in list(_PROCESSES.items()):
        proc   = p.get('proc')
        status = 'running' if (proc and proc.poll() is None) else 'stopped'
        procs.append({
            'id':      p.get('id', pid),
            'name':    p.get('name', '?'),
            'cmd':     p.get('cmd', ''),
            'port':    p.get('port', 0),
            'url':     p.get('url', ''),
            'pid':     p.get('pid', 0),
            'started': p.get('started', 0),
            'status':  status,
        })
    return jsonify({'processes': procs})


@app.route('/api/processes/<proc_id>/kill', methods=['POST'])
def kill_process_route(proc_id: str):
    p = _PROCESSES.pop(proc_id, None)
    if not p:
        return jsonify({'ok': False, 'error': 'Not found'}), 404
    try:
        proc = p.get('proc')
        if proc:
            proc.terminate()
            time.sleep(0.3)
            if proc.poll() is None: proc.kill()
        return jsonify({'ok': True, 'killed': p.get('name', proc_id)})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/kali/stream-live')
def kali_stream_live():
    """TRUE real-time streaming from Kali Linux via background process + poll loop."""
    command = request.args.get('cmd', '').strip()
    target  = request.args.get('target', '').strip()
    slot    = request.args.get('slot', 'live_stream')

    if not command:
        return jsonify({'error': 'No command'}), 400

    if target:
        command = command.replace('{target}', target)

    def generate():
        import json as _json, time as _time, re as _re, uuid as _uuid
        yield f"data: {_json.dumps({'type':'start','cmd':command})}\n\n"
        try:
            from agents.coordinator_agent import _kali_exec, _kali_available
            if not _kali_available():
                yield f"data: {_json.dumps({'type':'error','line':'⚠ Kali Linux is offline — check connection'})}\n\n"
                yield f"data: {_json.dumps({'type':'done','ok':False})}\n\n"
                return

            stream_id = _uuid.uuid4().hex[:10]
            outfile   = f"/tmp/nexus_live_{stream_id}.txt"
            done_tag  = f"NEXUS_DONE_{stream_id}"

            # ── Step 1: Launch command in Kali background, tee output to file ──
            # We base64-encode the inner command to avoid quote escaping issues
            import base64 as _b64
            inner_b64 = _b64.b64encode(command.encode()).decode()
            bg_script = (
                f"touch {outfile}; "
                f"( printf '%s' '{inner_b64}' | base64 -d | bash ) > {outfile} 2>&1; "
                f"echo '{done_tag}:'$? >> {outfile}"
            )
            # Write script to temp file, nohup it, return immediately with PID
            script_b64 = _b64.b64encode(bg_script.encode()).decode()
            tmpsh = f"/tmp/nexus_bg_{stream_id}.sh"
            write_res = _kali_exec(
                f"printf '%s' '{script_b64}' | base64 -d > {tmpsh} && chmod +x {tmpsh} && "
                f"nohup bash {tmpsh} > /dev/null 2>&1 & echo BGSTARTED:$!",
                timeout=15, slot=slot
            )
            out0 = write_res.get('output', '')
            pid_m = _re.search(r'BGSTARTED:(\d+)', out0)
            pid   = pid_m.group(1) if pid_m else None

            if not pid:
                # Background launch failed — fall back to synchronous with line-by-line replay
                yield f"data: {_json.dumps({'type':'line','line':'[running synchronously — output after completion]','ok':True})}\n\n"
                sync_res = _kali_exec(command, timeout=120, slot=slot)
                sync_out = sync_res.get('output', '').strip()
                ok = sync_res.get('ok', True)
                for ln in (sync_out.split('\n') if sync_out else ['(no output)']):
                    yield f"data: {_json.dumps({'type':'line','line':ln,'ok':ok})}\n\n"
                    _time.sleep(0.012)
                yield f"data: {_json.dumps({'type':'done','ok':ok,'elapsed':0})}\n\n"
                _kali_exec(f"rm -f {outfile} {tmpsh}", timeout=5, slot=slot)
                return

            # ── Step 2: Poll output file for new lines ──
            yield f"data: {_json.dumps({'type':'line','line':f'[started — PID {pid} — streaming output…]','ok':True})}\n\n"
            last_line = 0
            max_secs  = 240
            start_ts  = _time.time()
            done      = False
            ok        = True
            poll_err  = 0

            while not done and (_time.time() - start_ts) < max_secs:
                _time.sleep(1.5)

                # Read lines from last_line+1 onwards
                poll_res = _kali_exec(
                    f"tail -n +{last_line + 1} {outfile} 2>/dev/null",
                    timeout=10, slot=slot
                )
                new_text = poll_res.get('output', '').strip()

                if poll_res.get('output') is None:
                    poll_err += 1
                    if poll_err > 5:
                        yield f"data: {_json.dumps({'type':'error','line':'[poll error — Kali connection lost]'})}\n\n"
                        break
                    yield f"data: {_json.dumps({'type':'ping'})}\n\n"
                    continue
                poll_err = 0

                if not new_text:
                    # Process still running but no new output yet — send ping
                    yield f"data: {_json.dumps({'type':'ping'})}\n\n"
                    continue

                new_lines = new_text.split('\n')
                for ln in new_lines:
                    if done_tag in ln:
                        # Extract exit code
                        ec_m = _re.search(r':(\d+)\s*$', ln)
                        ok   = (ec_m.group(1) == '0') if ec_m else True
                        done = True
                        break
                    if ln.strip():
                        last_line += 1
                        yield f"data: {_json.dumps({'type':'line','line':ln,'ok':True})}\n\n"

                if not done:
                    yield f"data: {_json.dumps({'type':'ping'})}\n\n"

            elapsed = round(_time.time() - start_ts, 1)
            if not done:
                yield f"data: {_json.dumps({'type':'line','line':f'[timed out after {elapsed}s]','ok':False})}\n\n"
                ok = False

            # Cleanup temp files
            _kali_exec(f"rm -f {outfile} {tmpsh}", timeout=5, slot=slot)
            yield f"data: {_json.dumps({'type':'done','ok':ok,'elapsed':elapsed})}\n\n"

        except Exception as exc:
            yield f"data: {_json.dumps({'type':'error','line':str(exc)})}\n\n"
            yield f"data: {_json.dumps({'type':'done','ok':False,'elapsed':0})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive'}
    )


@app.route('/api/kali/stream-stop', methods=['POST'])
def kali_stream_stop():
    """Kill any stray background processes on the live-stream session slot."""
    try:
        from agents.coordinator_agent import _kali_exec
        slot = request.get_json(force=True).get('slot', 'live_stream')
        _kali_exec("kill %1 %2 %3 2>/dev/null; pkill -f nexus_live 2>/dev/null; pkill -f nexus_bg 2>/dev/null; rm -f /tmp/nexus_live_* /tmp/nexus_bg_* 2>/dev/null; echo stopped", timeout=8, slot=slot)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})


@app.route('/health')
@app.route('/healthz')
@app.route('/ping')
def health():
    return jsonify({'status':'ok','service':'nexus','ts':int(time.time())}), 200


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
