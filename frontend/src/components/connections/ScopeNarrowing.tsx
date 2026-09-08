import React from 'react';
import './connections.css';

/**
 * The scopes editor (owner design record 99d6b0ad decision 1 and §3.1
 * "Advanced tab: scopes editor").
 *
 * ONE implementation, two callers: the *narrow it* disclosure in wizard step 1
 * and the Advanced tab of an existing connection. The wizard sends what this
 * returns as `issueCredential.scopes`; the Advanced tab shows it read-only,
 * because narrowing a LIVE credential is not something a credential rotation
 * may do (AUTHZ §7.3: rotation is an exact copy, and a rotation request
 * carrying a scope change is refused) — narrowing happens by making a narrower
 * connection, which is what the panel says.
 *
 * THE CEILING IS WHAT THE SESSION MAY DELEGATE. `POST /services` refuses
 * `ISSUE_EXCEEDS_SESSION` for anything outside the caller's current effective
 * scopes (§5.2 rule 1), and refuses `root` however the caller holds it (§5.2
 * rule 2). This control therefore offers exactly the set the board will accept
 * — `GET /principals/me` answers it as `delegableScopes` — and nothing else:
 * the list is not a static menu that could drift above what the server takes,
 * and it can no longer offer an administrator the one scope that is certain to
 * be refused (card 6e25ae48).
 */
export interface ScopeNarrowingProps {
  /** What the session may delegate — the ceiling and the whole menu. */
  available: string[];
  selected: string[];
  onChange?: (next: string[]) => void;
  /** True on the Advanced tab, where the set is what a credential already has. */
  readOnly?: boolean;
  idPrefix: string;
  /**
   * The template's recommended set, already intersected with `available`.
   * Offered as an action, never applied on its own — decision 1 rules that the
   * DEFAULT stays "everything you can do".
   */
  recommended?: string[];
  recommendedLabel?: string;
}

export const ScopeNarrowing: React.FC<ScopeNarrowingProps> = ({
  available, selected, onChange, readOnly = false, idPrefix,
  recommended, recommendedLabel,
}) => {
  const toggle = (scope: string) => {
    if (!onChange) return;
    onChange(selected.includes(scope)
      ? selected.filter((s) => s !== scope)
      : [...selected, scope]);
  };

  if (available.length === 0) {
    return (
      <p className="conn-note" role="status">
        This session carries no authority to pass on, so there is nothing to narrow.
      </p>
    );
  }

  return (
    <div className="conn-scopes">
      {!readOnly && (
        <div className="conn-scopes-tools">
          <button type="button" className="conn-linkbtn" onClick={() => onChange?.([...available])}>
            Select all
          </button>
          <button type="button" className="conn-linkbtn" onClick={() => onChange?.([])}>
            Clear
          </button>
          {recommended && recommended.length > 0 && (
            <button type="button" className="conn-linkbtn" onClick={() => onChange?.([...recommended])}>
              {recommendedLabel ?? 'Use the recommended set'}
            </button>
          )}
        </div>
      )}
      <ul className="conn-scopelist">
        {available.map((scope) => {
          const id = `${idPrefix}-${scope.replace(/[^a-z0-9]+/gi, '-')}`;
          return (
            <li key={scope} className="conn-scopeitem">
              {readOnly ? (
                <span className={selected.includes(scope) ? 'conn-scope conn-scope--on' : 'conn-scope'}>
                  {scope}
                </span>
              ) : (
                <label className="conn-scope" htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={selected.includes(scope)}
                    onChange={() => toggle(scope)}
                  />
                  {scope}
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {!readOnly && selected.length === 0 && (
        <p className="conn-warn" role="status">
          A connection with no authority can still authenticate, but every board call it makes is
          refused. Choose at least one.
        </p>
      )}
    </div>
  );
};
