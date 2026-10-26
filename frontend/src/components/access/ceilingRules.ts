/**
 * THE WARRANT FORM'S CEILING RULES (card 785e1eed, lane P2-F; owner rulings
 * E17 Q5(d) and E48).
 *
 * `POST /warrants` already accepts `ceilingRules`, validates them with the
 * server's `validateRules` and publishes them as an Access profile inside the
 * warrant's own transaction (AZ-A3 clause 2; `WarrantService.prepareCreate` and
 * `WarrantService.create`). Until this lane the dashboard could only pin an
 * EXISTING published profile, and it has no profile editor, so a warrant whose
 * ceiling no profile already described could not be created from the board.
 *
 * This module is the form's half and nothing more: the closed sets the editor
 * offers, the conversion from editor rows to the request body, a parser for a
 * pasted rules array, and a client-side MIRROR of `validateRules`
 * (`backend/src/services/AccessProfileService.ts`) so the common refusals are
 * caught before the step-up dialog rather than after it. The SERVER is the
 * authority. Whatever it refuses is rendered verbatim by the form, and nothing
 * here is allowed to accept a rule the server would refuse.
 *
 * WHERE THE MIRROR IS NARROWER THAN THE SERVER, deliberately, and why:
 *  - `surface` is not offered. A surface ceiling is `exact`-only with
 *    `read`/`write` verbs and is checked against the governable-surface
 *    registry inside the transaction (AZ-A5 clause 3); it belongs to the profile
 *    routes, not to a form field.
 *  - The `admin` verb is not offered. A warrant ceiling bounds what minted
 *    Agents may hold, and `*:admin` never reaches the Agent layer.
 *  - One rule per resource type. The server's validator does not refuse two
 *    rules on one type; this form does, because a second row on the same type
 *    is far more often a mistake than an intent, and the lane's acceptance
 *    asks for it. A ceiling that genuinely needs two rules on one type is
 *    still created from a published profile.
 */

/** GrantService `GRANT_RESOURCE_TYPES`, in the same order, minus `surface`. */
export const CEILING_RESOURCE_TYPES = [
  'task', 'phase', 'project', 'report', 'skill', 'personality', 'service', 'plugin', 'blueprint',
] as const;
export type CeilingResourceType = (typeof CEILING_RESOURCE_TYPES)[number];

/** The four ratified selector forms (`SELECTOR_FORMS`), in the order the form offers them. */
export const CEILING_SELECTOR_FORMS = ['exact', 'all-of-type', 'all-in-project', 'all-except'] as const;
export type CeilingSelectorForm = (typeof CEILING_SELECTOR_FORMS)[number];

/** GrantService `GRANT_VERBS` minus `admin`. */
export const CEILING_VERBS = ['read', 'write', 'use', 'invoke'] as const;

/** The keys one rule may carry, exactly as `validateRules` admits them. */
const RULE_FIELDS = ['resourceType', 'selectorForm', 'selectorIds', 'verbs'] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SELECTOR_IDS = 500;

/**
 * Which selector forms each resource type admits — the mirror of the server's
 * `SELECTOR_FORM_ADMISSIBILITY`, with the server's own reason, so a refusal
 * here reads the same as the one the server would have sent.
 */
export const CEILING_FORMS_BY_TYPE: Readonly<Record<CeilingResourceType, {
  readonly forms: readonly CeilingSelectorForm[];
  readonly because: string;
}>> = {
  task: { forms: ['exact', 'all-of-type', 'all-in-project', 'all-except'], because: 'a Task carries a project coordinate' },
  phase: { forms: ['exact', 'all-of-type', 'all-in-project', 'all-except'], because: 'a Phase carries a project coordinate' },
  project: {
    forms: ['exact', 'all-of-type', 'all-except'],
    because: "a Project IS its own project coordinate, so 'all-in-project' would be a second spelling of 'exact'",
  },
  report: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Report carries no project coordinate' },
  skill: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Skill carries no project coordinate' },
  personality: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Personality carries no project coordinate' },
  service: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Service carries no project coordinate' },
  plugin: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Plugin carries no project coordinate' },
  blueprint: { forms: ['exact', 'all-of-type', 'all-except'], because: 'a Blueprint carries no project coordinate' },
};

/** What each form means. The selector offers the form's own name, which is
 * the spelling the request body and a pasted packet use; this sentence is the
 * selector's description. */
export const CEILING_FORM_MEANINGS: Readonly<Record<CeilingSelectorForm, string>> = {
  exact: 'These ids only; it never grows.',
  'all-of-type': 'Every object of this type, including ones created later.',
  'all-in-project': 'Every object of this type in the Projects named, including ones created later.',
  'all-except': 'Every object of this type except the ids named, including ones created later.',
};

/** One editor row. `selectorIds` is the text as typed; `key` is React's. */
export interface CeilingRuleRow {
  key: number;
  resourceType: string;
  selectorForm: string;
  selectorIds: string;
  verbs: string[];
}

/** One rule as the request body carries it. `selectorIds` is absent for
 * `all-of-type`, which is the spelling the ratified packet uses. */
export interface CeilingRule {
  resourceType: string;
  selectorForm: string;
  selectorIds?: string[];
  verbs: string[];
}

/** Commas, spaces or new lines separate ids; empty entries are dropped. */
export function splitSelectorIds(text: string): string[] {
  return text.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean);
}

function isCeilingResourceType(value: string): value is CeilingResourceType {
  return (CEILING_RESOURCE_TYPES as readonly string[]).includes(value);
}

function isCeilingSelectorForm(value: string): value is CeilingSelectorForm {
  return (CEILING_SELECTOR_FORMS as readonly string[]).includes(value);
}

/** The forms a row's resource type admits; every form for an unknown type,
 * so the selector never hides the value the problem list is complaining about. */
export function formsFor(resourceType: string): readonly CeilingSelectorForm[] {
  return isCeilingResourceType(resourceType) ? CEILING_FORMS_BY_TYPE[resourceType].forms : CEILING_SELECTOR_FORMS;
}

/** Rows to the request body, in row order, verbs in the order they were chosen. */
export function rowsToRules(rows: readonly CeilingRuleRow[]): CeilingRule[] {
  return rows.map((row) => (row.selectorForm === 'all-of-type'
    ? { resourceType: row.resourceType, selectorForm: row.selectorForm, verbs: [...row.verbs] }
    : {
      resourceType: row.resourceType,
      selectorForm: row.selectorForm,
      selectorIds: splitSelectorIds(row.selectorIds),
      verbs: [...row.verbs],
    }));
}

/**
 * Every reason the server's `validateRules` (plus this form's narrowing) would
 * refuse these rows, one sentence per problem, each naming its rule by the
 * number the editor shows. Empty means the rows may be sent.
 */
export function ceilingRuleProblems(rows: readonly CeilingRuleRow[]): string[] {
  const problems: string[] = [];
  const firstRowOfType = new Map<string, number>();
  rows.forEach((row, index) => {
    const at = `Rule ${index + 1}`;
    if (!isCeilingResourceType(row.resourceType)) {
      problems.push(`${at}: the resource type must be one of: ${CEILING_RESOURCE_TYPES.join(', ')}`
        + (row.resourceType === 'surface' ? " ('surface' ceilings are set through a published profile, not this form)." : '.'));
    } else {
      const earlier = firstRowOfType.get(row.resourceType);
      if (earlier !== undefined) {
        problems.push(`${at} repeats the resource type '${row.resourceType}' of rule ${earlier}: one rule per resource type.`);
      } else {
        firstRowOfType.set(row.resourceType, index + 1);
      }
    }
    if (!isCeilingSelectorForm(row.selectorForm)) {
      problems.push(`${at}: the selector must be one of: ${CEILING_SELECTOR_FORMS.join(', ')}.`);
    } else if (isCeilingResourceType(row.resourceType)
      && !CEILING_FORMS_BY_TYPE[row.resourceType].forms.includes(row.selectorForm)) {
      const admission = CEILING_FORMS_BY_TYPE[row.resourceType];
      problems.push(`${at}: the selector for '${row.resourceType}' must be one of: ${admission.forms.join(', ')} (${admission.because}).`);
    }
    const ids = splitSelectorIds(row.selectorIds);
    if (row.selectorForm === 'all-of-type') {
      if (ids.length > 0) problems.push(`${at}: all-of-type takes no ids. Clear them, or choose another selector.`);
    } else if (isCeilingSelectorForm(row.selectorForm)) {
      const what = row.selectorForm === 'all-in-project' ? 'Project id' : 'id';
      if (ids.length === 0) {
        problems.push(`${at}: ${row.selectorForm} needs at least one ${what}.`);
      } else if (ids.length > MAX_SELECTOR_IDS) {
        problems.push(`${at}: at most ${MAX_SELECTOR_IDS} ids.`);
      } else {
        const malformed = ids.filter((id) => !UUID_PATTERN.test(id));
        if (malformed.length > 0) {
          problems.push(`${at}: every ${what} must be a full UUID; not one: ${malformed.slice(0, 3).join(', ')}`
            + (malformed.length > 3 ? ` and ${malformed.length - 3} more.` : '.'));
        }
      }
    }
    if (row.verbs.length === 0) {
      problems.push(`${at}: choose at least one verb.`);
    } else {
      const outside = row.verbs.filter((verb) => !(CEILING_VERBS as readonly string[]).includes(verb));
      if (outside.length > 0) {
        problems.push(`${at}: verbs must be drawn from: ${CEILING_VERBS.join(', ')}; not one: ${outside.join(', ')}.`);
      }
    }
  });
  return problems;
}

export type ParsedCeilingRules =
  | { ok: true; rows: CeilingRuleRow[] }
  | { ok: false; problems: string[] };

/**
 * A pasted rules array to editor rows — the array the AUTHZ packet prints,
 * `[{"resourceType": …, "selectorForm": …, "selectorIds": […], "verbs": […]}, …]`.
 *
 * It is all or nothing: a paste that the editor could not show faithfully, or
 * that the server would refuse, changes no row and says why. The shape checks
 * are the server's (`validateRules`: a non-empty array of objects with no
 * unknown field); the content checks are `ceilingRuleProblems`, so a pasted
 * rule and a typed one are held to one standard.
 */
export function parseCeilingRulesJson(text: string, nextKey: () => number): ParsedCeilingRules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (caught) {
    return { ok: false, problems: [`This is not valid JSON: ${caught instanceof Error ? caught.message : 'it could not be parsed'}.`] };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, problems: ['Paste a JSON array of rules: [{"resourceType": …, "selectorForm": …, "selectorIds": […], "verbs": […]}].'] };
  }
  if (parsed.length === 0) {
    return { ok: false, problems: ['The array is empty: a ceiling needs at least one rule.'] };
  }
  const problems: string[] = [];
  const rows: CeilingRuleRow[] = [];
  parsed.forEach((raw: unknown, index: number) => {
    const at = `Rule ${index + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problems.push(`${at} must be an object.`);
      return;
    }
    const rule = raw as Record<string, unknown>;
    const unknownFields = Object.keys(rule).filter((key) => !(RULE_FIELDS as readonly string[]).includes(key));
    if (unknownFields.length > 0) {
      problems.push(`${at} has the unknown field ${unknownFields.map((key) => `'${key}'`).join(', ')}; a rule carries only: ${RULE_FIELDS.join(', ')}.`);
      return;
    }
    if (typeof rule.resourceType !== 'string') {
      problems.push(`${at}: resourceType must be a string.`);
      return;
    }
    if (typeof rule.selectorForm !== 'string') {
      problems.push(`${at}: selectorForm must be a string.`);
      return;
    }
    if (rule.selectorIds !== undefined
      && (!Array.isArray(rule.selectorIds) || rule.selectorIds.some((id) => typeof id !== 'string'))) {
      problems.push(`${at}: selectorIds must be an array of UUID strings.`);
      return;
    }
    if (!Array.isArray(rule.verbs) || rule.verbs.some((verb) => typeof verb !== 'string')) {
      problems.push(`${at}: verbs must be an array of strings.`);
      return;
    }
    rows.push({
      key: nextKey(),
      resourceType: rule.resourceType,
      selectorForm: rule.selectorForm,
      selectorIds: ((rule.selectorIds as string[] | undefined) ?? []).join(', '),
      // The server de-duplicates verbs (`new Set`); so does the paste, keeping
      // the first spelling's position.
      verbs: [...new Set(rule.verbs as string[])],
    });
  });
  if (problems.length > 0) return { ok: false, problems };
  const contentProblems = ceilingRuleProblems(rows);
  if (contentProblems.length > 0) return { ok: false, problems: contentProblems };
  return { ok: true, rows };
}
