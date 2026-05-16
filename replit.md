# My-own-chat

A multi-agent AI chat application with a Flask backend, featuring a full-featured chat UI, real-time streaming responses, file uploads, terminal access, and GitHub push support.

## Run & Operate

- **Start**: `bash run_flask.sh` (gunicorn on port 5000)
- **Direct dev**: `cd multi_agent_system && python app.py`
- **Required env vars**: `AI_INTEGRATIONS_OPENAI_API_KEY`, `AI_INTEGRATIONS_OPENAI_BASE_URL` (Replit AI integration), optionally `GITHUB_PERSONAL_ACCESS_TOKEN`

## Stack

- Python 3.12, Flask 3.x, Flask-CORS, Gunicorn (gthread worker)
- OpenAI Python SDK (pointed at Replit AI integration endpoint)
- Vanilla JS frontend (no build step), Jinja2 templates
- No database (in-memory session/task storage)

## Where things live

- `multi_agent_system/app.py` — Flask app, all API routes
- `multi_agent_system/agents/` — agent classes (coordinator, coder, shell, console, database, security)
- `multi_agent_system/templates/index.html` — single-page chat UI
- `multi_agent_system/static/css/style.css` — styles
- `multi_agent_system/static/js/app.js` — frontend logic
- `multi_agent_system/workflows/` — workflow engine
- `run_flask.sh` — production startup script

## Architecture decisions

- CoordinatorAgent uses Replit AI integration (OpenAI-compatible) with model auto-escalation: gpt-5 → gpt-5-mini → gpt-5-nano
- Background task system with TaskBuffer allows chat tasks to survive client disconnect and be re-streamed via SSE
- All AI tool calls (run_shell, run_code, web_search) are executed server-side in real subprocess calls
- File uploads saved to `multi_agent_system/uploads/` with UUID-prefixed names; ZIPs auto-extracted

## Product

- Chat UI with real-time streaming AI responses
- File/image upload support with vision analysis
- Built-in terminal panel for direct shell command execution
- Chat history drawer with multiple conversation support
- Live preview modal for AI-generated HTML
- GitHub push button to sync code to repository
- Background task mode: tasks survive page refresh/disconnect

## User preferences

_Populate as you build_

## Gotchas

- `lsof` is not available in this Nix environment; the `kill $(lsof -ti:5000)` in `run_flask.sh` will fail silently (harmless)
- AI is disabled (`ai_enabled: false`) until Replit AI integration is connected via environment variables
- The app runs from inside `multi_agent_system/` directory (gunicorn `cwd` is set there)

## Pointers

- Replit AI integration setup: `.local/skills/integrations/SKILL.md`
- Deployment: `.local/skills/deployment/SKILL.md`
