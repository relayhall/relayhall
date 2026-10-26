/** Read-only built-in MCP metadata. Listing is not invocation authority. */
import { Router } from 'express';
const router = Router();
router.get('/', (_req, res) => {
  // Registry handlers dispatch through routeRegistry. Load only after the
  // router graph is initialized, regardless of the module entry point.
  const { MCP_TOOLS, toolEffect } = require('../mcp/registry') as typeof import('../mcp/registry');
  res.setHeader('Cache-Control', 'private, no-store');
  // `plane` is bootstrap admission; `effect` is what the tool does and is what
  // the Tools page labels.
  res.json({ success: true, tools: MCP_TOOLS.map((tool) => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    plane: tool.plane, effect: toolEffect(tool), requiredScope: tool.scope ?? null,
  })) });
});
export default router;
