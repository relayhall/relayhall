/**
 * Card d67e6990 (D24 part 1): the Account a Skill reader acts for.
 *
 * Draft visibility in the Skill registry (SkillManager.SkillViewer) is decided
 * on the caller's ACCOUNT, the parentless link of its delegation chain, so a
 * Connector or Agent sees exactly the drafts its Account owns. A caller that is
 * not delegated is its own Account. Kept apart from SkillManager so the many
 * suites that mock that module still load the routes and the Brief compiler.
 */
export function skillViewerAccount(actor: {
  principalId: string | null;
  delegation?: { links: Array<{ principalId: string; parentPrincipalId: string | null }> } | null;
}): string | null {
  const root = actor.delegation?.links.find((link) => !link.parentPrincipalId);
  return root?.principalId ?? actor.principalId ?? null;
}
