"""
Console Agent - Real output capture and monitoring
"""

import subprocess
import threading
import queue
import time
from typing import Dict, Any, List
from .base_agent import BaseAgent, Task, AgentStatus

class ConsoleAgent(BaseAgent):
    def __init__(self, max_buffer: int = 10000):
        super().__init__(
            name="ConsoleAgent",
            description="Captures and monitors terminal output"
        )
        self.capabilities = [
            "capture_output", "monitor_process", "stream_output",
            "format_display", "log_session", "search_output"
        ]
        self.output_buffer = []
        self.max_buffer = max_buffer
        self.active_monitors = {}
        self.output_queues = {}
        self.logs = []

    def execute(self, task: Task) -> Dict[str, Any]:
        self.status = AgentStatus.RUNNING
        action = task.payload.get("action", "capture_output")

        try:
            if action == "capture_output":
                result = self._capture_output(task.payload)
            elif action == "monitor_process":
                result = self._monitor_process(task.payload)
            elif action == "stream_output":
                result = self._stream_output(task.payload)
            elif action == "format_display":
                result = self._format_display(task.payload)
            elif action == "log_session":
                result = self._log_session(task.payload)
            elif action == "search_output":
                result = self._search_output(task.payload)
            else:
                result = {"success": False, "error": f"Unknown action: {action}"}

            self.status = AgentStatus.COMPLETED if result.get("success") else AgentStatus.ERROR
            return result

        except Exception as e:
            self.status = AgentStatus.ERROR
            return {"success": False, "error": str(e)}

    def _capture_output(self, payload: Dict) -> Dict[str, Any]:
        command = payload.get("command", "")
        if not command:
            return {"success": False, "error": "No command"}

        try:
            proc = subprocess.Popen(
                command, shell=True, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, bufsize=1
            )

            output_lines = []
            for line in iter(proc.stdout.readline, ''):
                line = line.rstrip()
                output_lines.append(line)
                self._add_to_buffer({"type": "stdout", "content": line, "time": time.time()})

            proc.wait()

            return {
                "success": proc.returncode == 0,
                "command": command,
                "output": "\n".join(output_lines),
                "lines": len(output_lines),
                "returncode": proc.returncode
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _monitor_process(self, payload: Dict) -> Dict[str, Any]:
        command = payload.get("command", "")
        monitor_id = payload.get("monitor_id", f"mon_{int(time.time())}")

        if not command:
            return {"success": False, "error": "No command"}

        proc = subprocess.Popen(
            command, shell=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1
        )

        self.active_monitors[monitor_id] = proc
        self.output_queues[monitor_id] = queue.Queue()

        def read_stream(stream, stype):
            for line in iter(stream.readline, ''):
                entry = {"type": stype, "content": line.rstrip(), "time": time.time()}
                self.output_queues[monitor_id].put(entry)
                self._add_to_buffer(entry)

        threading.Thread(target=read_stream, args=(proc.stdout, "stdout"), daemon=True).start()
        threading.Thread(target=read_stream, args=(proc.stderr, "stderr"), daemon=True).start()

        return {"success": True, "monitor_id": monitor_id, "pid": proc.pid}

    def _stream_output(self, payload: Dict) -> Dict[str, Any]:
        monitor_id = payload.get("monitor_id", "")
        max_lines = payload.get("max_lines", 100)

        if monitor_id not in self.output_queues:
            return {"success": False, "error": f"Monitor {monitor_id} not found"}

        lines = []
        q = self.output_queues[monitor_id]
        try:
            for _ in range(max_lines):
                lines.append(q.get(timeout=5))
        except queue.Empty:
            pass

        return {"success": True, "lines": lines, "count": len(lines)}

    def _format_display(self, payload: Dict) -> Dict[str, Any]:
        output = payload.get("output", "")
        fmt = payload.get("format", "plain")

        if fmt == "json":
            try:
                import json
                parsed = json.loads(output)
                return {"success": True, "formatted": json.dumps(parsed, indent=2), "type": "json"}
            except:
                return {"success": False, "error": "Invalid JSON"}
        elif fmt == "markdown":
            return {"success": True, "formatted": f"```\n{output}\n```", "type": "markdown"}

        return {"success": True, "formatted": output, "type": "plain"}

    def _log_session(self, payload: Dict) -> Dict[str, Any]:
        name = payload.get("session_name", f"sess_{int(time.time())}")
        entries = payload.get("entries", self.output_buffer[-100:])

        log = {"name": name, "time": time.time(), "entries": entries}
        self.logs.append(log)

        log_file = f"console_log_{name}.json"
        import json
        with open(log_file, "w") as f:
            json.dump(log, f, indent=2, default=str)

        return {"success": True, "log_file": log_file, "entries": len(entries)}

    def _search_output(self, payload: Dict) -> Dict[str, Any]:
        pattern = payload.get("pattern", "").lower()
        if not pattern:
            return {"success": False, "error": "No pattern"}

        matches = [e for e in self.output_buffer if pattern in e.get("content", "").lower()]
        return {"success": True, "matches": matches[:50], "count": len(matches)}

    def _add_to_buffer(self, entry: Dict):
        self.output_buffer.append(entry)
        if len(self.output_buffer) > self.max_buffer:
            self.output_buffer = self.output_buffer[-self.max_buffer:]

    def stop_monitor(self, monitor_id: str):
        if monitor_id in self.active_monitors:
            self.active_monitors[monitor_id].terminate()
            del self.active_monitors[monitor_id]
            if monitor_id in self.output_queues:
                del self.output_queues[monitor_id]
            return {"success": True}
        return {"success": False, "error": "Not found"}
