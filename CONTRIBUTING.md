# Contributing to RelayHall

## Upstream / Downstream Workflow

RelayHall is designed to be forked for custom deployments. The recommended workflow keeps your private customizations separate from the core while still pulling upstream updates.

### Architecture

```
┌──────────────────────────────────────────────────┐
│              RelayHall (upstream)                 │
│  github.com/relayhall/relayhall.git                 │
│  • Core dashboard features                       │
│  • Plugin system                                 │
│  • Generic, no deployment-specific code          │
│  • Tags: v1.0.0, v2.0.0, etc.                  │
└──────────────────────┬───────────────────────────┘
                       │ fork
                       ▼
┌──────────────────────────────────────────────────┐
│          Your Deployment (downstream)            │
│  git.example.com/YourOrg/my-dashboard.git        │
│  • Custom branding (relayhall.config.json)       │
│  • Plugin configuration (relayhall.plugins.json) │
│  • Deployment-specific docker-compose            │
│  • Plugin source repos as submodules/clones      │
└──────────────────────────────────────────────────┘
```

### Setting Up Your Fork

```bash
# 1. Clone RelayHall as your starting point
git clone https://github.com/relayhall/relayhall.git my-dashboard
cd my-dashboard

# 2. Add RelayHall as upstream remote
git remote rename origin upstream
git remote add origin <your-private-repo-url>

# 3. Push to your private repo
git push -u origin main

# 4. Customize for your deployment
cp relayhall.config.example.json relayhall.config.json
# Edit relayhall.config.json with your branding, features, etc.
```

### Pulling Upstream Updates

When RelayHall releases a new version:

```bash
# 1. Fetch upstream changes
git fetch upstream

# 2. Check what changed
git log --oneline upstream/main..main

# 3. Merge upstream (or rebase)
git merge upstream/main

# 4. Resolve any conflicts (usually in config files)
# Your custom relayhall.config.json may conflict — keep your version

# 5. Test your deployment
docker compose up --build

# 6. Push updated fork
git push origin main
```

### What to Customize (Safe to Change)

These files are yours to modify — upstream won't touch them:

| File | Purpose |
|------|---------|
| `relayhall.config.json` | Bot name, branding, features, deployment |
| `relayhall.plugins.json` | Which plugins to enable |
| `docker-compose.prod.yml` | Production deployment config |
| `.env` | Environment variables (secrets) |
| `config/` directory | Per-plugin configuration overrides |
| `plugins/` directory | Plugin source repos |

### What Not to Change (Upstream Files)

These files receive upstream updates — avoid modifying directly:

| File | Purpose |
|------|---------|
| `frontend/src/` | Core frontend code |
| `backend/src/` | Core backend code |
| `database/` | Database schema and migrations |

If you need to extend core behavior, consider:
1. **Feature flags** in `relayhall.config.json`
2. **Plugins** for new functionality
3. **Config overrides** instead of code changes
4. **PR to upstream** if the change benefits everyone

### Contributing Back to RelayHall

If you've built something useful:

1. Create a branch from the latest upstream/main
2. Make your changes (keeping them generic, no deployment-specific code)
3. Test with a clean `relayhall.config.json` (default values)
4. Submit a Pull Request to the upstream repo

### Plugin Development

See `docs/plugin-development.md` for how to create RelayHall plugins.

## Development Setup

```bash
# Clone
git clone <repo-url>
cd relayhall

# Start the stack (rebuilds images from source)
docker compose up --build

# Frontend: http://localhost:8082/dashboard/
# Backend: http://localhost:3001/
# Database: localhost:5433 (bound to 127.0.0.1)
```

## Code Style

- TypeScript throughout (frontend + backend)
- React for frontend
- Express for backend
- PostgreSQL for database
- Docker for deployment

## Testing

```bash
# Backend tests
cd backend && npm test

# Frontend build check
cd frontend && npm run build
```

CI has two tiers. `ci.yml` runs on every push of every branch and on pull
requests (except `ci-full/**`) and is meant to be green in minutes: the
repository contract, a backend
type check and the mocked suite, and — when their area changed — the frontend
and CLI jobs. `ci-full.yml` carries every real-PostgreSQL gate and every
mutation drill, and runs only on demand: `workflow_dispatch`, or a push to a
`ci-full/**` ref. One ref carries one workflow — see docs/ci.md for why.

**A full-tier green on the exact SHA is required before any TST or production
deploy and before any release tag.** DEV may be deployed from a fast-tier-green
`main`. To get one for an ordinary commit, push it to a `ci-full/**` ref.

See [docs/ci.md](docs/ci.md) for the job map, what skips on which paths, and the
exact commands that reproduce each job locally — running the one you touched
before pushing is faster than waiting on CI.

If you added, renamed or deleted a file, update `.relayhall-public-allowlist` in
the same commit or the publication gate will fail. `python3
scripts/check-public-allowlist.py` tells you exactly what to change in under a
second. Note that this failure does **not** appear as a merge conflict — two
branches that each add files can merge cleanly and still fail the gate.
