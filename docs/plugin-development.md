# RelayHall Plugin Development Guide

## Overview

RelayHall supports a plugin system where each plugin runs as its own Docker container. Plugins can expose API endpoints, add sidebar navigation items, and serve their own UI — all integrated seamlessly into the RelayHall dashboard.

## Quick Start

### 1. Create Your Plugin Repository

```bash
mkdir claw-myplugin
cd claw-myplugin
npm init -y  # or use any language/framework you prefer
```

### 2. Create `plugin.json`

Every plugin needs a `plugin.json` manifest at its root:

```json
{
  "name": "claw-myplugin",
  "version": "1.0.0",
  "description": "My awesome RelayHall plugin",

  "docker": {
    "image": "claw-myplugin",
    "build": ".",
    "ports": {
      "3020": "3020"
    },
    "environment": {
      "NODE_ENV": "production",
      "PORT": "3020"
    },
    "networks": ["relayhall"]
  },

  "api": {
    "base_path": "/plugins/myplugin",
    "internal_port": 3020,
    "health": "/health",
    "endpoints": [
      {
        "method": "GET",
        "path": "/data",
        "description": "Get plugin data"
      }
    ]
  },

  "ui": {
    "enabled": true,
    "sidebar": [
      {
        "label": "My Plugin",
        "icon": "box",
        "path": "/myplugin"
      }
    ],
    "routes": [
      {
        "path": "/myplugin",
        "proxy_to": "/ui/"
      }
    ],
    "embedding": "proxy"
  },

  "author": "Your Name",
  "license": "MIT",
  "relayhall": {
    "min_version": "2.0.0",
    "category": "productivity"
  }
}
```

`api.base_path` is not free-form. The loader requires exactly
`/plugins/` followed by the manifest `name` with any leading `claw-` removed —
`/plugins/myplugin` for `claw-myplugin` — and refuses anything else at load
with `Invalid api.base_path …: must be …`, because the proxy is mounted at `/`
and an unconstrained prefix could shadow a core route. nginx strips the `/api`
prefix, so a browser reaches that same plugin at `/api/plugins/myplugin`.

### 3. Implement Health Endpoint

**Required:** Every plugin must expose a health endpoint.

```javascript
// Express example
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});
```

```python
# Flask example
@app.route('/health')
def health():
    return jsonify(status='ok', version='1.0.0')
```

### 4. Create Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3020
CMD ["node", "src/index.js"]
```

### 5. Register in `relayhall.plugins.json`

In your RelayHall deployment repo:

```json
{
  "plugins": [
    {
      "name": "claw-myplugin",
      "source": "./plugins/claw-myplugin",
      "enabled": true,
      "config_override": {}
    }
  ]
}
```

### 6. Start

```bash
docker compose up --build
```

Your plugin's sidebar item will appear automatically in the RelayHall dashboard!

---

## Manifest Schema Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique plugin identifier (kebab-case, e.g., `claw-journal`) |
| `version` | string | Semantic version (e.g., `1.0.0`) |
| `description` | string | Human-readable description |
| `docker.image` | string | Docker image name |
| `docker.ports` | object | Container-to-host port mapping |
| `api.base_path` | string | Proxy prefix. Must be exactly `/plugins/` + the `name` with any leading `claw-` removed — e.g. `/plugins/journal` for `claw-journal`; any other value is refused at load. Browsers reach it at `/api/plugins/journal` because nginx strips `/api`. |
| `api.internal_port` | number | Port the container listens on |
| `api.health` | string | Health check endpoint path (e.g., `/health`) |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `docker.build` | string | `"."` | Docker build context |
| `docker.volumes` | string[] | `[]` | Volume mounts |
| `docker.environment` | object | `{}` | Environment variables |
| `docker.networks` | string[] | `["relayhall"]` | Docker networks |
| `docker.runtime` | string | `null` | Container runtime (e.g., `"nvidia"`) |
| `docker.network_mode` | string | `null` | Network mode (e.g., `"host"`) |
| `ui.enabled` | boolean | `false` | Whether plugin has a UI |
| `ui.sidebar` | array | `[]` | Sidebar navigation items |
| `ui.routes` | array | `[]` | Frontend routes to proxy |
| `ui.embedding` | string | `"proxy"` | UI embedding method |
| `config.schema` | object | – | JSON Schema for plugin config |
| `config.defaults` | object | – | Default config values |
| `agent.tool_name` | string | – | Corresponding Tier 1 tool name |
| `agent.capabilities` | string[] | – | Agent capabilities |
| `relayhall.min_version` | string | – | Minimum RelayHall version |
| `relayhall.category` | string | – | Plugin category |

### Sidebar Item Schema

```json
{
  "label": "Journal",          // Display label
  "icon": "book",              // Lucide icon name
  "path": "/journal",          // Frontend route path
  "badge": null                // Optional: API path for badge count
}
```

---

## Plugin Types

### API-Only Plugin

No UI, just backend endpoints. Good for data services, integrations, GPU workers.

```json
{
  "ui": { "enabled": false }
}
```

### API + UI Plugin

Full-stack plugin with its own frontend and backend.

```json
{
  "ui": {
    "enabled": true,
    "sidebar": [{ "label": "My Plugin", "icon": "box", "path": "/myplugin" }],
    "routes": [{ "path": "/myplugin", "proxy_to": "/ui/" }]
  }
}
```

---

## UI Integration

### How Proxying Works

RelayHall's backend proxies requests to your plugin container:

```
Browser: GET /plugins/myplugin/page
  → RelayHall backend proxy
  → http://claw-myplugin:3020/ui/page
```

### Shared Theme

Import RelayHall's theme stylesheet for styling that matches the host:

```html
<link rel="stylesheet" href="/api/plugins/theme.css">
```

The route is **public** — plugin iframes cannot send an authorization header,
so the stylesheet has to load without one. It publishes only RelayHall's
semantic design tokens; it carries no deployment or principal data.

Tokens are published under the `--rh-` prefix and are **semantic**, never raw
palette values: style against meaning, and your plugin follows the host's Theme
automatically.

```css
.my-panel {
  background: var(--rh-bg-surface);
  color: var(--rh-text-primary);
  border: 1px solid var(--rh-border-default);
  border-radius: var(--rh-radius-md);
  padding: var(--rh-space-4);
  font-family: var(--rh-font-body);
}

.my-panel__danger {
  color: var(--rh-text-error);          /* status colours carry status meaning */
}

.my-panel__cta {
  background: var(--rh-accent-color);   /* brand accent — never for status */
  color: var(--rh-text-on-fill);        /* ink for a FILLED affordance */
}
```

Published groups:

| Group | Tokens |
|---|---|
| Surfaces | `--rh-bg-app`, `--rh-bg-surface`, `--rh-bg-surface-hover`, `--rh-bg-elevated` |
| Text | `--rh-text-primary`, `--rh-text-secondary`, `--rh-text-tertiary`, `--rh-text-quaternary` |
| Status text | `--rh-text-success`, `--rh-text-warning`, `--rh-text-error`, `--rh-text-info`, `--rh-text-accent` |
| Ink on fills | `--rh-text-on-fill` |
| Borders | `--rh-border-subtle`, `--rh-border-default`, `--rh-border-strong` |
| Accent | `--rh-accent-color`, `--rh-accent-hover`, `--rh-accent-active` |
| Status | `--rh-status-success`, `--rh-status-warning`, `--rh-status-danger`, `--rh-status-info`, `--rh-danger-color` |
| Shape and rhythm | `--rh-radius-sm/md/lg`, `--rh-space-2`, `--rh-space-4` |
| Typography | `--rh-font-body`, `--rh-font-mono` |

**Anything you draw on a fill uses `--rh-text-on-fill`, never a text token.**
The accent and status colours are affordance backgrounds; whether their
readable ink is dark or light depends on the Theme, and this token is that
answer. A hard-coded white label lands at 2.26:1 on the default accent.

Request a specific built-in Theme with `?theme=` — the three v1 built-ins are
`relay-dark`, `relay-light` and `high-contrast` (for example
`/api/plugins/theme.css?theme=relay-light`). Every Theme publishes exactly the
same token names, so switching Theme never removes a variable from under you.
Unrecognised names resolve to the deployment's default Theme rather than
failing, so a plugin never renders unstyled.

Two rules keep this contract safe and stable:

- **Semantic tokens only.** Primitive ramps are private to RelayHall and are
  never published; they change without notice.
- **Status colours never double as brand colours.** Use the status group for
  status and the accent group for brand affordances.

### UI Requirements

- Serve frontend at container root (`/`) or `/ui/`
- Use **relative paths** for all assets
- Accept `BASE_PATH` environment variable for URL generation
- Authentication is handled by RelayHall — your plugin receives pre-authenticated requests

---

## Communication

### Plugin → Core API

Access RelayHall's core API via the internal Docker network:

```javascript
const CORE_URL = process.env.RELAYHALL_CORE_URL || 'http://relayhall-backend:3001';
const API_KEY = process.env.RELAYHALL_API_KEY;

const response = await fetch(`${CORE_URL}/tasks`, {
  headers: { 'Authorization': `Bearer ${API_KEY}` }
});
```

### Plugin → Plugin

**Don't.** Plugins should communicate through the core API, not directly. This keeps plugins decoupled.

---

## Configuration

### Plugin Config Schema

Define configurable options in your manifest:

```json
{
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "refresh_interval": {
          "type": "integer",
          "description": "Data refresh interval in seconds"
        }
      }
    },
    "defaults": {
      "refresh_interval": 300
    }
  }
}
```

### Deployment Overrides

Operators can override config in `relayhall.plugins.json`:

```json
{
  "name": "claw-myplugin",
  "source": "./plugins/claw-myplugin",
  "enabled": true,
  "config_override": {
    "config": {
      "refresh_interval": 60
    }
  }
}
```

### Priority Order

```
plugin.json defaults → relayhall.plugins.json overrides → environment variables
```

---

## Naming Conventions

| Type | Pattern | Example |
|------|---------|---------|
| Reusable plugin | `claw-{function}` | `claw-journal`, `claw-monitor` |
| Bot-specific plugin | `{bot}-{function}` | `nim-orb`, `nim-avatar` |
| API base path | `/api/plugins/{short-name}` | `/api/plugins/journal` |
| UI route | `/plugins/{short-name}` | `/plugins/journal` |
| Config dir | `config/{short-name}/` | `config/journal/` |

---

## Checklist

Before releasing your plugin:

- [ ] `plugin.json` at repo root with all required fields
- [ ] Dockerfile builds successfully
- [ ] `/health` endpoint returns `{"status": "ok", "version": "x.x.x"}`
- [ ] README.md with setup instructions
- [ ] If UI: serves frontend, uses relative asset paths
- [ ] If configurable: `config.schema` documents all options
- [ ] Tested with a clean RelayHall installation
