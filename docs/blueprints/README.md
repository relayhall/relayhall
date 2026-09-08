# Blueprint artifacts and acceptance

These three portable documents implement the ratified example outlines in companion bb549028 §7. They are importable drafts, not installed or published registry entries. Their parameter prompts and plans are untrusted data rendered as text.

- `project-design.json` uses an existing Project, separate author/verifier/ratifier references, and two parked ratification arms. The outline declares owning_project optional, but existing-project instantiation still needs an actual visible selection; omitting it yields the same unavailable-target refusal as any unresolvable binding.
- `governed-deployment.json` includes an explicit go/no-go, required deployment-runbook Skill and optional Hermes execution Service.
- `incident-investigation.json` has the seven ratified parameters, overlapping triage/contain phases, a required incident-triage Skill, optional postmortem-template/Hermes references, and a single Announce Task shared by both fix-deployment arms.

Import each using the ordinary Blueprint import operation. Import always creates a draft. Resolve naming collisions with an explicit rename, then submit for review and publish as a different authorized Principal. Required Skills must already have reviewed published versions visible to the caller. No fixture is allowed to silently publish itself in the installation.

## Execution Service boundary

Execution defaults are resolved during creation and stored privately for the original instantiator or a root login session. Creation produces parked, unassigned Tasks. Every unavailable reference blocks creation, including optional declarations. Skill and Personality use and Service invoke authority are checked. An available Service appears in the preview and is staged for the separate execution setup act.

After creation, choose an existing Phase- or Project-anchored Warrant and preview execution setup. Confirm the displayed Task IDs, revisions and resolved Service profiles. Setup rechecks current authority and membership, uses ordinary canonical assignment within one transaction, and arms nothing. A failed setup preserves the created workflow for retry. An uncertain result must be retried with the identical body and Idempotency-Key. Tasks added later are excluded. Existing Warrant revocation, expiry, holder chains and profile ceilings continue to apply; the Blueprint does not mint a Warrant or convey its own authority.

Blueprint instantiation creates no creator or home-group Grant pair. The ordinary Project creator policy does not apply to this channel. A disabled Account cannot create a Project.

Personality references resolve the current committed immutable version through the version registry. A declared minimum above that version is unavailable; retired Personalities remain unavailable. This adds no Personality publication lifecycle.

## Ordinary interview Skill

`blueprint-deployment/SKILL.md` is the reviewable instruction artifact. Register it using the normal Skills API under the actual human author, with human-authored provenance, then submit and publish through the existing Skills review gate using the appropriate separate Verifier. Migration083 requires a real creator Principal and validates provenance; these artifacts neither invent that identity nor bypass the trigger. Publication is not automatic. Keep the exact published version/hash as acceptance evidence.

## Human clean-room check — required, not yet performed

Use a person who has not read the design. Give them only the normal Blueprints UI or the published interview Skill and a caller account with the intended authority. Ask them to instantiate the incident investigation from its prompts. Observe discover, describe, collect, full preview, explicit confirmation, instantiate and report. Record which prompts were unclear, whether they understood both parked arms and missing optional references, and the resulting Project/instantiation ids. The tester must not be coached from the design. Automated UI tests and agent-driven interviews do not satisfy this requirement.

Technical acceptance still includes adversarial documents, ordinary-resource parity, whole-plan refusals, transactional rollback, concurrency/idempotency, independent readback, closed-call census and the named single-edit production mutations. An early root-session smoke is evidence for its listed checks only.

## Imported version interpretation

Design §2.2 permits changing only the key on explicit rename and includes version in both digest domains. The REST contract separately specifies version 1 for ordinary author-time create and draft-only import. An imported exported snapshot therefore preserves its positive source version N in a fresh parent, with no invented local versions 1 through N−1. The next authored version is N+1. This is the specific import contract's interpretation for formal verification, not a new owner ruling. Digests are recomputed; document provenance and every field other than an explicit key rename stay unchanged.

Descriptor string options (design §2.4 and §3.3): parameters may fill direct option values only when the resolved Connector's immutable descriptor declares that option as `string`. Option names, enum members, numeric/boolean options, secret references and resource selectors cannot be interpolated. Inserted braces remain literal text. The plan validates the resulting options through the ordinary Connector option validator and shows the selected descriptor version without disclosing its body. Execution defaults remain staged until the separate setup confirmation described above; option preview does not itself assign or activate work.


## Authoring from a Phase

Build a Phase and its Tasks with the ordinary editors, then choose **Save as Blueprint** on the Phase page. Capture requires `blueprints:write` and read access to the Project, Phase and every member Task. Restricted members refuse the complete capture instead of silently changing the workflow.

The initial version is 1, its status is draft and its author is the caller. Capture preserves Phase name/goal, Task text, structured definition of done, success criteria, constraints, notes, priority, tags, thinking, subtasks, internal dependencies, role expectations and safe execution defaults. A new Project is the default target; captured documents can also target an existing Project. IDs, timestamps, assignments, Warrants, sessions, attempts and completion state are never copied.

The draft reuses the ordinary Task text editor. Beside each eligible captured field, choose **Fixed**, **Placeholder — required**, or **Placeholder — optional**, then supply its label and help text. Fixed is the default. Text uses single-pass substitution; role/capability fields use typed bindings. Priority/thinking placeholders restrict answers to their enum; retry placeholders retain integer bounds. Optional text and enum fields retain their captured defaults. A plan with no Tasks or human gates cannot enter review.

```sh
relayhall blueprint capture --phase <phase-uuid> --name "Reusable delivery"
relayhall blueprint get <blueprint-key> --version 1
relayhall blueprint submit <blueprint-key> --version 1
```

A different authorized Principal publishes the version. Export remains restricted to published/retired content; import creates a draft and requires an explicit rename on collision.

Capture refuses nonportable data with a field-specific message: installation addresses or credential-shaped text, legacy execution profiles, execution parameter maps without portable bindings, and links without a named registry representation. Replace links with registry references before capture. No partial plan is saved. Existing document size/count limits remain.

### Plugin functions

Installed plugins may declare `blueprintReferences` entries with `kind`, `name`, `service` and `tool`. The Task reference kind is `plugin:<plugin-name>:<kind>`, and its stable name is the registered entry name. Capture enumerates registered adapters and installed plugin declarations; the Connector descriptor must contain the named tool. Plugin version, Connector version and descriptor digest travel in the document. Changed descriptors require renewed review.

## Using a Blueprint

Open a registry tile and choose **Use Blueprint**. Fill the single form (required answers first), choose its Project target and select **Preview plan**. The plan appears inline. Reference collection appears only when the document declares references. Fixed fields cannot be changed at use time.

**Create** requires a valid preview with every reference and authority available, including references declared optional. Editing an answer invalidates the preview. REST `instantiations/preview` + `instantiations` and MCP `relayhall_blueprint_preview` / `relayhall_blueprint_instantiate` share the same plan builder and diagnostics. The receipt links to the ledger. Retry uncertain outcomes with the identical body and Idempotency-Key.

After creation, **Set up workflow now** offers an existing Warrant or a new workflow Warrant using an explicitly selected holder, published access profile and expiry (UTC). Preview shows the exact Warrant, Task revisions and profile assignments; the caller must hold every permission being delegated. New-Warrant confirmation uses the ordinary human-session step-up act. Warrant creation and assignment commit together, retries recover the receipt, and Tasks remain parked. Bearer clients, including MCP, continue using existing-Warrant setup; they cannot mint a human-approved Warrant through this shortcut.

The seven-step interview components remain in the tree; the dashboard uses the one-screen flow. Instantiation creates no creator or home-group Grant pair (D7). Disabled Accounts cannot create Projects (D1).

Nested Connector parameter maps are retained and validated against the resolved descriptor. String parameters support one-pass placeholders. Numeric, boolean, enum and reference option types remain subject to the descriptor boundary; changing their literal type is refused.

Connector option/parameter leaves are editable as fixed values in the draft editor. Their descriptor types are not inferred from a stored primitive, so the editor does not offer unsupported placeholder modes for those leaves. Descriptor-declared string interpolation remains supported by the portable API/import contract. Empty structured Task lists retain an Add item action.
