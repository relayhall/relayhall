-- Migration 024: Seed example reports
-- Insert sample reports for testing and demonstration

INSERT INTO reports (title, content, summary, tags, author, pinned) VALUES
(
  'ClawBoard Migration Report',
  E'# ClawBoard Migration Report\n\n## Overview\nMigrated ClawBoard from JSON file-based storage to PostgreSQL. This was a multi-phase effort involving schema design, data migration, and API refactoring.\n\n## Key Changes\n- **Database**: PostgreSQL 15 with UUID primary keys\n- **ORM**: Direct pg queries (no ORM overhead)\n- **Schema**: Normalized tables for tasks, subtasks, tags, dependencies, and links\n- **Migrations**: Sequential SQL files in `backend/src/migrations/`\n\n## Migration Steps\n1. Designed normalized schema with proper foreign keys\n2. Created migration runner that applies SQL files in order\n3. Built TaskManagerDB as drop-in replacement for JSON TaskManager\n4. Migrated existing task data via one-time import script\n5. Updated all API routes to use async DB queries\n\n## Results\n- Query performance improved significantly for filtered views\n- Concurrent access now safe (no more file locking issues)\n- Full-text search capabilities via ILIKE and GIN indexes\n- Proper relational integrity with CASCADE deletes\n\n## Lessons Learned\n- Keep migrations idempotent (IF NOT EXISTS everywhere)\n- Test rollback scenarios before deploying\n- JSON file backup saved us during one failed migration attempt',
  'Migrated ClawBoard from JSON file-based storage to PostgreSQL. Multi-phase effort involving schema design, data migration, and API refactoring.',
  ARRAY['migration', 'postgresql', 'infrastructure'],
  'nim',
  true
),
(
  'Regression Audit — Feb 2026',
  E'# Regression Audit — February 2026\n\n## Scope\nFull regression audit of ClawBoard frontend after the Phase 4 hub redesign. Tested all critical user flows across Chrome and Firefox.\n\n## Test Results\n\n### Passing\n- ✅ Task CRUD operations (create, edit, delete, archive)\n- ✅ Subtask status transitions (6-state lifecycle)\n- ✅ Dashboard summary cards and activity feed\n- ✅ Project filtering and tag-based search\n- ✅ WebSocket real-time updates\n- ✅ Auth flow (login, token refresh, logout)\n\n### Issues Found\n- ⚠️ Dependency graph visualization clips long task titles\n- ⚠️ Mobile layout breaks on task detail page below 375px width\n- 🐛 Race condition in auto-archive when multiple tabs open\n\n## Recommendations\n1. Add CSS text-overflow handling for dependency graph labels\n2. Add responsive breakpoints for task detail page\n3. Debounce auto-archive check with tab visibility API\n\n## Coverage\n- Manual test cases: 47/47 executed\n- Automated E2E: 23 passing, 2 flaky (timing-dependent)\n- Browser coverage: Chrome 121, Firefox 124',
  'Full regression audit of ClawBoard frontend after Phase 4 hub redesign. 47 manual tests executed, 3 issues found.',
  ARRAY['audit', 'frontend', 'testing'],
  'nim',
  false
),
(
  'Architecture Notes — Plugin System',
  E'# Architecture Notes: Plugin System\n\n## Design Goals\n- Allow extending ClawBoard without modifying core code\n- Plugins should be isolated (own iframe, own state)\n- Core API remains stable; plugins use public REST endpoints\n- Plugin discovery and registration via config file\n\n## Implementation\n- `PluginLoader` reads `clawboard.plugins.json` at startup\n- Each plugin gets a proxy route at `/p/<plugin-name>/`\n- Plugins rendered in iframes with sandboxed permissions\n- Theme CSS injected into plugin iframes for consistent styling\n- Plugin health checks via periodic ping\n\n## Security Considerations\n- Plugins cannot access other plugins'' data\n- Auth tokens not forwarded to plugin iframes (plugins use their own auth if needed)\n- CSP headers restrict plugin iframe capabilities\n- Plugin proxy validates target URLs against allowlist\n\n## Future Work\n- Plugin marketplace / registry\n- Plugin API SDK for common operations\n- Event bus for plugin-to-core communication',
  'Architecture notes for the ClawBoard plugin system. Covers design goals, implementation details, security considerations.',
  ARRAY['architecture', 'plugins', 'design'],
  'nim',
  false
);
