import express from 'express';


import dashboardRoutes from '../routes/dashboard';
import { TaskManagerDB, taskManagerDB } from '../services/TaskManagerDB';
import * as reportVisibility from '../services/ReportVisibility';
import { authorizationRepository } from '../services/AuthorizationRepository';

/**
 * The widest scope the shipped predicate can render: a root caller. Read from
 * `AuthorizationRepository.listScope`, never restated here — the assertions
 * below compare the produced SQL to THIS, so a change to the resource shape
 * moves both sides together and a change to the QUERY moves only one.
 */
const WIDEST_SCOPE = authorizationRepository.listScope(
  { principalId: null, handle: 'summary-suite', role: 'admin', scopes: ['root'], authenticated: true },
  'task',
  'read',
);

describe('dashboard task summary', () => {
  test('uses lifecycle status for archived membership and maps database counts', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{
        ideas: 1,
        todo: 2,
        in_progress: 3,
        review: 4,
        stuck: 4,
        completed: 5,
        archived: 860,
        recent_completed: 6,
        total: 879,
      }],
    });
    const manager = new TaskManagerDB({ query } as any);

    await expect(manager.getDashboardSummary(WIDEST_SCOPE)).resolves.toEqual({
      ideas: 1,
      todo: 2,
      inProgress: 3,
      review: 4,
      stuck: 4,
      completed: 5,
      archived: 860,
      recentCompleted: 6,
      total: 879,
    });

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("COUNT(*) FILTER (WHERE t.status = 'archived')");
    expect(sql).not.toMatch(/archived_at\s+IS\s+NOT\s+NULL/i);

    // Card 72258a60: the counts are computed over the scope's FROM under the
    // scope's predicate. Both come from `AuthorizationRepository.listScope`,
    // so this asserts the SHIPPED shape rather than a string this file owns.
    expect(sql).toContain(`FROM ${WIDEST_SCOPE.from}`);
    expect(sql).toContain(`WHERE ${WIDEST_SCOPE.render(1).sql}`);
    // …and never the unnarrowed table the defect counted.
    expect(sql).not.toMatch(/FROM\s+tasks\s*$/m);
  });

  test('binds the scoped predicate AND its parameters, for a caller who is not root', async () => {
    // The root scope renders the constant `TRUE` and binds nothing, so it
    // cannot see a query that interpolated the predicate and dropped its
    // parameters — the shape that reaches PostgreSQL as a bind mismatch. This
    // caller's predicate carries real placeholders and real values.
    const scoped = authorizationRepository.listScope(
      {
        principalId: '11111111-1111-4111-8111-111111111111',
        handle: 'scoped-suite', role: 'user', scopes: ['tasks:read'], authenticated: true,
      },
      'task',
      'read',
    );
    const rendered = scoped.render(1);
    expect(rendered.sql).not.toBe('TRUE');
    expect(rendered.params.length).toBeGreaterThan(0);

    const query = jest.fn().mockResolvedValue({ rows: [{}] });
    await new TaskManagerDB({ query } as any).getDashboardSummary(scoped);

    expect(query.mock.calls[0][0] as string).toContain(rendered.sql);
    expect(query.mock.calls[0][1]).toEqual(rendered.params);
  });

  test('serves the response contract consumed by DashboardPage', async () => {
    const summary = {
      ideas: 1,
      todo: 2,
      inProgress: 3,
      review: 4,
      stuck: 4,
      completed: 5,
      archived: 860,
      recentCompleted: 6,
      total: 879,
    };
    jest.spyOn(taskManagerDB, 'getDashboardSummary').mockResolvedValue(summary);
    jest.spyOn(reportVisibility, 'countVisibleReports').mockResolvedValue(7);

    const app = express();
    // The route composes the caller's scope, so the request must carry a
    // caller. An unauthenticated one would render `FALSE` and measure nothing.
    app.use((req, _res, next) => {
      (req as any).userId = 'summary-suite';
      (req as any).scopes = ['root'];
      next();
    });
    app.use('/dashboard', dashboardRoutes);
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      const response = await fetch(`http://127.0.0.1:${address.port}/dashboard/summary`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        success: true,
        summary: { ...summary, reportCount: 7 },
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      jest.restoreAllMocks();
    }
  });
});
