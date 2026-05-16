"""
Shell Agent - Real command execution
"""

import subprocess
import os
import shlex
import time
from typing import Dict, Any, List, Tuple
from .base_agent import BaseAgent, Task, AgentStatus

class ShellAgent(BaseAgent):
    def __init__(self, working_directory: str = "."):
        super().__init__(
            name="ShellAgent",
            description="Executes CLI commands and manages files"
        )
        self.capabilities = [
            "execute_command", "run_script", "manage_files",
            "install_packages", "check_processes", "batch_execute"
        ]
        self.working_directory = working_directory
        self.command_history = []
        self.blocked_commands = []
        self.max_execution_time = 120

    def execute(self, task: Task) -> Dict[str, Any]:
        self.status = AgentStatus.RUNNING
        action = task.payload.get("action", "execute_command")

        try:
            if action == "execute_command":
                result = self._execute_command(task.payload)
            elif action == "run_script":
                result = self._run_script(task.payload)
            elif action == "manage_files":
                result = self._manage_files(task.payload)
            elif action == "install_packages":
                result = self._install_packages(task.payload)
            elif action == "check_processes":
                result = self._check_processes(task.payload)
            elif action == "batch_execute":
                result = self._batch_execute(task.payload)
            else:
                result = {"success": False, "error": f"Unknown action: {action}"}

            self.status = AgentStatus.COMPLETED if result.get("success") else AgentStatus.ERROR
            return result

        except Exception as e:
            self.status = AgentStatus.ERROR
            return {"success": False, "error": str(e)}

    def _is_safe(self, command: str) -> tuple:
        cmd_lower = command.lower().strip()
        for blocked in self.blocked_commands:
            if blocked.lower() in cmd_lower:
                return False, f"Blocked: {blocked}"
        return True, "OK"

    def _execute_command(self, payload: Dict) -> Dict[str, Any]:
        command = payload.get("command", "")
        cwd = payload.get("cwd", self.working_directory)

        if not command:
            return {"success": False, "error": "No command"}

        is_safe, reason = self._is_safe(command)
        if not is_safe:
            return {"success": False, "error": reason}

        start = time.time()
        try:
            result = subprocess.run(
                command, shell=True, capture_output=True, text=True,
                cwd=cwd, timeout=self.max_execution_time
            )
            elapsed = time.time() - start

            self.command_history.append({
                "command": command, "returncode": result.returncode,
                "time": elapsed
            })

            return {
                "success": result.returncode == 0,
                "command": command,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "returncode": result.returncode,
                "time": round(elapsed, 3)
            }
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Timed out"}

    def _run_script(self, payload: Dict) -> Dict[str, Any]:
        script = payload.get("script_path", "")
        interpreter = payload.get("interpreter", "python3")
        args = payload.get("args", [])

        if not os.path.exists(script):
            return {"success": False, "error": f"Not found: {script}"}

        cmd = f"{interpreter} {script}"
        if args:
            cmd += " " + " ".join(shlex.quote(a) for a in args)
        return self._execute_command({"command": cmd})

    def _manage_files(self, payload: Dict) -> Dict[str, Any]:
        op = payload.get("operation", "list")
        path = payload.get("path", ".")

        try:
            if op == "list":
                items = []
                for item in os.listdir(path):
                    fp = os.path.join(path, item)
                    items.append({
                        "name": item,
                        "type": "dir" if os.path.isdir(fp) else "file",
                        "size": os.path.getsize(fp) if os.path.isfile(fp) else None
                    })
                return {"success": True, "items": items}
            elif op == "create_dir":
                os.makedirs(path, exist_ok=True)
                return {"success": True, "message": f"Created {path}"}
            elif op == "read":
                with open(path, "r") as f:
                    return {"success": True, "content": f.read()}
            elif op == "write":
                with open(path, "w") as f:
                    f.write(payload.get("content", ""))
                return {"success": True, "message": f"Written {path}"}
            elif op == "remove":
                if os.path.isdir(path):
                    os.rmdir(path)
                else:
                    os.remove(path)
                return {"success": True, "message": f"Removed {path}"}
            else:
                return {"success": False, "error": f"Unknown op: {op}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def _install_packages(self, payload: Dict) -> Dict[str, Any]:
        packages = payload.get("packages", [])
        manager = payload.get("manager", "pip")

        if not packages:
            return {"success": False, "error": "No packages"}

        if manager == "pip":
            cmd = f"pip install {' '.join(packages)}"
        elif manager == "npm":
            cmd = f"npm install {' '.join(packages)}"
        else:
            return {"success": False, "error": f"Unknown manager: {manager}"}

        return self._execute_command({"command": cmd})

    def _check_processes(self, payload: Dict) -> Dict[str, Any]:
        filt = payload.get("filter", "")
        cmd = "ps aux"
        if filt:
            cmd += f" | grep {filt}"
        return self._execute_command({"command": cmd})

    def _batch_execute(self, payload: Dict) -> Dict[str, Any]:
        commands = payload.get("commands", [])
        stop_on_error = payload.get("stop_on_error", True)

        results = []
        for cmd in commands:
            r = self._execute_command({"command": cmd})
            results.append(r)
            if stop_on_error and not r.get("success"):
                break

        return {
            "success": all(r.get("success") for r in results),
            "results": results,
            "executed": len(results)
        }
