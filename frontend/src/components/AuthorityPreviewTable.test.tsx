// @vitest-environment jsdom
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { AuthorityPreviewTable } from './AuthorityPreviewTable';
describe('current authority rendering', () => {
  afterEach(cleanup);
  it('renders actual action and source evidence, with remaining act gates explicit', () => {
    render(<AuthorityPreviewTable access={{ envelope: { alive: true, transport: 'mcp', scopes: ['tasks:read'] },
      resources: [{ id: '11111111-1111-4111-8111-111111111111', actions: [{ action: 'read', sources: ['bound-task-context', 'verifier'] }] }] }} />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('Assigned task context, Task verifier')).toBeTruthy();
    expect(screen.getByText(/Transport limits, task state and approvals/)).toBeTruthy();
    expect(screen.queryByText('write')).toBeNull();
  });
  it('requires one credential and never fabricates permission rows for missing or inactive authority', () => {
    const { rerender } = render(<AuthorityPreviewTable access={{ needsCredential: true, resources: [] }} />);
    expect(screen.getByRole('status').textContent).toContain('Choose a credential');
    expect(screen.queryByRole('table')).toBeNull();
    rerender(<AuthorityPreviewTable access={{ envelope: { alive: false, transport: 'mcp', scopes: [] }, resources: [] }} />);
    expect(screen.getByText(/Authority: inactive/)).toBeTruthy();
    expect(screen.getByText('No permitted objects in this page.')).toBeTruthy();
  });
});
