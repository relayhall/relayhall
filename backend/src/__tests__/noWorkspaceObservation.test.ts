import fs from 'fs';
import path from 'path';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('pull-only core boundary', () => {
  it('does not mount the retired project file-management router', () => {
    const server = source('server.ts');
    expect(server).not.toContain("./routes/files");
    expect(server).not.toMatch(/app\.use\(['"]\/projects['"],\s*filesRoutes/);
  });

  it('builds context only from board records', () => {
    // Project context generation moved from the retired ContextService to the
    // typed projection in ProjectResourceService (task 47ef04a2) — the
    // pull-only invariant travels with it.
    const contextBuilder = source('services/ProjectResourceService.ts');
    expect(contextBuilder).not.toMatch(/from ['"]fs['"]/);
    expect(contextBuilder).not.toContain('readdirSync');
    expect(contextBuilder).not.toContain('readFileSync');
    expect(contextBuilder).not.toContain('/workspace');
  });

  it('reviews board evidence without probing a checkout', () => {
    const reviewer = source('services/TaskReviewerService.ts');
    expect(reviewer).not.toMatch(/from ['"]child_process['"]/);
    expect(reviewer).not.toContain('collectWorkspaceEvidence');
    expect(reviewer).not.toContain('resolveWritableRuntimePath');
    expect(reviewer).not.toContain('git status');
  });

  it('keeps compiled prompts free of built-in workspace paths', () => {
    const promptTemplate = source('utils/promptTemplate.ts');
    expect(promptTemplate).not.toContain('/workspace');
    expect(promptTemplate).not.toContain('/home/');
  });
});
