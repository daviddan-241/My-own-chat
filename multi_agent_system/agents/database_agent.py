"""
Database Agent - Real SQLite storage
"""

import json
import os
import sqlite3
import time
from typing import Dict, Any, List
from .base_agent import BaseAgent, Task, AgentStatus

class DatabaseAgent(BaseAgent):
    def __init__(self, db_path: str = "agent_database.db"):
        super().__init__(
            name="DatabaseAgent",
            description="Manages structured data storage"
        )
        self.capabilities = [
            "store_data", "retrieve_data", "update_data",
            "delete_data", "query_data", "backup_data", "create_table"
        ]
        self.db_path = db_path
        self.json_store = {}
        self._init_db()

    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()

        c.execute("""
            CREATE TABLE IF NOT EXISTS agent_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                value TEXT NOT NULL,
                data_type TEXT DEFAULT 'json',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS agent_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_name TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        conn.commit()
        conn.close()

    def execute(self, task: Task) -> Dict[str, Any]:
        self.status = AgentStatus.RUNNING
        action = task.payload.get("action", "store_data")

        try:
            if action == "store_data":
                result = self._store_data(task.payload)
            elif action == "retrieve_data":
                result = self._retrieve_data(task.payload)
            elif action == "update_data":
                result = self._update_data(task.payload)
            elif action == "delete_data":
                result = self._delete_data(task.payload)
            elif action == "query_data":
                result = self._query_data(task.payload)
            elif action == "backup_data":
                result = self._backup_data(task.payload)
            elif action == "create_table":
                result = self._create_table(task.payload)
            else:
                result = {"success": False, "error": f"Unknown action: {action}"}

            self.status = AgentStatus.COMPLETED if result.get("success") else AgentStatus.ERROR
            return result

        except Exception as e:
            self.status = AgentStatus.ERROR
            return {"success": False, "error": str(e)}

    def _store_data(self, payload: Dict) -> Dict[str, Any]:
        key = payload.get("key", "")
        value = payload.get("value")
        data_type = payload.get("data_type", "json")

        if not key:
            return {"success": False, "error": "No key"}

        value_str = json.dumps(value) if data_type == "json" and not isinstance(value, str) else str(value)

        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute("""
            INSERT OR REPLACE INTO agent_data (key, value, data_type, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        """, (key, value_str, data_type))
        conn.commit()
        conn.close()

        self.json_store[key] = value
        return {"success": True, "key": key, "message": "Stored"}

    def _retrieve_data(self, payload: Dict) -> Dict[str, Any]:
        key = payload.get("key", "")
        if not key:
            return {"success": False, "error": "No key"}

        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute("SELECT value, data_type, created_at, updated_at FROM agent_data WHERE key = ?", (key,))
        row = c.fetchone()
        conn.close()

        if row:
            value_str, data_type, created, updated = row
            value = json.loads(value_str) if data_type == "json" else value_str
            return {"success": True, "key": key, "value": value, "created": created, "updated": updated}
        return {"success": False, "error": f"Key '{key}' not found"}

    def _update_data(self, payload: Dict) -> Dict[str, Any]:
        key = payload.get("key", "")
        value = payload.get("value")
        data_type = payload.get("data_type", "json")

        if not key:
            return {"success": False, "error": "No key"}

        value_str = json.dumps(value) if data_type == "json" and not isinstance(value, str) else str(value)

        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute("""
            UPDATE agent_data SET value = ?, data_type = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?
        """, (value_str, data_type, key))
        updated = c.rowcount > 0
        conn.commit()
        conn.close()

        if updated:
            self.json_store[key] = value
            return {"success": True, "message": "Updated"}
        return {"success": False, "error": "Key not found"}

    def _delete_data(self, payload: Dict) -> Dict[str, Any]:
        key = payload.get("key", "")
        if not key:
            return {"success": False, "error": "No key"}

        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute("DELETE FROM agent_data WHERE key = ?", (key,))
        deleted = c.rowcount > 0
        conn.commit()
        conn.close()

        if key in self.json_store:
            del self.json_store[key]

        return {"success": deleted, "message": "Deleted" if deleted else "Not found"}

    def _query_data(self, payload: Dict) -> Dict[str, Any]:
        filters = payload.get("filters", {})
        limit = payload.get("limit", 100)

        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()

        query = "SELECT key, value, data_type, created_at, updated_at FROM agent_data WHERE 1=1"
        params = []

        if "key_prefix" in filters:
            query += " AND key LIKE ?"
            params.append(f"{filters['key_prefix']}%")

        query += " LIMIT ?"
        params.append(limit)

        c.execute(query, params)
        rows = c.fetchall()
        conn.close()

        results = []
        for row in rows:
            key, value_str, data_type, created, updated = row
            value = json.loads(value_str) if data_type == "json" else value_str
            results.append({"key": key, "value": value, "created": created, "updated": updated})

        return {"success": True, "results": results, "count": len(results)}

    def _backup_data(self, payload: Dict) -> Dict[str, Any]:
        backup_path = payload.get("backup_path", f"backup_{int(time.time())}.db")
        import shutil
        shutil.copy2(self.db_path, backup_path)

        json_backup = f"{backup_path}.json"
        with open(json_backup, "w") as f:
            json.dump(self.json_store, f, indent=2, default=str)

        return {"success": True, "backup_path": backup_path, "json_backup": json_backup}

    def _create_table(self, payload: Dict) -> Dict[str, Any]:
        table_name = payload.get("table_name", "")
        columns = payload.get("columns", {})

        if not table_name or not columns:
            return {"success": False, "error": "Need table_name and columns"}

        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        col_defs = ", ".join([f"{name} {dtype}" for name, dtype in columns.items()])
        c.execute(f"CREATE TABLE IF NOT EXISTS {table_name} (id INTEGER PRIMARY KEY AUTOINCREMENT, {col_defs})")
        conn.commit()
        conn.close()

        return {"success": True, "table": table_name, "columns": list(columns.keys())}

    def log_action(self, agent_name: str, action: str, details: str = ""):
        conn = sqlite3.connect(self.db_path)
        c = conn.cursor()
        c.execute("INSERT INTO agent_logs (agent_name, action, details) VALUES (?, ?, ?)",
                  (agent_name, action, details))
        conn.commit()
        conn.close()
