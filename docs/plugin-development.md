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
    "min_version": "1.0.0-beta.56",
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

The host probes the endpoint once a minute with a 15-second bound, never follows
a redirect, and reads at most 1 MiB of the answer. Health is decided like this:

| Answer | Health | Operator log line |
|---|---|---|
| 2xx, JSON object, `status` one of `ok`, `healthy`, `up`, `pass`, `passing`, `ready` | healthy | none |
| 2xx, `status` one of `error`, `unhealthy`, `down`, `fail`, `failed`, `failing`, `unavailable`, `degraded` | unhealthy | `kind=plugin_reported detail=STATUS_REPORTED_UNHEALTHY` |
| 2xx with any other body (not JSON, no string `status`, another word, empty, over 1 MiB) | healthy | a warning, `kind=shape` with the detail |
| any other HTTP status | unhealthy | `kind=plugin_reported detail=HTTP_STATUS_NOT_OK http=<status>` |
| 3xx | unhealthy | `kind=redirect` |
| no answer: refused, unresolved, reset, closed | unhealthy | `kind=transport` with `CONNECTION_REFUSED`, `HOST_NOT_FOUND`, `CONNECTION_RESET`, `HOST_UNREACHABLE`, `CONNECT_TIMEOUT`, `SOCKET_CLOSED` or `TRANSPORT_OTHER` |
| no answer within the bound | unhealthy | `kind=timeout` |

Every line starts `[PluginLoader] plugin health check failed plugin=<installation>`
and carries only those closed codes, the HTTP status number and a fresh id: never
a host, a port, a header, a body or message text. The line is written when the
outcome changes and again every 30th identical minute; a recovery writes
`plugin health restored`. A `connection refused` means the backend container
could not reach the health port: check the published port, the bind address
(a service bound to loopback only is unreachable from another container) and
the installation's network mode, not the answer body.

### 4. Create Dockerfile

```dockerfile
# An exact patched Node release, pinned by digest
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
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
| `ui.sidebar_widget` | object | – | `rh.plugin/1` sidebar widget: `{path, height, grow?, frame?}`. `height` is an integer 48..240; see [Frame sizing](#frame-sizing) and [Sidebar section frame](#sidebar-section-frame) |
| `ui.sidebar_widget.grow` | boolean | `false` | Opt in to growing past the declared height to fit the content the widget reports, up to the host ceiling of 1600 px; any value other than a boolean refuses the installation (`PLUGIN_SIDEBAR_WIDGET_INVALID`) |
| `ui.sidebar_widget.frame` | string | – | Opt in to being drawn as a sidebar section instead of a boxed block. The only accepted value is `"section"`; absence is the boxed block, and any other value refuses the installation (`PLUGIN_SIDEBAR_WIDGET_INVALID`) |
| `config.schema` | object | – | JSON Schema for plugin config |
| `config.defaults` | object | – | Default config values |
| `agent.tool_name` | string | – | Corresponding Tier 1 tool name |
| `agent.capabilities` | string[] | – | Agent capabilities |
| `relayhall.min_version` | string | – | Minimum RelayHall release version (strict SemVer). Enforced for `rh.plugin/1` installations against the version the backend reports; advisory for legacy manifests |
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

### Account access (installed `rh.plugin/1` plugins)

Who may use an installed plugin is deployment configuration, read from
`relayhall.plugins.json` when the backend starts. Each installation's `access`
block holds an optional deployment default and the per-Account list:

```json
{
  "name": "example-plugin",
  "source": "./plugins/example-plugin",
  "enabled": true,
  "access": {
    "default": ["view"],
    "accounts": {
      "<Account UUID>": ["view", "generate"]
    },
    "assertion_key_env": "EXAMPLE_PLUGIN_ASSERTION_KEY"
  }
}
```

- `default` is the capability set every active Account holds. It is absent,
  `[]` or exactly `["view"]`; any other value (another capability, a string, a
  duplicate) refuses that installation at load, like the file's other invalid
  fields, so the plugin is not served at all.
- With `"default": ["view"]` every active Account sees the plugin: it is listed
  by `GET /api/plugins`, its `view` settings entries are shown, the host bridge
  serves it, and GET/HEAD requests behind a `view` allow rule pass the proxy.
- The default never grants anything else. Every non-view capability (for
  example `generate` or `manage`), every settings entry behind one, and every
  write through the host proxy (POST, PUT, PATCH, DELETE) need the capability
  in that Account's own `accounts` entry. `hostProxyAccess.writeCapable` and
  each settings entry's `readOnly` flag are computed from the explicit entries
  only.
- `GET /api/plugins` marks every listed settings entry `readOnly: true` unless
  this Account can change it: a POST, PUT, PATCH or DELETE rule that the proxy
  selects for the entry's own path needs a non-view capability held in the
  Account's `accounts` entry (and the caller needs `services:write` or `root`).
  The Settings hub says per entry whether the Account can change it. To make a
  settings page changeable, declare the write rule on its path (or a prefix of
  it) under a non-view capability and grant that capability; a page that is
  only ever viewed needs no write rule.
- `accounts` keeps working as before: an entry adds capabilities to the
  default, and without a default the list is exact (an Account with no entry
  sees nothing). An entry cannot remove the default's `view`; to limit view to
  named Accounts, leave `default` out.
- A request without an active Account (no Account, or a disabled one) gets
  nothing from the default.

The file is read at start, so a change takes effect when the backend restarts.
The [plugin host contract](contracts/plugin-host-v1.md) describes the
assertion each proxied request carries.

---

## Host-stored settings and availability (installed `rh.plugin/1` plugins)

- Declare the settings the host should store in `ui.settings_schema` (a closed
  set of types; see `docs/contracts/plugin-host-v1.md`). The host renders the
  form in the Settings hub (My plugins for each person, Plugin administration
  for administrators), validates every value, resolves the effective value per
  Account and hands it to your frame in the bridge (`settings`) and to your
  backend through `GET /plugin-host/<name>/settings/effective` with the
  `X-RelayHall-Assertion` you received.
- Mark internal values (endpoints, model names) `deliver: "backend"`: they never
  reach the browser. Keep credentials in your own installer configuration and
  describe them with a `secret` setting; the host stores none.
- Give each installation its own assertion key: two installations sharing a key
  variable or a key value are refused at load.
- Administrators decide whether your plugin is required, on by default,
  available on request or disabled for everyone; a hidden plugin's routes,
  bridge and proxy answer 404 to that Account. Your installation's capability
  grants are unchanged by this: availability only narrows.

## Upgrade compatibility (installed `rh.plugin/1` plugins)

These host rules decide whether an installation loads and how its proxied traffic behaves across RelayHall upgrades. The [plugin host contract](contracts/plugin-host-v1.md#upgrade-compatibility) is the normative text.

### Declared minimum host version

For `rh.plugin/1`, a declared `relayhall.min_version` is enforced against the release identity the backend reports (`RELAYHALL_VERSION`: the version shown by `GET /api/`, OpenAPI and MCP), never the backend `package.json` base version, before registration or health probes. A malformed minimum (not strict SemVer, or longer than 160 characters), a host that reports no valid version, or a host below the minimum refuses the installation. SemVer precedence applies: a prerelease does not satisfy its stable release (`1.0.0-beta.56` is below `1.0.0`), numeric identifiers compare as numbers (`1.0.0-beta.9` is below `1.0.0-beta.56`) and build metadata does not change precedence. A legacy manifest's `min_version` stays advisory. Use `relayhall.api_version` for the host API contract and do not infer a version from a phase name or commit identifier.

A refused installation is absent from `GET /api/plugins`, and the backend log names the refusal with a fixed reason code, for example `[PluginLoader] plugin load failed reason=PLUGIN_MIN_VERSION_UNSATISFIED` (`PLUGIN_MIN_VERSION_MALFORMED` for a malformed minimum, `PLUGIN_ALLOW_PATH_NOT_CANONICAL` for a trailing-slash allow path). The log line never repeats the refusal text or the manifest value.

### Canonical allow paths

For `rh.plugin/1`, proxy allowlist paths use canonical slash boundaries: `/` is allowed, but other paths must not end in `/`. A protected prefix such as `/private` covers `/private` and `/private/child`, and excludes `/private-sibling`. The loader rejects `/private/` before health checks or proxy registration; it does not silently rewrite installation policy.

### Streaming and conditional media ranges

The host proxy forwards `Range` and `If-Range` together so the plugin can return a complete representation when the client validator is stale, or a partial representation when it matches. It preserves the upstream status, `Content-Range`, `Content-Length`, `Accept-Ranges` and `ETag` response headers. Response bodies are piped as a stream; an event stream can deliver a chunk before the upstream response ends. These transport behaviors retain the existing caller authorization and credential stripping.

If the upstream stream aborts or fails after response headers, the host closes the downstream connection as an incomplete transfer instead of ending it cleanly. Cancelling the client response closes the upstream connection. An upstream failure before headers retains the generic unavailable response.

### Frame sizing

A plugin UI route and the Settings hub frame fill the space the host gives them; the host does not resize them from an `iframeResize` message, so a full-page UI scrolls within its own document. Only the sidebar widget honours a received `iframeResize` height, clamped between 48 and its declared `ui.sidebar_widget.height`.

A sidebar widget whose content can be longer than 240 px (one row per account, for example) opts in with `"grow": true`:

```json
"sidebar_widget": { "path": "/widget", "height": 240, "grow": true }
```

The widget starts at its declared height, and after each `iframeResize` it is sized to the reported height, rounded up and clamped between 48 and the host ceiling of 1600 px. Report the height of the content itself after layout (for example the bounding height of a wrapper around it, or `document.body.scrollHeight` with no body margin) so the frame never needs a scroll bar of its own; `document.documentElement.scrollHeight` never reports less than the frame's current height, so a widget that measures it can grow but never shrink back. The sidebar column scrolls as a whole when the widgets are taller than the window. A report above the ceiling is clamped to it, so content taller than 1600 px scrolls inside the frame. The declared height is still bounded to 48..240, and the widget returns to it when its document reloads. Resize messages are accepted only from the widget's own frame at the board's origin, as for every widget. Without `grow` nothing changes. A host older than this field ignores it and keeps the declared-height clamp, so a widget that needs it can also set `relayhall.min_version`.

### Sidebar section frame

By default the host draws a sidebar widget as a boxed block: a border, a background and a little padding around a folding label and the frame. A widget whose rows should use the full sidebar width, and read as one more section of the sidebar rather than as a card, opts in with `"frame": "section"`:

```json
"sidebar_widget": { "path": "/widget", "height": 240, "grow": true, "frame": "section" }
```

The host then draws a folding heading in the style of the navigation group headings, with the frame directly under it at the full width of the sidebar: no border, no background, no radius and no inner padding, so the page inside the frame can use the width the box would have taken. The heading is still the disclosure control, with `aria-expanded` and `aria-controls`; the folded state is remembered per widget exactly as before; and the declared height bound, `grow`, the sandbox and the resize checks are unchanged. The value is the exact string `section`: absence keeps the boxed block, and any other value (another case, a boolean, a number, `null`, an object) refuses the installation. The option is per widget, so other plugins' widgets and the identity widget are not affected. The host draws no panel of its own behind the frame: the frame element is transparent and the body the heading controls paints no background, so the sidebar's own background shows through a page that sets none. A browser paints an opaque backdrop behind an iframe whose document declares a colour scheme other than the iframe element's (a page with `color-scheme: dark` in an element left at `normal` sits on a darker panel), so the host reads the scheme your page declares, its `color-scheme` or, when that is `normal`, its `<meta name="color-scheme">`, when the frame loads and after each `iframeResize`, and gives the element the same value. A page that paints its own `html` or `body` background keeps it, and a widget that wants the sidebar to show through should leave that background unset (`transparent`). The body also takes the same 10 px side inset as the navigation group headings, so the heading text, the first column of your page (which begins at 0 inside the frame) and the menu share one left edge; the frame is therefore 20 px narrower than the sidebar's content. Take the ink and the font from the `--rh-text-*` and `--rh-font-body` tokens, not from literals, so the rows read as the menu does in every Theme. On the 96 px compact rail widgets are hidden, as before. A host older than this field ignores it and draws the boxed block, so a widget that needs the extra width inside a box should still lay out sensibly there.

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
