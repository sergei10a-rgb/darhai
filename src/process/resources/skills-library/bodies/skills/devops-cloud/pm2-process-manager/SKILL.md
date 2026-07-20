---
name: pm2-process-manager
description: |
  Detects a project's frontend, backend, and database services, then generates a PM2 ecosystem configuration and service-management commands, with Windows-specific handling for Node.js interpreters and Python wrapper scripts.
  Use when the user wants to run multiple local dev services under PM2, generate an ecosystem config file, or manage several long-running processes with single commands.
  Do NOT use for production container orchestration (use Kubernetes or Docker Compose instead) or for a single-process app that a plain dev script already covers.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "pm2 process-management dev-environment nodejs windows"
  category: "devops-cloud"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# PM2 Process Manager

Auto-analyze a project and generate a PM2 configuration plus service-management commands for detected frontend, backend, and database services.

## Workflow

1. Check that PM2 is installed (`pm2 --version`); install with `npm install -g pm2` if missing.
2. Scan the project to identify services (frontend / backend / database).
3. Generate an ecosystem config file and, where needed, wrapper scripts.
4. Document the resulting service commands in the project's agent guide.

## Service Detection

| Type | Detection | Default Port |
|------|-----------|--------------|
| Vite | `vite.config.*` | 5173 |
| Next.js | `next.config.*` | 3000 |
| Nuxt | `nuxt.config.*` | 3000 |
| CRA | `react-scripts` in `package.json` | 3000 |
| Express/Node | `server`/`backend`/`api` directory + `package.json` | 3000 |
| FastAPI/Flask | `requirements.txt` / `pyproject.toml` | 8000 |
| Go | `go.mod` / `main.go` | 8080 |

**Port detection priority**: user-specified > `.env` > config file > script args > default port.

## Windows Configuration

### ecosystem.config.cjs

Use the `.cjs` extension so PM2 loads it as CommonJS regardless of the project's `"type": "module"` setting.

```javascript
module.exports = {
  apps: [
    // Node.js (Vite / Next / Nuxt)
    {
      name: 'project-3000',
      cwd: './packages/web',
      script: 'node_modules/vite/bin/vite.js',
      args: '--port 3000',
      interpreter: 'C:/Program Files/nodejs/node.exe',
      env: { NODE_ENV: 'development' }
    },
    // Python
    {
      name: 'project-8000',
      cwd: './backend',
      script: 'start.cjs',
      interpreter: 'C:/Program Files/nodejs/node.exe',
      env: { PYTHONUNBUFFERED: '1' }
    }
  ]
}
```

**Framework script paths:**

| Framework | script | args |
|-----------|--------|------|
| Vite | `node_modules/vite/bin/vite.js` | `--port {port}` |
| Next.js | `node_modules/next/dist/bin/next` | `dev -p {port}` |
| Nuxt | `node_modules/nuxt/bin/nuxt.mjs` | `dev --port {port}` |
| Express | `src/index.js` or `server.js` | - |

### Python Wrapper Script (start.cjs)

PM2 on Windows launches Python most reliably through a small Node.js wrapper that spawns the interpreter directly:

```javascript
const { spawn } = require('child_process');
const proc = spawn('python', ['-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', '8000', '--reload'], {
  cwd: __dirname, stdio: 'inherit', windowsHide: true
});
proc.on('close', (code) => process.exit(code));
```

## Helper Scripts

Generate small platform helper scripts alongside the config so common actions are one command. Example PowerShell helpers:

```powershell
# pm2-logs.ps1
Set-Location "{PROJECT_ROOT}"
pm2 logs {name}
```

```powershell
# pm2-monit.ps1
Set-Location "{PROJECT_ROOT}"
pm2 monit
```

To open a service in its own terminal window on Windows:

```bash
start wt.exe -d "{PROJECT_ROOT}" pwsh -NoExit -c "pm2 logs {name}"
```

## Terminal Commands

```bash
pm2 start ecosystem.config.cjs   # First time (with config file)
pm2 save                         # Persist the process list
pm2 start all                    # After first save
pm2 stop all / pm2 restart all
pm2 start {name} / pm2 stop {name}
pm2 logs / pm2 status / pm2 monit
pm2 resurrect                    # Restore the saved list
```

## Key Rules

1. **Config file**: `ecosystem.config.cjs` (not `.js`) to avoid ESM/CJS loader conflicts.
2. **Node.js apps**: specify the bin path directly and set `interpreter` to the Node executable.
3. **Python apps**: use a Node.js wrapper script with `windowsHide: true`.
4. **New window**: `start wt.exe -d "{path}" pwsh -NoExit -c "command"`.
5. **Persist once**: run `pm2 save` after the first start so `pm2 resurrect` works.

## Post-Init: Document Services

After generating the config, append a PM2 section to the project's agent guide (for example `AGENTS.md`), replacing any existing PM2 section:

```markdown
## PM2 Services

| Port | Name | Type |
|------|------|------|
| {port} | {name} | {type} |

**Terminal commands:**
pm2 start ecosystem.config.cjs   # First time
pm2 start all                    # After first save
pm2 stop all / pm2 restart all
pm2 logs / pm2 status / pm2 monit
pm2 save / pm2 resurrect
```

Keep the section minimal and essential.

## When to Use

- Running several local dev services (web + API + worker) under one supervisor
- Generating a reproducible `ecosystem.config.cjs` for a mixed Node/Python project
- Standardizing start/stop/logs/monitor commands on Windows

## Edge Cases

- **Monorepo with many apps**: set each app's `cwd` to its package directory and give each a unique `name` and port.
- **Port already in use**: honor the detection priority and let the user override; never silently reuse a busy port.
- **Non-Windows hosts**: drop the explicit `interpreter` path and `windowsHide` flag; PM2 resolves `node`/`python` from `PATH`.
