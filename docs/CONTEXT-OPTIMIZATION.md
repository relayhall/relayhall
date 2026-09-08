# Context Optimization for Agent Workflows

## Problem Statement

The RelayHall project context is ~155K tokens when requested via the `/api/projects/:id/context` endpoint. This is far too large for efficient agent work:

- **Token cost**: Each agent request pays for 155K context tokens
- **Latency**: Large contexts slow down API responses
- **Focus**: Agents don't need 99% of this information

## Root Cause Analysis

### What's in the 155K tokens?

The bloat comes almost entirely from **`projectFiles`** in `ContextService.ts`:

```typescript
// This function has NO filtering - it lists EVERYTHING recursively
function listFilesRecursive(basePath: string, prefix: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(basePath);
  for (const e of entries) {
    // ...lists every file, including node_modules
  }
  return results;
}
```

### Breakdown by Section

| Section | Est. Tokens | Problem |
|---------|-------------|---------|
| `projectFiles` | ~150K | Lists every file in node_modules (thousands of entries) |
| `sourceTree` | ~200 | ✅ Already filters node_modules at top level |
| `readmeContent` | ~500 | ✅ Reasonable, truncated to budget |
| `changelogPreview` | ~300 | ✅ Only first 50 lines |
| `project` info | ~50 | ✅ Minimal |
| `resources/links` | ~100 | ✅ Minimal |

**99% of context bloat is from unfiltered `projectFiles` listing.**

## Solution Recommendations

### 1. Add Exclusion Patterns to `listFilesRecursive()` (Quick Fix)

Modify `ContextService.ts` to filter common large/irrelevant directories:

```typescript
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.tsbuildinfo',
  '*.log',
  '.DS_Store',
];

function shouldExclude(name: string): boolean {
  return EXCLUDE_PATTERNS.some(pattern => {
    if (pattern.startsWith('*')) {
      return name.endsWith(pattern.slice(1));
    }
    return name === pattern;
  });
}

function listFilesRecursive(basePath: string, prefix: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(basePath);
  for (const e of entries) {
    if (shouldExclude(e)) continue;  // Skip excluded patterns
    // ...rest of function
  }
  return results;
}
```

**Estimated improvement**: 155K → ~2-5K tokens

### 2. Support `.contextignore` Files (Enhanced)

Allow projects to define their own exclusion patterns via a `.contextignore` file (similar to `.gitignore`):

```typescript
function loadContextIgnore(projectPath: string): string[] {
  const ignorePath = path.join(projectPath, '.contextignore');
  if (!existsSync(ignorePath)) {
    // Fall back to defaults
    return EXCLUDE_PATTERNS;
  }
  const content = readFileSync(ignorePath, 'utf-8');
  return content.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}
```

Example `.contextignore`:
```
# Dependencies
node_modules/
vendor/

# Build outputs
dist/
build/
.next/

# IDE/OS
.git/
.vscode/
.idea/
```

### 3. Tiered Context Approach (Recommended)

Implement different context levels based on use case:

| Tier | Token Budget | Contents | Use Case |
|------|--------------|----------|----------|
| `minimal` | ~500 | Project name, description, links | Quick queries |
| `agent` | ~2000 | + Source tree, README summary | Task execution |
| `full` | ~10000 | + Full README, changelog, task details | Deep analysis |
| `dev` | unlimited | Everything (current behavior) | Debugging only |

API change:
```
GET /api/projects/:id/context?tier=agent
```

Implementation:
```typescript
const TIER_BUDGETS = {
  minimal: 500,
  agent: 2000,
  full: 10000,
  dev: Infinity,
};

async buildContext(projectId: string, options: ContextOptions) {
  const budget = TIER_BUDGETS[options.tier || 'agent'];
  // ... build context respecting budget
}
```

### 4. Smart File Indexing (Future Enhancement)

Instead of listing all files, provide a smart summary:

```typescript
interface SmartFileIndex {
  structure: {
    frontend: ['src/', 'public/', 'index.html'],
    backend: ['src/', 'routes/', 'services/'],
    config: ['package.json', 'tsconfig.json', 'docker-compose.prod.yml'],
    docs: ['README.md', 'docs/'],
  };
  stats: {
    totalFiles: 234,
    languages: { typescript: 45, css: 12, json: 8 },
    lastModified: '2024-02-06T16:00:00Z',
  };
  keyFiles: [
    { path: 'src/server.ts', description: 'Main entry point' },
    { path: 'src/routes/projects.ts', description: 'Project API routes' },
  ];
}
```

Benefits:
- ~500 tokens instead of 150K
- More useful for agents (semantic structure vs raw file list)
- Can be cached and updated incrementally

### 5. Tree-Sitter Based Code Summarization (Advanced)

For key source files, provide AST-based summaries:

```typescript
// Instead of raw file content, provide:
{
  "path": "src/services/ContextService.ts",
  "summary": {
    "exports": ["ContextService", "contextService"],
    "functions": ["buildContext", "getSourceTree", "listFilesRecursive"],
    "imports": ["fs", "path", "ProjectService", "TaskManager"],
    "lineCount": 230
  }
}
```

This allows agents to understand code structure without reading every line.

## Implementation Priority

1. **Immediate (Quick Win)**: Add exclusion patterns to `listFilesRecursive()`
   - Effort: 30 minutes
   - Impact: 155K → ~2K tokens (99% reduction)

2. **Short-term**: Add tier parameter to context API
   - Effort: 2 hours
   - Impact: Predictable context sizes for different use cases

3. **Medium-term**: Support `.contextignore` files
   - Effort: 2 hours
   - Impact: Per-project customization

4. **Long-term**: Smart file indexing with caching
   - Effort: 1-2 days
   - Impact: Better agent UX, semantic understanding

## Appendix: Default Exclusion Patterns

Based on `.gitignore` best practices:

```
# Dependencies
node_modules/
vendor/
bower_components/
.pnpm/
.yarn/

# Build outputs
dist/
build/
out/
.next/
.nuxt/
.output/
.cache/
coverage/

# IDE/Editor
.git/
.svn/
.vscode/
.idea/
*.swp
*.swo
*~

# OS files
.DS_Store
Thumbs.db
*.log

# Python
__pycache__/
*.pyc
.venv/
venv/
.env/
env/

# Package locks (keep one, exclude others based on project)
# package-lock.json
# yarn.lock
# pnpm-lock.yaml

# Temporary
tmp/
temp/
*.tmp
```

## Metrics to Track

After implementing fixes:
- Average context token count
- 95th percentile context size
- Agent task success rate (ensure no regressions)
- API response latency for context endpoint

---

*Document created: 2026-02-06*
*Author: Context Optimizer Agent*
