"""
Coder Agent - Real code writing, review, debugging
"""

import subprocess
import os
import re
import tempfile
import time
from typing import Dict, Any, List
from .base_agent import BaseAgent, Task, AgentStatus

class CoderAgent(BaseAgent):
    def __init__(self):
        super().__init__(
            name="CoderAgent",
            description="Writes, reviews, and debugs code"
        )
        self.capabilities = [
            "write_code", "review_code", "debug_code",
            "refactor_code", "generate_tests", "fix_syntax_errors"
        ]
        self.code_memory = {}

    def execute(self, task: Task) -> Dict[str, Any]:
        self.status = AgentStatus.RUNNING
        action = task.payload.get("action", "write_code")

        try:
            if action == "write_code":
                result = self._write_code(task.payload)
            elif action == "review_code":
                result = self._review_code(task.payload)
            elif action == "debug_code":
                result = self._debug_code(task.payload)
            elif action == "refactor_code":
                result = self._refactor_code(task.payload)
            elif action == "generate_tests":
                result = self._generate_tests(task.payload)
            elif action == "fix_syntax_errors":
                result = self._fix_syntax_errors(task.payload)
            else:
                result = {"success": False, "error": f"Unknown action: {action}"}

            self.status = AgentStatus.COMPLETED if result.get("success") else AgentStatus.ERROR
            return result

        except Exception as e:
            self.status = AgentStatus.ERROR
            return {"success": False, "error": str(e)}

    def _write_code(self, payload: Dict) -> Dict[str, Any]:
        filename = payload.get("filename", "generated.py")
        code = payload.get("code", "")

        os.makedirs(os.path.dirname(filename) if os.path.dirname(filename) else ".", exist_ok=True)

        with open(filename, "w") as f:
            f.write(code)

        self.code_memory[filename] = {"code": code, "timestamp": time.time()}

        return {
            "success": True,
            "filename": filename,
            "lines": len(code.splitlines()),
            "message": f"Written {len(code)} chars to {filename}"
        }

    def _review_code(self, payload: Dict) -> Dict[str, Any]:
        filename = payload.get("filename")
        code = payload.get("code", "")

        if filename and os.path.exists(filename):
            with open(filename, "r") as f:
                code = f.read()

        issues = []
        lines = code.splitlines()

        for i, line in enumerate(lines, 1):
            if "TODO" in line:
                issues.append({"line": i, "type": "TODO", "message": line.strip()})
            if "FIXME" in line:
                issues.append({"line": i, "type": "FIXME", "message": line.strip()})
            if "print(" in line and "debug" not in line.lower():
                issues.append({"line": i, "type": "DEBUG_PRINT", "message": "Remove debug print"})
            if len(line) > 120:
                issues.append({"line": i, "type": "LONG_LINE", "message": f"Line too long ({len(line)} chars)"})

        return {
            "success": True,
            "filename": filename,
            "issues": issues,
            "issue_count": len(issues),
            "quality_score": max(0, 100 - len(issues) * 5)
        }

    def _debug_code(self, payload: Dict) -> Dict[str, Any]:
        filename = payload.get("filename")
        code = payload.get("code", "")

        if filename and os.path.exists(filename):
            with open(filename, "r") as f:
                code = f.read()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(code)
            temp_path = f.name

        try:
            result = subprocess.run(
                ["python3", temp_path],
                capture_output=True, text=True, timeout=10
            )
            os.remove(temp_path)

            if result.returncode != 0:
                return {
                    "success": False,
                    "error": result.stderr,
                    "stdout": result.stdout,
                    "fixes_needed": True,
                    "suggestion": self._suggest_fix(result.stderr)
                }
            return {"success": True, "output": result.stdout}

        except subprocess.TimeoutExpired:
            os.remove(temp_path)
            return {"success": False, "error": "Execution timed out"}

    def _refactor_code(self, payload: Dict) -> Dict[str, Any]:
        filename = payload.get("filename")
        code = payload.get("code", "")

        if filename and os.path.exists(filename):
            with open(filename, "r") as f:
                code = f.read()

        lines = code.splitlines()
        cleaned = "\n".join(line.rstrip() for line in lines)

        if filename:
            with open(filename, "w") as f:
                f.write(cleaned)

        return {"success": True, "message": "Code refactored", "lines": len(lines)}

    def _generate_tests(self, payload: Dict) -> Dict[str, Any]:
        filename = payload.get("filename")
        code = payload.get("code", "")

        if filename and os.path.exists(filename):
            with open(filename, "r") as f:
                code = f.read()

        functions = re.findall(r'def\s+(\w+)\s*\(', code)

        test_code = '"""Tests for ' + (filename or "module") + '"""\nimport unittest\n\n'
        for func in functions:
            test_code += 'class Test' + func.title() + '(unittest.TestCase):\n'
            test_code += '    def test_' + func + '(self):\n'
            test_code += '        # TODO: Implement test\n'
            test_code += '        pass\n\n'
        test_code += "if __name__ == '__main__':\n    unittest.main()\n"

        test_file = "test_" + filename if filename else "test_generated.py"
        with open(test_file, "w") as f:
            f.write(test_code)

        return {"success": True, "test_file": test_file, "tests_generated": len(functions)}

    def _fix_syntax_errors(self, payload: Dict) -> Dict[str, Any]:
        filename = payload.get("filename")
        code = payload.get("code", "")

        if filename and os.path.exists(filename):
            with open(filename, "r") as f:
                code = f.read()

        import py_compile
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(code)
            temp_path = f.name

        try:
            py_compile.compile(temp_path, doraise=True)
            os.remove(temp_path)
            return {"success": True, "message": "No syntax errors"}
        except py_compile.PyCompileError as e:
            os.remove(temp_path)
            return {"success": False, "error": str(e), "fixes_needed": True}

    def _suggest_fix(self, error: str) -> str:
        if "NameError" in error:
            return "Check for undefined variables"
        elif "SyntaxError" in error:
            return "Check syntax - missing colons, quotes, or parentheses"
        elif "IndentationError" in error:
            return "Fix indentation"
        elif "TypeError" in error:
            return "Check variable types"
        return "Review error and fix accordingly"
