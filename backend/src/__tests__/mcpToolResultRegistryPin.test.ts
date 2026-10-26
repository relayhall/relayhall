/**
 * Card 233d8959. This review manifest is independent of the common formatter:
 * a registry addition, removal, or new tools/call return needs fresh field and
 * response-path census before it can reach a model.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { MCP_TOOLS } from '../mcp/registry';

const REVIEWED_NAMES = `
relayhall_task_native_generation relayhall_task_native_execution relayhall_task_native_review relayhall_service_review_requests
relayhall_blueprint_list relayhall_blueprint_get relayhall_blueprint_preview relayhall_blueprint_instantiate relayhall_blueprint_setup_preview relayhall_blueprint_setup
relayhall_principal_whoami relayhall_access_preview relayhall_warrant_list relayhall_principal_list relayhall_action_items_list relayhall_task_list relayhall_task_get relayhall_task_graph
relayhall_task_create relayhall_task_account_owner_get relayhall_task_account_owner_change relayhall_task_update relayhall_task_dependency_add relayhall_task_dependency_remove
relayhall_task_archive relayhall_task_archive_bulk relayhall_task_restore relayhall_task_move relayhall_subtask_set relayhall_subtask_create relayhall_subtask_reorder relayhall_subtask_update_text relayhall_task_stream_list relayhall_task_timeline_get
relayhall_task_stream_append relayhall_task_report_list relayhall_task_report_get relayhall_task_report_reconcile relayhall_task_report_save relayhall_task_finish
relayhall_task_reference_list relayhall_task_reference_create relayhall_task_success_criteria_set relayhall_review_run relayhall_review_reject relayhall_task_arm relayhall_task_park relayhall_task_claim
relayhall_task_release relayhall_task_recover relayhall_lease_claim relayhall_lease_renew relayhall_lease_release relayhall_brief_compile
relayhall_knowledge_source_search relayhall_knowledge_source_get relayhall_knowledge_note_propose relayhall_knowledge_note_preview relayhall_knowledge_note_commit
relayhall_knowledge_shared_writers_list
relayhall_report_search relayhall_report_get relayhall_report_create relayhall_report_update relayhall_project_list relayhall_project_get relayhall_project_create
relayhall_project_update relayhall_project_archive relayhall_project_restore relayhall_project_resource_list relayhall_project_resource_get
relayhall_project_resource_create relayhall_project_resource_update relayhall_project_resource_archive relayhall_project_resource_restore
relayhall_project_resource_replace relayhall_project_context_get relayhall_charter_get relayhall_phase_list relayhall_phase_get relayhall_phase_create
relayhall_phase_update relayhall_phase_archive relayhall_phase_restore relayhall_skill_list relayhall_skill_get relayhall_personality_list
relayhall_service_list relayhall_service_get relayhall_agent_mint relayhall_access_request relayhall_agent_reveal relayhall_agent_revoke
`.trim().split(/\s+/);

it('pins every reviewed registry tool by name, not merely the count', () => {
  expect(MCP_TOOLS.map((tool) => tool.name)).toEqual(REVIEWED_NAMES);
});

it('pins every tools/call response path to the shared trust boundary', () => {
  const file = path.join(__dirname, '..', 'mcp', 'server.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let handler: ts.ArrowFunction | undefined;
  const findHandler = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === 'tools/call'
      && node.arguments[1] && ts.isArrowFunction(node.arguments[1])) {
      handler = node.arguments[1];
    }
    ts.forEachChild(node, findHandler);
  };
  findHandler(source);
  expect(handler).toBeDefined();
  const returns: ts.ReturnStatement[] = [];
  const collectReturns = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, collectReturns);
  };
  collectReturns(handler!.body);
  expect(returns).toHaveLength(4); // unknown, bootstrap, success, failure
  for (const statement of returns) {
    expect(statement.expression && ts.isCallExpression(statement.expression)).toBe(true);
    expect((statement.expression as ts.CallExpression).expression.getText(source))
      .toBe('markToolResultUntrusted');
  }
});
