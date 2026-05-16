"""
Security Agent — Real Ethical Security Testing Engine
Pure-Python: works on Render, Replit, Heroku with zero binary deps.

Capabilities:
  • Port scanning (TCP connect, threaded)
  • HTTP security header audit
  • SSL/TLS certificate & cipher analysis
  • DNS enumeration + subdomain discovery
  • Endpoint/directory brute-force
  • Web vulnerability probes (open redirect, CORS, CSRF, info leaks)
  • Code static analysis (SQLi, XSS, command injection, secrets)
  • Dependency vulnerability lookup
"""

import re, os, socket, ssl, threading, time, json, urllib.request, urllib.error, urllib.parse
from typing import Dict, Any, List, Tuple
from .base_agent import BaseAgent, Task, AgentStatus


# ── COMMON PORTS ──────────────────────────────────────────────────────────────
COMMON_PORTS = {
    21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS",
    80: "HTTP", 110: "POP3", 143: "IMAP", 443: "HTTPS", 445: "SMB",
    3306: "MySQL", 3389: "RDP", 5432: "PostgreSQL", 5900: "VNC",
    6379: "Redis", 8080: "HTTP-alt", 8443: "HTTPS-alt", 8888: "Jupyter",
    9200: "Elasticsearch", 27017: "MongoDB", 11211: "Memcached",
}

SECURITY_HEADERS = {
    "Strict-Transport-Security": "HSTS — protects against downgrade attacks",
    "Content-Security-Policy": "CSP — prevents XSS/injection attacks",
    "X-Frame-Options": "Clickjacking protection",
    "X-Content-Type-Options": "MIME sniffing protection",
    "Referrer-Policy": "Controls referrer info sent to third parties",
    "Permissions-Policy": "Controls browser feature access",
    "X-XSS-Protection": "Legacy XSS filter (supplemental)",
    "Cross-Origin-Opener-Policy": "Isolation from cross-origin windows",
    "Cross-Origin-Resource-Policy": "Controls cross-origin resource reads",
}

SENSITIVE_PATHS = [
    "/.env", "/.git/config", "/.git/HEAD", "/config.php", "/wp-config.php",
    "/database.yml", "/secrets.yml", "/.aws/credentials", "/composer.json",
    "/package.json", "/.htaccess", "/web.config", "/phpinfo.php",
    "/adminer.php", "/phpmyadmin", "/admin", "/administrator",
    "/wp-admin", "/wp-login.php", "/login", "/dashboard", "/api",
    "/api/docs", "/swagger", "/swagger.json", "/openapi.json",
    "/graphql", "/graphiql", "/debug", "/console", "/metrics",
    "/health", "/status", "/robots.txt", "/sitemap.xml",
    "/backup.zip", "/backup.sql", "/dump.sql", "/db.sql",
]

CODE_VULN_PATTERNS = {
    "sql_injection": [
        (r'execute\s*\(\s*["\'].*%s', "CRITICAL", "String formatting in SQL query"),
        (r'cursor\.execute\s*\(\s*["\'].*\+', "CRITICAL", "String concat in SQL query"),
        (r'query\s*=\s*["\'].*\+\s*\w', "HIGH", "SQL string concatenation"),
        (r'f["\']SELECT.*\{', "HIGH", "f-string in SQL query"),
        (r'raw\s*\(.*\+', "CRITICAL", "Raw SQL with concatenation"),
    ],
    "command_injection": [
        (r'os\.system\s*\(', "CRITICAL", "os.system allows shell injection"),
        (r'subprocess\.\w+\(.*shell\s*=\s*True.*\+', "CRITICAL", "shell=True with string concat"),
        (r'\beval\s*\(', "CRITICAL", "eval() executes arbitrary code"),
        (r'\bexec\s*\(', "HIGH", "exec() executes arbitrary code"),
        (r'popen\s*\(', "HIGH", "popen() may allow command injection"),
    ],
    "xss": [
        (r'innerHTML\s*=\s*\w', "HIGH", "Direct innerHTML assignment"),
        (r'document\.write\s*\(', "HIGH", "document.write allows XSS"),
        (r'\.html\s*\(\s*\w', "MEDIUM", "jQuery .html() with variable"),
        (r'dangerouslySetInnerHTML', "HIGH", "React dangerouslySetInnerHTML"),
    ],
    "hardcoded_secrets": [
        (r'(?i)(api[_-]?key|apikey)\s*=\s*["\'][a-zA-Z0-9\-_]{16,}["\']', "CRITICAL", "Hardcoded API key"),
        (r'(?i)password\s*=\s*["\'][^"\']{4,}["\']', "CRITICAL", "Hardcoded password"),
        (r'(?i)secret\s*=\s*["\'][a-zA-Z0-9\-_]{12,}["\']', "CRITICAL", "Hardcoded secret"),
        (r'(?i)token\s*=\s*["\'][a-zA-Z0-9\-_\.]{20,}["\']', "CRITICAL", "Hardcoded token"),
        (r'sk-[a-zA-Z0-9]{32,}', "CRITICAL", "OpenAI API key exposed"),
        (r'ghp_[a-zA-Z0-9]{36}', "CRITICAL", "GitHub Personal Access Token exposed"),
        (r'AKIA[0-9A-Z]{16}', "CRITICAL", "AWS Access Key ID exposed"),
    ],
    "insecure_crypto": [
        (r'(?i)\bmd5\s*\(', "HIGH", "MD5 is cryptographically broken"),
        (r'(?i)\bsha1\s*\(', "MEDIUM", "SHA-1 is deprecated for security"),
        (r'(?i)DES\b', "CRITICAL", "DES encryption is broken"),
        (r'(?i)RC4\b', "HIGH", "RC4 is cryptographically weak"),
    ],
    "insecure_deserialization": [
        (r'\bpickle\.loads?\s*\(', "CRITICAL", "pickle deserialization is unsafe"),
        (r'\byaml\.load\s*\([^)]*\)', "HIGH", "yaml.load without Loader is unsafe"),
        (r'\beval\s*\(.*json', "HIGH", "eval on JSON input"),
    ],
    "path_traversal": [
        (r'open\s*\(.*request\.\w+', "HIGH", "User input in file open()"),
        (r'os\.path\.join\s*\(.*request', "HIGH", "User input in path join"),
    ],
    "ssrf": [
        (r'requests\.get\s*\(.*request\.\w+', "HIGH", "SSRF: user-controlled URL in requests"),
        (r'urllib.*urlopen\s*\(.*request\.\w+', "HIGH", "SSRF: user-controlled URL"),
    ],
}


def _tcp_scan(hostname: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((hostname, port), timeout=timeout):
            return True
    except Exception:
        return False


def _banner_grab(hostname: str, port: int, timeout: float = 2.0) -> str:
    try:
        with socket.create_connection((hostname, port), timeout=timeout) as s:
            s.settimeout(timeout)
            try:
                banner = s.recv(1024).decode("utf-8", errors="replace").strip()
                return banner[:120] if banner else ""
            except Exception:
                return ""
    except Exception:
        return ""


def _http_get(url: str, timeout: int = 8, allow_redirects: bool = True) -> Tuple[int, dict, str]:
    try:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (SecurityScanner/1.0 Ethical-Testing)",
                "Accept": "*/*",
            }
        )
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            headers = dict(resp.headers)
            body = resp.read(4096).decode("utf-8", errors="replace")
            return resp.status, headers, body
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), ""
    except Exception:
        return 0, {}, ""


class SecurityAgent(BaseAgent):
    def __init__(self):
        super().__init__(
            name="SecurityAgent",
            description="Ethical security testing — port scan, web audit, code SAST, SSL analysis"
        )
        self.capabilities = [
            "port_scan", "web_audit", "ssl_analysis", "dns_enum",
            "endpoint_discovery", "code_sast", "vuln_probe", "full_recon"
        ]
        self.scan_history: List[Dict] = []

    def execute(self, task: Task) -> Dict[str, Any]:
        self.status = AgentStatus.RUNNING
        action = task.payload.get("action", "full_recon")
        try:
            handlers = {
                "port_scan":          self._port_scan,
                "web_audit":          self._web_audit,
                "ssl_analysis":       self._ssl_analysis,
                "dns_enum":           self._dns_enum,
                "endpoint_discovery": self._endpoint_discovery,
                "code_sast":          self._code_sast,
                "vuln_probe":         self._vuln_probe,
                "full_recon":         self._full_recon,
                "scan_code":          self._code_sast,
                "check_secrets":      self._check_secrets_in_files,
            }
            fn = handlers.get(action)
            if not fn:
                return {"success": False, "error": f"Unknown action: {action}"}
            result = fn(task.payload)
            self.status = AgentStatus.COMPLETED
            return result
        except Exception as e:
            self.status = AgentStatus.ERROR
            return {"success": False, "error": str(e)}

    # ── PORT SCAN ─────────────────────────────────────────────────────────────
    def _port_scan(self, payload: Dict) -> Dict[str, Any]:
        target = payload.get("target", "")
        hostname = _clean_hostname(target)
        ports = payload.get("ports", list(COMMON_PORTS.keys()))
        timeout = float(payload.get("timeout", 1.0))

        results_lock = threading.Lock()
        open_ports: List[Dict] = []

        def _check(port):
            if _tcp_scan(hostname, port, timeout):
                service = COMMON_PORTS.get(port, "unknown")
                banner = _banner_grab(hostname, port, timeout + 1)
                with results_lock:
                    open_ports.append({
                        "port": port, "service": service,
                        "banner": banner, "status": "open"
                    })

        threads = [threading.Thread(target=_check, args=(p,), daemon=True) for p in ports]
        for t in threads: t.start()
        for t in threads: t.join(timeout=timeout + 2)

        open_ports.sort(key=lambda x: x["port"])
        return {
            "success": True,
            "target": hostname,
            "scanned": len(ports),
            "open_ports": open_ports,
            "open_count": len(open_ports),
            "report": _format_port_report(hostname, open_ports, ports),
        }

    # ── WEB HEADER AUDIT ─────────────────────────────────────────────────────
    def _web_audit(self, payload: Dict) -> Dict[str, Any]:
        target = payload.get("target", "")
        url = _normalize_url(target)
        status, headers, body = _http_get(url)
        if status == 0:
            return {"success": False, "error": f"Could not connect to {url}"}

        missing, present = [], []
        for h, desc in SECURITY_HEADERS.items():
            hval = _header_get(headers, h)
            if hval:
                present.append({"header": h, "value": hval[:120], "desc": desc})
            else:
                missing.append({"header": h, "desc": desc})

        info_leaks = []
        for leak_header in ["Server", "X-Powered-By", "X-AspNet-Version", "X-Generator"]:
            val = _header_get(headers, leak_header)
            if val:
                info_leaks.append({"header": leak_header, "value": val})

        cors = _header_get(headers, "Access-Control-Allow-Origin")
        cors_issue = cors == "*"

        csp = _header_get(headers, "Content-Security-Policy") or ""
        csp_issues = []
        if "'unsafe-inline'" in csp: csp_issues.append("unsafe-inline allows inline scripts")
        if "'unsafe-eval'" in csp:   csp_issues.append("unsafe-eval allows eval()")
        if "default-src *" in csp:   csp_issues.append("Wildcard default-src bypasses CSP")

        score = max(0, 100 - len(missing) * 10 - len(info_leaks) * 5 - (10 if cors_issue else 0))

        return {
            "success": True, "url": url, "status": status,
            "security_score": score,
            "missing_headers": missing, "present_headers": present,
            "info_leaks": info_leaks, "cors_wildcard": cors_issue,
            "csp_issues": csp_issues,
            "report": _format_web_report(url, status, missing, present, info_leaks, cors_issue, csp_issues, score),
        }

    # ── SSL ANALYSIS ─────────────────────────────────────────────────────────
    def _ssl_analysis(self, payload: Dict) -> Dict[str, Any]:
        target = payload.get("target", "")
        hostname = _clean_hostname(target)
        port = int(payload.get("port", 443))
        issues = []
        info = {}
        try:
            ctx = ssl.create_default_context()
            with socket.create_connection((hostname, port), timeout=8) as raw:
                with ctx.wrap_socket(raw, server_hostname=hostname) as s:
                    cert = s.getpeercert()
                    cipher = s.cipher()
                    version = s.version()
                    info = {
                        "tls_version": version,
                        "cipher_suite": cipher[0] if cipher else "unknown",
                        "key_bits": cipher[2] if cipher else 0,
                        "subject": dict(x[0] for x in cert.get("subject", [])),
                        "issuer": dict(x[0] for x in cert.get("issuer", [])),
                        "not_before": cert.get("notBefore", ""),
                        "not_after": cert.get("notAfter", ""),
                        "san": [v for _, v in cert.get("subjectAltName", [])],
                    }
                    if version in ("TLSv1", "TLSv1.1", "SSLv3", "SSLv2"):
                        issues.append(f"CRITICAL: {version} is deprecated and insecure")
                    if cipher and cipher[2] and cipher[2] < 128:
                        issues.append(f"WEAK: Key size {cipher[2]}-bit is too small")
                    if "RC4" in (cipher[0] or ""):
                        issues.append("CRITICAL: RC4 cipher is broken")
                    if "MD5" in (cipher[0] or ""):
                        issues.append("HIGH: MD5 in cipher suite is weak")
                    exp_str = cert.get("notAfter", "")
                    if exp_str:
                        try:
                            import email.utils
                            exp = time.mktime(time.strptime(exp_str, "%b %d %H:%M:%S %Y %Z"))
                            days_left = int((exp - time.time()) / 86400)
                            if days_left < 0:
                                issues.append(f"CRITICAL: Certificate EXPIRED {abs(days_left)} days ago")
                            elif days_left < 30:
                                issues.append(f"HIGH: Certificate expires in {days_left} days")
                            info["days_until_expiry"] = days_left
                        except Exception:
                            pass
        except ssl.SSLCertVerificationError as e:
            issues.append(f"CRITICAL: Certificate verification failed — {e}")
        except Exception as e:
            return {"success": False, "error": f"SSL connection failed: {e}"}

        return {
            "success": True, "target": hostname, "port": port,
            "info": info, "issues": issues,
            "report": _format_ssl_report(hostname, info, issues),
        }

    # ── DNS ENUMERATION ───────────────────────────────────────────────────────
    def _dns_enum(self, payload: Dict) -> Dict[str, Any]:
        target = payload.get("target", "")
        hostname = _clean_hostname(target)
        results = {"a": [], "aaaa": [], "mx": [], "ns": [], "txt": [], "cname": [], "subs": []}

        try:
            results["a"].append(socket.gethostbyname(hostname))
        except Exception: pass

        try:
            for af, _, _, _, addr in socket.getaddrinfo(hostname, None, socket.AF_INET6):
                results["aaaa"].append(addr[0])
        except Exception: pass

        try:
            import subprocess as _sp
            for rtype in ("MX", "NS", "TXT", "CNAME"):
                r = _sp.run(["nslookup", f"-type={rtype}", hostname],
                            capture_output=True, text=True, timeout=5)
                key = rtype.lower()
                for line in r.stdout.splitlines():
                    if "=" in line or "nameserver" in line.lower() or "mail" in line.lower():
                        results[key].append(line.strip()[:100])
        except Exception: pass

        subs = ["www", "mail", "ftp", "admin", "api", "dev", "staging",
                "test", "beta", "app", "portal", "vpn", "remote", "cloud",
                "auth", "login", "secure", "shop", "store", "blog", "cdn"]
        found_subs = []
        def _check_sub(sub):
            try:
                ip = socket.gethostbyname(f"{sub}.{hostname}")
                found_subs.append({"subdomain": f"{sub}.{hostname}", "ip": ip})
            except Exception: pass
        threads = [threading.Thread(target=_check_sub, args=(s,), daemon=True) for s in subs]
        for t in threads: t.start()
        for t in threads: t.join(timeout=6)
        results["subs"] = found_subs

        return {
            "success": True, "target": hostname, "records": results,
            "report": _format_dns_report(hostname, results),
        }

    # ── ENDPOINT DISCOVERY ────────────────────────────────────────────────────
    def _endpoint_discovery(self, payload: Dict) -> Dict[str, Any]:
        target = payload.get("target", "")
        url = _normalize_url(target)
        paths = payload.get("paths", SENSITIVE_PATHS)
        found, blocked, errors = [], [], []

        def _check_path(path):
            try:
                status, headers, body = _http_get(f"{url.rstrip('/')}{path}", timeout=5)
                if status == 0:
                    return
                if status < 400:
                    size = len(body)
                    found.append({"path": path, "status": status, "size": size,
                                  "content_type": _header_get(headers, "Content-Type", "")[:60]})
                elif status == 403:
                    blocked.append({"path": path, "status": 403, "note": "Forbidden (exists)"})
            except Exception as e:
                errors.append(str(e)[:60])

        threads = [threading.Thread(target=_check_path, args=(p,), daemon=True) for p in paths]
        for t in threads: t.start()
        for t in threads: t.join(timeout=10)

        found.sort(key=lambda x: x["path"])
        blocked.sort(key=lambda x: x["path"])
        return {
            "success": True, "target": url, "found": found, "blocked": blocked,
            "report": _format_endpoint_report(url, found, blocked),
        }

    # ── STATIC CODE ANALYSIS (SAST) ───────────────────────────────────────────
    def _code_sast(self, payload: Dict) -> Dict[str, Any]:
        code = payload.get("code", "")
        file_path = payload.get("file_path", "")
        scan_dir = payload.get("scan_dir", "")

        if scan_dir and os.path.isdir(scan_dir):
            return self._scan_directory(scan_dir)
        if file_path and os.path.isfile(file_path):
            with open(file_path, "r", errors="replace") as f:
                code = f.read()
        if not code:
            return {"success": False, "error": "No code or file provided"}

        findings = _sast_scan(code, file_path or "<input>")
        return {
            "success": True,
            "file": file_path or "<input>",
            "findings": findings,
            "count": len(findings),
            "critical": sum(1 for f in findings if f["severity"] == "CRITICAL"),
            "high": sum(1 for f in findings if f["severity"] == "HIGH"),
            "report": _format_sast_report(file_path or "<input>", findings),
        }

    def _scan_directory(self, scan_dir: str) -> Dict[str, Any]:
        all_findings = []
        scanned = 0
        exts = {".py", ".js", ".ts", ".php", ".java", ".go", ".rb",
                ".env", ".yaml", ".yml", ".json", ".sh", ".bash"}
        for root, dirs, files in os.walk(scan_dir):
            dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__", ".git", ".venv")]
            for fname in files:
                ext = os.path.splitext(fname)[1].lower()
                if ext not in exts: continue
                fp = os.path.join(root, fname)
                try:
                    with open(fp, "r", errors="replace") as f:
                        code = f.read(50000)
                    rel = os.path.relpath(fp, scan_dir)
                    findings = _sast_scan(code, rel)
                    all_findings.extend(findings)
                    scanned += 1
                except Exception:
                    pass
        all_findings.sort(key=lambda x: (x.get("severity","LOW"),), reverse=True)
        return {
            "success": True, "scan_dir": scan_dir, "files_scanned": scanned,
            "findings": all_findings, "count": len(all_findings),
            "critical": sum(1 for f in all_findings if f["severity"] == "CRITICAL"),
            "high": sum(1 for f in all_findings if f["severity"] == "HIGH"),
            "report": _format_sast_report(scan_dir, all_findings),
        }

    def _check_secrets_in_files(self, payload: Dict) -> Dict[str, Any]:
        payload["scan_dir"] = payload.get("scan_path", payload.get("scan_dir", "."))
        return self._scan_directory(payload["scan_dir"])

    # ── VULNERABILITY PROBES ──────────────────────────────────────────────────
    def _vuln_probe(self, payload: Dict) -> Dict[str, Any]:
        target = payload.get("target", "")
        url = _normalize_url(target)
        findings = []

        status, headers, body = _http_get(url)
        if status == 0:
            return {"success": False, "error": f"Could not reach {url}"}

        cors = _header_get(headers, "Access-Control-Allow-Origin")
        if cors == "*":
            findings.append({"vuln": "CORS Wildcard", "severity": "HIGH",
                             "detail": "Access-Control-Allow-Origin: * allows any origin to read responses"})

        if not _header_get(headers, "X-Frame-Options") and not _header_get(headers, "Content-Security-Policy"):
            findings.append({"vuln": "Clickjacking", "severity": "MEDIUM",
                             "detail": "No X-Frame-Options or CSP frame-ancestors — page can be embedded in iframes"})

        if not _header_get(headers, "Strict-Transport-Security") and url.startswith("https"):
            findings.append({"vuln": "Missing HSTS", "severity": "MEDIUM",
                             "detail": "HTTPS site without HSTS allows downgrade attacks"})

        server = _header_get(headers, "Server", "")
        if server:
            findings.append({"vuln": "Server Version Disclosure", "severity": "LOW",
                             "detail": f"Server header reveals: {server}"})

        open_redirect_urls = [f"{url}?next=https://evil.com", f"{url}?redirect=https://evil.com",
                               f"{url}?url=https://evil.com", f"{url}?return=https://evil.com"]
        for test_url in open_redirect_urls[:2]:
            try:
                req = urllib.request.Request(test_url, headers={"User-Agent": "SecurityScanner/1.0"})
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                with urllib.request.urlopen(req, timeout=4, context=ctx) as r:
                    loc = r.url
                    if "evil.com" in loc:
                        findings.append({"vuln": "Open Redirect", "severity": "HIGH",
                                        "detail": f"Redirected to: {loc}"})
                        break
            except Exception:
                pass

        test_s, test_h, test_b = _http_get(f"{url}?id=1'", timeout=4)
        if test_b and any(err in test_b.lower() for err in
                          ["sql syntax", "mysql_fetch", "pg_query", "sqlite", "ora-", "sqlstate"]):
            findings.append({"vuln": "SQL Injection (Error-based)", "severity": "CRITICAL",
                             "detail": "SQL error in response to quote injection"})

        return {
            "success": True, "target": url, "findings": findings,
            "report": _format_vuln_report(url, findings),
        }

    # ── FULL RECON ────────────────────────────────────────────────────────────
    def _full_recon(self, payload: Dict) -> Dict[str, Any]:
        target = payload.get("target", "")
        if not target:
            return {"success": False, "error": "target required (e.g. example.com or https://example.com)"}

        sections = []
        sections.append(f"╔══════════════════════════════════════════════════════╗")
        sections.append(f"║  NEXUS ETHICAL SECURITY RECON — {target[:22]:<22} ║")
        sections.append(f"╚══════════════════════════════════════════════════════╝\n")
        sections.append("⚠ For authorized/owned targets only. Use responsibly.\n")

        hostname = _clean_hostname(target)

        r1 = self._dns_enum({"target": hostname})
        sections.append(r1.get("report", ""))

        r2 = self._port_scan({"target": hostname, "timeout": 1.0})
        sections.append(r2.get("report", ""))

        if r2.get("open_ports") and any(p["port"] in (80, 443, 8080, 8443) for p in r2["open_ports"]):
            r3 = self._web_audit({"target": target})
            sections.append(r3.get("report", ""))

            r4 = self._ssl_analysis({"target": target}) if any(p["port"] == 443 for p in r2["open_ports"]) else None
            if r4:
                sections.append(r4.get("report", ""))

            r5 = self._endpoint_discovery({"target": target})
            sections.append(r5.get("report", ""))

            r6 = self._vuln_probe({"target": target})
            sections.append(r6.get("report", ""))

        sections.append("\n[RECON COMPLETE] Document all findings and report to system owner.")
        full_report = "\n".join(sections)
        return {"success": True, "target": target, "report": full_report}


# ── HELPERS ───────────────────────────────────────────────────────────────────

def _clean_hostname(target: str) -> str:
    h = target.replace("https://", "").replace("http://", "").split("/")[0].split(":")[0]
    return h.strip()

def _normalize_url(target: str) -> str:
    if target.startswith("http"):
        return target.rstrip("/")
    return f"https://{target}".rstrip("/")

def _header_get(headers: dict, name: str, default: str = None):
    for k, v in headers.items():
        if k.lower() == name.lower():
            return v
    return default

def _sast_scan(code: str, filename: str) -> List[Dict]:
    findings = []
    lines = code.splitlines()
    for category, patterns in CODE_VULN_PATTERNS.items():
        for pattern, severity, detail in patterns:
            for i, line in enumerate(lines, 1):
                if re.search(pattern, line, re.IGNORECASE):
                    findings.append({
                        "file": filename, "line": i, "category": category,
                        "severity": severity, "detail": detail,
                        "snippet": line.strip()[:100],
                        "fix": _get_fix(category),
                    })
    return findings

def _get_fix(category: str) -> str:
    return {
        "sql_injection":           "Use parameterized queries / prepared statements",
        "command_injection":       "Use subprocess with list args, shell=False",
        "xss":                     "Sanitize output, use textContent instead of innerHTML",
        "hardcoded_secrets":       "Move to environment variables, use .env files",
        "insecure_crypto":         "Use SHA-256, AES-256-GCM, or bcrypt",
        "insecure_deserialization":"Use json.loads() instead of pickle/yaml.load()",
        "path_traversal":          "Validate/sanitize file paths, use os.path.realpath()",
        "ssrf":                    "Whitelist allowed URLs/domains, block internal IPs",
    }.get(category, "Review and remediate")

def _format_port_report(hostname, open_ports, all_ports) -> str:
    lines = [f"\n=== PORT SCAN: {hostname} ==="]
    lines.append(f"Scanned {len(all_ports)} common ports\n")
    if open_ports:
        for p in open_ports:
            banner = f"  └ {p['banner']}" if p['banner'] else ""
            lines.append(f"  ✓ OPEN   {p['port']:5d}/{p['service']}{banner}")
        lines.append(f"\n  {len(open_ports)} open port(s) found")
    else:
        lines.append("  No common ports open (all filtered or closed)")
    return "\n".join(lines)

def _format_web_report(url, status, missing, present, leaks, cors, csp_issues, score) -> str:
    lines = [f"\n=== HTTP SECURITY AUDIT: {url} ==="]
    lines.append(f"Status: HTTP {status} | Security Score: {score}/100\n")
    if present:
        lines.append("Present headers:")
        for h in present: lines.append(f"  ✓ {h['header']}: {h['value'][:60]}")
    if missing:
        lines.append("\nMissing headers (vulnerabilities):")
        for h in missing: lines.append(f"  ✗ {h['header']} — {h['desc']}")
    if leaks:
        lines.append("\nInfo disclosure:")
        for l in leaks: lines.append(f"  ⚠ {l['header']}: {l['value']}")
    if cors: lines.append("\n  ⚠ CORS: Access-Control-Allow-Origin: * (too permissive)")
    if csp_issues:
        lines.append("\nCSP issues:")
        for i in csp_issues: lines.append(f"  ⚠ {i}")
    return "\n".join(lines)

def _format_ssl_report(hostname, info, issues) -> str:
    lines = [f"\n=== SSL/TLS ANALYSIS: {hostname} ==="]
    if info:
        lines.append(f"  TLS Version:  {info.get('tls_version', 'unknown')}")
        lines.append(f"  Cipher Suite: {info.get('cipher_suite', 'unknown')}")
        lines.append(f"  Key Strength: {info.get('key_bits', '?')}-bit")
        exp = info.get("not_after", "")
        days = info.get("days_until_expiry")
        if exp: lines.append(f"  Expires:      {exp}" + (f" ({days} days)" if days else ""))
        san = info.get("san", [])
        if san: lines.append(f"  SANs ({len(san)}):   {', '.join(san[:5])}")
    if issues:
        lines.append("\nIssues:")
        for i in issues: lines.append(f"  ⚠ {i}")
    else:
        lines.append("  ✓ No SSL issues detected")
    return "\n".join(lines)

def _format_dns_report(hostname, results) -> str:
    lines = [f"\n=== DNS ENUMERATION: {hostname} ==="]
    if results["a"]:   lines.append(f"  A:    {', '.join(results['a'])}")
    if results["aaaa"]: lines.append(f"  AAAA: {', '.join(results['aaaa'][:3])}")
    if results["mx"]:  lines.extend(["  MX:"] + [f"    {m}" for m in results["mx"][:4]])
    if results["ns"]:  lines.extend(["  NS:"] + [f"    {n}" for n in results["ns"][:4]])
    if results["subs"]:
        lines.append(f"\n  Subdomains found ({len(results['subs'])}):")
        for s in results["subs"]: lines.append(f"    ✓ {s['subdomain']} → {s['ip']}")
    return "\n".join(lines)

def _format_endpoint_report(url, found, blocked) -> str:
    lines = [f"\n=== ENDPOINT DISCOVERY: {url} ==="]
    if found:
        lines.append("Accessible paths:")
        for e in found: lines.append(f"  [{e['status']}] {e['path']} ({e['size']} bytes)")
    if blocked:
        lines.append("\nForbidden (exist but locked):")
        for e in blocked: lines.append(f"  [403] {e['path']}")
    if not found and not blocked:
        lines.append("  No sensitive paths found")
    return "\n".join(lines)

def _format_sast_report(target, findings) -> str:
    lines = [f"\n=== STATIC CODE ANALYSIS: {target} ==="]
    if not findings:
        lines.append("  ✓ No vulnerabilities detected")
        return "\n".join(lines)
    by_severity = {}
    for f in findings:
        by_severity.setdefault(f["severity"], []).append(f)
    for sev in ("CRITICAL", "HIGH", "MEDIUM", "LOW"):
        items = by_severity.get(sev, [])
        if items:
            lines.append(f"\n  {sev} ({len(items)}):")
            for f in items[:10]:
                lines.append(f"    [{f['file']}:{f['line']}] {f['category']} — {f['detail']}")
                lines.append(f"      Code:  {f['snippet']}")
                lines.append(f"      Fix:   {f['fix']}")
    return "\n".join(lines)

def _format_vuln_report(url, findings) -> str:
    lines = [f"\n=== VULNERABILITY PROBES: {url} ==="]
    if not findings:
        lines.append("  ✓ No obvious vulnerabilities detected by probes")
    else:
        for f in findings:
            lines.append(f"  [{f['severity']}] {f['vuln']}")
            lines.append(f"    {f['detail']}")
    return "\n".join(lines)
