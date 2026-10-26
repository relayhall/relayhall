import React, { useRef, useState } from 'react';
import { ClipboardPaste, Plus, Trash2 } from 'lucide-react';
import { Button } from '../Button';
import { Select } from '../ui/Select';
import {
  CEILING_FORM_MEANINGS, CEILING_RESOURCE_TYPES, CEILING_VERBS,
  formsFor, parseCeilingRulesJson, type CeilingRuleRow,
} from './ceilingRules';

/**
 * THE CEILING-RULES FIELD of the New warrant form (card 785e1eed, lane P2-F;
 * owner rulings E17 Q5(d) and E48). See `ceilingRules.ts` for what the rules
 * are, what the server does with them and where this form is deliberately
 * narrower than the server.
 *
 * A structured editor rather than a JSON box: one row per rule, each a
 * resource type, a selector form, the ids that form needs and the verbs. The
 * owner's packet arrives as JSON, so "Paste rules JSON" fills the rows from it
 * all-or-nothing; what is sent is always what the rows show.
 *
 * The field is CONTROLLED. Its parent owns the rows, because the parent owns
 * the mutual exclusion with the "Ceiling profile" selector and the submit.
 * `disabled` is that exclusion arriving from the parent: a chosen profile
 * disables the whole fieldset natively, so no control inside it can be
 * reached, typed into or submitted.
 */
export interface CeilingRulesFieldProps {
  rows: CeilingRuleRow[];
  onRowsChange: (rows: CeilingRuleRow[]) => void;
  /** A published profile is chosen above; the two ceilings exclude each other. */
  disabled: boolean;
  /** The refusals from the last submit attempt, or null before one. */
  problems: string[] | null;
  idPrefix: string;
}

export const CeilingRulesField: React.FC<CeilingRulesFieldProps> = ({
  rows, onRowsChange, disabled, problems, idPrefix,
}) => {
  // A row key is the React key AND the stem of the row DOM ids (`${idPrefix}-${key}-...`),
  // so a key must never repeat while a row holding it survives. The rows
  // outlive this field: the parent keeps them through Close form -> New
  // warrant, which remounts the field, and a bare counter restarted at 0 then
  // re-issued key 1 beside a surviving row 1 (round 1 B1). So every new key is
  // seeded past every key the current rows hold, whoever minted them.
  const keyRef = useRef(0);
  const nextKey = () => {
    keyRef.current = Math.max(keyRef.current, ...rows.map((row) => row.key)) + 1;
    return keyRef.current;
  };
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteProblems, setPasteProblems] = useState<string[] | null>(null);
  const [filledNote, setFilledNote] = useState<string | null>(null);

  const usedTypes = new Set(rows.map((row) => row.resourceType));
  const unusedType = CEILING_RESOURCE_TYPES.find((type) => !usedTypes.has(type));

  const update = (index: number, patch: Partial<CeilingRuleRow>) => {
    setFilledNote(null);
    onRowsChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  const changeType = (index: number, resourceType: string) => {
    const row = rows[index];
    // A form the new type does not admit is never kept behind a selector that
    // cannot show it: the row falls back to `exact`, which every type admits.
    const selectorForm = formsFor(resourceType).includes(row.selectorForm as never) ? row.selectorForm : 'exact';
    update(index, { resourceType, selectorForm });
  };

  const changeForm = (index: number, selectorForm: string) => {
    // `all-of-type` takes no ids, and its id field is hidden: ids typed for
    // another form must not ride along unseen.
    update(index, selectorForm === 'all-of-type' ? { selectorForm, selectorIds: '' } : { selectorForm });
  };

  const toggleVerb = (index: number, verb: string) => {
    const verbs = rows[index].verbs;
    update(index, { verbs: verbs.includes(verb) ? verbs.filter((v) => v !== verb) : [...verbs, verb] });
  };

  const addRow = () => {
    if (!unusedType) return;
    setFilledNote(null);
    onRowsChange([...rows, { key: nextKey(), resourceType: unusedType, selectorForm: 'exact', selectorIds: '', verbs: ['read'] }]);
  };

  const removeRow = (index: number) => {
    setFilledNote(null);
    onRowsChange(rows.filter((_, at) => at !== index));
  };

  const fillFromJson = () => {
    const parsed = parseCeilingRulesJson(pasteText, nextKey);
    if (!parsed.ok) {
      setPasteProblems(parsed.problems);
      return;
    }
    setPasteProblems(null);
    setPasteOpen(false);
    setPasteText('');
    onRowsChange(parsed.rows);
    setFilledNote(`Filled ${parsed.rows.length} ${parsed.rows.length === 1 ? 'rule' : 'rules'} from the pasted JSON.`);
  };

  const hintId = `${idPrefix}-hint`;
  const problemsId = `${idPrefix}-problems`;
  const pasteId = `${idPrefix}-paste`;
  const pasteProblemsId = `${idPrefix}-paste-problems`;
  const showProblems = Boolean(problems && problems.length > 0);

  return (
    <fieldset
      className="axm-rules axm-editor-wide"
      disabled={disabled}
      aria-describedby={showProblems ? `${hintId} ${problemsId}` : hintId}
    >
      <legend>Ceiling rules <span className="axm-muted">instead of a profile: published as this warrant&rsquo;s own profile</span></legend>
      <p id={hintId} className="axm-muted">
        {disabled
          ? 'A published profile is chosen above. Clear it to enter rules for this warrant instead.'
          : rows.length > 0
            ? 'These rules are sent with the warrant; the server publishes them as a new Access profile inside the same act and pins that version. The profile selector stays off while any rule is here.'
            : 'Add a rule, or paste the rules as JSON. Leave this empty to choose a published profile instead.'}
      </p>

      {rows.map((row, index) => {
        const n = index + 1;
        const base = `${idPrefix}-${row.key}`;
        const idsLabel = row.selectorForm === 'all-in-project' ? 'Project ids' : 'Ids';
        return (
          <div key={row.key} className="axm-rule" role="group" aria-label={`Rule ${n}`}>
            <div className="axm-rule-head">
              <strong>Rule {n}</strong>
              <Button
                variant="secondary"
                size="compact"
                icon={<Trash2 size={16} />}
                ariaLabel={`Remove rule ${n}`}
                onClick={() => removeRow(index)}
              >
                Remove
              </Button>
            </div>
            <div className="axm-rule-grid">
              <div className="form-group">
                <label htmlFor={`${base}-type`}>Resource type</label>
                <Select id={`${base}-type`} value={row.resourceType} onChange={(event) => changeType(index, event.target.value)}>
                  {CEILING_RESOURCE_TYPES.map((type) => (
                    <option key={type} value={type} disabled={type !== row.resourceType && usedTypes.has(type)}>{type}</option>
                  ))}
                </Select>
              </div>
              <div className="form-group">
                <label htmlFor={`${base}-form`}>Selector</label>
                <Select
                  id={`${base}-form`}
                  aria-describedby={`${base}-form-meaning`}
                  value={row.selectorForm}
                  onChange={(event) => changeForm(index, event.target.value)}
                >
                  {formsFor(row.resourceType).map((form) => (
                    <option key={form} value={form}>{form}</option>
                  ))}
                </Select>
                <span id={`${base}-form-meaning`} className="axm-muted">
                  {CEILING_FORM_MEANINGS[row.selectorForm as keyof typeof CEILING_FORM_MEANINGS] ?? ''}
                </span>
              </div>
              {row.selectorForm !== 'all-of-type' && (
                <div className="form-group">
                  <label htmlFor={`${base}-ids`}>{idsLabel} <span className="axm-muted">comma-separated UUIDs</span></label>
                  <input
                    id={`${base}-ids`}
                    className="form-input"
                    type="text"
                    spellCheck={false}
                    autoComplete="off"
                    value={row.selectorIds}
                    onChange={(event) => update(index, { selectorIds: event.target.value })}
                  />
                </div>
              )}
            </div>
            <fieldset className="axm-rule-verbs">
              <legend>Verbs</legend>
              <div className="axm-chipset">
                {CEILING_VERBS.map((verb) => (
                  <label key={verb} className={`axm-scope ${row.verbs.includes(verb) ? '' : 'axm-scope--dropped'}`}>
                    <input type="checkbox" checked={row.verbs.includes(verb)} onChange={() => toggleVerb(index, verb)} /> {verb}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        );
      })}

      <div className="axm-rules-tools">
        <Button variant="secondary" size="compact" icon={<Plus size={16} />} onClick={addRow} disabled={!unusedType}>
          Add rule
        </Button>
        <Button
          variant="secondary"
          size="compact"
          icon={<ClipboardPaste size={16} />}
          ariaExpanded={pasteOpen}
          ariaControls={pasteOpen ? pasteId : undefined}
          onClick={() => { setPasteOpen((open) => !open); setPasteProblems(null); }}
        >
          Paste rules JSON
        </Button>
        {filledNote && <span className="axm-muted" role="status">{filledNote}</span>}
      </div>

      {pasteOpen && (
        <div id={pasteId} className="axm-rules-paste">
          <label htmlFor={`${idPrefix}-json`}>
            Rules JSON <span className="axm-muted">an array of {'{resourceType, selectorForm, selectorIds, verbs}'}; it replaces every row above</span>
          </label>
          <textarea
            id={`${idPrefix}-json`}
            className="form-textarea form-textarea-mono"
            rows={6}
            spellCheck={false}
            value={pasteText}
            aria-invalid={pasteProblems ? true : undefined}
            aria-describedby={pasteProblems ? pasteProblemsId : undefined}
            onChange={(event) => setPasteText(event.target.value)}
          />
          {pasteProblems && (
            <div id={pasteProblemsId} className="axm-rule-problems" role="alert">
              <p>Nothing was filled. The pasted rules would be refused:</p>
              <ul>{pasteProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            </div>
          )}
          <div className="axm-rules-tools">
            <Button variant="primary" size="compact" onClick={fillFromJson} disabled={!pasteText.trim()}>
              Fill rows from JSON
            </Button>
            <Button variant="secondary" size="compact" onClick={() => { setPasteOpen(false); setPasteProblems(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {showProblems && (
        <div id={problemsId} className="axm-rule-problems" role="alert">
          <p>The warrant was not sent. Fix these rules first:</p>
          <ul>{(problems ?? []).map((problem) => <li key={problem}>{problem}</li>)}</ul>
        </div>
      )}
    </fieldset>
  );
};
