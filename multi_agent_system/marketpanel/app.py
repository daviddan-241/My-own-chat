
import os, sqlite3, secrets, json, datetime, re
from flask import Flask, request, redirect, url_for, render_template, session, abort, jsonify

APP_SECRET = os.environ.get('SECRET_KEY', secrets.token_hex(16))
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin')
BASE_URL = os.environ.get('BASE_URL', '')

app = Flask(__name__)
app.secret_key = APP_SECRET

DB_PATH = os.path.join(os.path.dirname(__file__), 'data.db')

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = db(); cur = conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT,
        slug TEXT,
        decoy_url TEXT,
        created_at TEXT
    )
    """)
    cur.execute("""
    CREATE TABLE IF NOT EXISTS hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id TEXT,
        ts TEXT,
        ip TEXT,
        ua TEXT,
        data TEXT
    )
    """
    )
    conn.commit(); conn.close()

init_db()

@app.route('/')
def index():
    if not session.get('auth'): return redirect(url_for('login'))
    return redirect(url_for('panel'))

@app.route('/login', methods=['GET','POST'])
def login():
    if request.method=='POST':
        if request.form.get('password')==ADMIN_PASSWORD:
            session['auth']=True
            return redirect(url_for('panel'))
        return render_template('login.html', error='Invalid password')
    return render_template('login.html')

@app.get('/logout')
def logout():
    session.clear(); return redirect(url_for('login'))

@app.get('/panel')
def panel():
    if not session.get('auth'): return redirect(url_for('login'))
    conn=db(); cur=conn.cursor()
    cur.execute('SELECT * FROM campaigns ORDER BY created_at DESC')
    campaigns=cur.fetchall()
    cur.execute('SELECT * FROM hits ORDER BY ts DESC LIMIT 50')
    hits=cur.fetchall(); conn.close()
    return render_template('panel.html', campaigns=campaigns, hits=hits, base_url=BASE_URL)

@app.post('/new_campaign')
def new_campaign():
    if not session.get('auth'): return abort(403)
    name=(request.form.get('name') or 'Untitled').strip()
    decoy_url=(request.form.get('decoy_url') or '').strip()
    slug=(request.form.get('slug') or '').strip().lower()
    if not decoy_url: return abort(400,'decoy_url required')
    import re, secrets, datetime
    slug=re.sub(r'[^a-z0-9\-]','', slug)
    cid=secrets.token_urlsafe(6)
    ts=datetime.datetime.utcnow().isoformat()
    conn=db(); cur=conn.cursor()
    cur.execute('INSERT INTO campaigns(id,name,slug,decoy_url,created_at) VALUES(?,?,?,?,?)',
                (cid,name,slug,decoy_url,ts))
    conn.commit(); conn.close()
    return redirect(url_for('panel'))

@app.get('/l/<id_or_slug>')
@app.get('/c/<id_or_slug>')
def landing(id_or_slug):
    conn=db(); cur=conn.cursor()
    cur.execute('SELECT * FROM campaigns WHERE slug=? COLLATE NOCASE', (id_or_slug,))
    row=cur.fetchone()
    if not row:
        cur.execute('SELECT * FROM campaigns WHERE id=?', (id_or_slug,))
        row=cur.fetchone()
    conn.close()
    if not row: return abort(404)
    return render_template('landing.html', c=dict(row))

@app.post('/api/hit')
def api_hit():
    if request.is_json:
        payload=request.get_json(silent=True) or {}
        cid=payload.get('cid')
        info=payload.get('info')
    else:
        cid=request.form.get('cid')
        info=request.form.get('info')
    if not cid: return jsonify({'error':'missing cid'}), 400
    ip=request.headers.get('X-Forwarded-For', request.remote_addr)
    ua=request.headers.get('User-Agent','')
    ts=datetime.datetime.utcnow().isoformat()
    try: data=json.dumps(info or {})
    except Exception: data='{}'
    conn=db(); cur=conn.cursor()
    cur.execute('INSERT INTO hits(campaign_id, ts, ip, ua, data) VALUES(?,?,?,?,?)', (cid,ts,ip,ua,data))
    conn.commit(); conn.close()
    return jsonify({'ok':True})

@app.get('/api/campaigns')
def api_campaigns():
    if not session.get('auth'): return abort(403)
    conn=db(); cur=conn.cursor()
    cur.execute('SELECT * FROM campaigns ORDER by created_at DESC')
    rows=[dict(r) for r in cur.fetchall()]
    conn.close(); return jsonify(rows)

@app.get('/api/hits')
def api_hits():
    if not session.get('auth'): return abort(403)
    conn=db(); cur=conn.cursor()
    cur.execute('SELECT * FROM hits ORDER by ts DESC LIMIT 100')
    rows=[]
    for r in cur.fetchall():
        d=dict(r)
        try: d['data']=json.loads(d.get('data') or '{}')
        except Exception: d['data']={}
        rows.append(d)
    conn.close(); return jsonify(rows)

if __name__=='__main__':
    port=int(os.environ.get('PORT','8012'))
    app.run(host='0.0.0.0', port=port)
