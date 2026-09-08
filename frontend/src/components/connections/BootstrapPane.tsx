import React, { useMemo, useState } from 'react';
import { Copy, Check, Terminal, ShieldAlert } from 'lucide-react';
import { SegmentedControl } from '../ui/SegmentedControl';
import type { SegmentedOption } from '../ui/SegmentedControl';
import {
  BootstrapTab, ConnectionTransport, TAB_LABELS, tabAppliesToTransport,
} from '../../types/connections';
import './connections.css';

/**
 * The bootstrap pane (owner design record 99d6b0ad §3.1).
 *
 * "One tab per harness, ONE copy block (endpoint + token + setup line), the
 * sentence *paste this into your agent and let it configure itself*."
 *
 * The pane renders the ONBOARDING PACK and nothing else. Every line in the copy
 * block comes from the pack the server composed (AUTHZ §7.4) — this component
 * assembles no configuration of its own, so a snippet here cannot drift from
 * the one the board hands to a CLI or the REST response.
 *
 * TWO USES, ONE COMPONENT. In wizard step 3 the pack carries the real
 * credential, shown exactly once. On My connections the same pane re-opens with
 * the server's placeholder where the token was: the endpoint and the setup line
 * are not secret and the owner record says they are re-shown any time, but the
 * secret is gone and the pane says so rather than implying it could be fetched.
 *
 * TRANSPORT HONESTY. A credential pinned `mcp` is refused on every REST route
 * and an `api` pin is refused through the MCP endpoint (§7.5). So a tab the
 * connection's transport does not admit is disabled with that reason, instead
 * of handing someone a snippet that will authenticate and then be refused.
 *
 * EVERY ENABLED TAB MUST BE COMPLETE ON ITS OWN (card `b68c48c1`). The Codex
 * snippet defers its credential to an environment variable, which is that
 * harness's correct shape and left the tab with nothing to copy: the credential
 * is shown exactly once, so a person who landed there could not finish without
 * reading another tab. `tokenEnvBlock` below closes that, from the pack's own
 * `cliEnv` — see the note there.
 */

export interface BootstrapPaneProps {
  /** Exactly the pack the server composed. */
  mcpConfig: { claudeCode: unknown; codex: string; generic: unknown };
  cliEnv: string[];
  bootstrapLine: string;
  boardEndpoint: string;
  transport: ConnectionTransport;
  /** Which tab opens first — the template's, when one made this connection. */
  initialTab?: BootstrapTab;
  /**
   * True in wizard step 3, where the block carries the one-time credential.
   * False when the pane re-opens later over the server's placeholder.
   */
  carriesSecret: boolean;
  /** Rendered under the copy block. */
  footer?: React.ReactNode;
  /**
   * What to do about a credential the person no longer has, already resolved
   * for THIS session by `lostCredentialRecovery`.
   *
   * It arrives as a prop rather than being written here because this pane is
   * rendered on two surfaces and had two hard-coded sentences of its own, both
   * telling every reader to regenerate — which My connections disables for a
   * Member (round-3 finding P3-R3). A component that does not know the caller's
   * authority must not compose advice about it.
   */
  recovery: string;
}

const TAB_ORDER: BootstrapTab[] = ['claudeCode', 'codex', 'generic', 'cli'];

/** The exact text of one tab's copy block, from the pack alone. */
export function blockFor(
  tab: BootstrapTab,
  pack: { mcpConfig: { claudeCode: unknown; codex: string; generic: unknown }; cliEnv: string[] },
): string {
  if (tab === 'codex') return pack.mcpConfig.codex;
  if (tab === 'cli') return pack.cliEnv.join('\n');
  const config = tab === 'claudeCode' ? pack.mcpConfig.claudeCode : pack.mcpConfig.generic;
  return JSON.stringify(config, null, 2);
}

/**
 * The variable the Codex snippet points at, and the one the CLI pack exports.
 * ONE name, because the two blocks below have to agree about it and a second
 * string literal is a rename away from a page that tells a person to set a
 * variable nothing reads.
 */
export const TOKEN_ENV_VAR = 'RELAYHALL_TOKEN';

/**
 * THE CREDENTIAL LITERAL, TAKEN FROM THE PACK — card `b68c48c1`.
 *
 * The Codex tab renders the harness's own shape: a `config.toml` block whose
 * `bearer_token_env_var = "RELAYHALL_TOKEN"` names an environment variable
 * rather than carrying a secret into a config file. That is right, and it left
 * a person who landed on that tab with no way to finish: the credential is
 * shown exactly once, on this screen, and nothing on the tab said what to
 * export. Switching tabs to steal the value out of the Claude Code block is not
 * a setup flow.
 *
 * The value is READ BACK OUT OF `cliEnv`, which the server composed
 * (`utils/onboardingPack.ts`), rather than taken from a new prop. Two reasons,
 * both load-bearing: this pane's whole claim is that every line it shows came
 * from the pack, and the SAME pane re-opens on My connections over a pack whose
 * credential is the server's placeholder — so the placeholder arrives here by
 * the same path as the secret, and no arm of this component has to know which
 * of the two it is holding.
 */
export function tokenValueFrom(cliEnv: string[]): string | null {
  const prefix = `export ${TOKEN_ENV_VAR}=`;
  const line = cliEnv.find((entry) => entry.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value ? value : null;
}

/**
 * The two shell lines that set it, in the two shells a person actually has.
 * POSIX first because that is what the CLI pack already publishes; PowerShell
 * beside it because `export` is a syntax error in it and a Windows reader
 * otherwise has to translate a credential by hand.
 */
export function tokenEnvBlock(value: string): string {
  return [
    `export ${TOKEN_ENV_VAR}=${value}`,
    `$env:${TOKEN_ENV_VAR} = "${value}"`,
  ].join('\n');
}

const FILE_HINT: Record<BootstrapTab, string> = {
  claudeCode: 'Save as .mcp.json in the project, or merge into the existing one.',
  codex: 'Append to ~/.codex/config.toml.',
  generic: 'Whatever your client calls its MCP server list.',
  cli: 'Export these in the shell that runs the script.',
};

export const BootstrapPane: React.FC<BootstrapPaneProps> = ({
  mcpConfig, cliEnv, bootstrapLine, boardEndpoint, transport,
  initialTab = 'claudeCode', carriesSecret, footer, recovery,
}) => {
  const admits = useMemo(
    () => TAB_ORDER.filter((tab) => tabAppliesToTransport(tab, transport)),
    [transport],
  );
  const [tab, setTab] = useState<BootstrapTab>(
    admits.includes(initialTab) ? initialTab : (admits[0] ?? 'generic'),
  );
  const [copied, setCopied] = useState<string | null>(null);

  const options: Array<SegmentedOption<BootstrapTab>> = TAB_ORDER.map((value) => {
    const applies = tabAppliesToTransport(value, transport);
    return {
      value,
      label: TAB_LABELS[value],
      disabled: !applies,
      title: applies
        ? undefined
        : `This connection's credential is pinned to the ${transport} transport, so this client would be refused.`,
    };
  });

  const block = blockFor(tab, { mcpConfig, cliEnv });
  /** Only the Codex snippet defers its credential to a variable, so only that
   *  tab is missing the literal — the CLI pack exports it in its own block, and
   *  the two JSON blocks carry it in an `Authorization` header. */
  const tokenValue = tokenValueFrom(cliEnv);
  const envBlock = tab === 'codex' && tokenValue ? tokenEnvBlock(tokenValue) : null;

  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      // A blocked clipboard is not a failure of the flow: the block is on
      // screen and selectable. Say what happened rather than nothing.
      setCopied('blocked');
    }
  };

  return (
    <div className="conn-bootstrap">
      <p className="conn-bootstrap-lede">Paste this into your agent and let it configure itself.</p>

      <SegmentedControl
        options={options}
        value={tab}
        onChange={setTab}
        ariaLabel="Client to configure"
        className="conn-bootstrap-tabs"
      />

      <p className="conn-bootstrap-hint">{FILE_HINT[tab]}</p>

      <div className="conn-copyblock">
        <div className="conn-copyblock-head">
          <span className="conn-copyblock-title">
            <Terminal size={16} aria-hidden="true" /> {TAB_LABELS[tab]}
          </span>
          <button
            type="button"
            className="conn-copybtn"
            onClick={() => copy(tab, block)}
            aria-label={`Copy the ${TAB_LABELS[tab]} setup block`}
          >
            {copied === tab
              ? <><Check size={16} aria-hidden="true" /> Copied</>
              : <><Copy size={16} aria-hidden="true" /> Copy</>}
          </button>
        </div>
        <pre className="conn-copyblock-body"><code>{block}</code></pre>
      </div>

      {envBlock && (
        <div className="conn-copyblock">
          <div className="conn-copyblock-head">
            <span className="conn-copyblock-title">
              <Terminal size={16} aria-hidden="true" /> Set {TOKEN_ENV_VAR}
            </span>
            <button
              type="button"
              className="conn-copybtn"
              onClick={() => copy('codex-env', envBlock)}
              aria-label={`Copy the ${TOKEN_ENV_VAR} lines`}
            >
              {copied === 'codex-env'
                ? <><Check size={16} aria-hidden="true" /> Copied</>
                : <><Copy size={16} aria-hidden="true" /> Copy</>}
            </button>
          </div>
          <pre className="conn-copyblock-body"><code>{envBlock}</code></pre>
          <p className="conn-bootstrap-hint">
            The block above names this variable instead of carrying the credential.
            Run the line for your shell — the first in bash or zsh, the second in
            PowerShell — in the shell that starts Codex.
          </p>
        </div>
      )}

      <div className="conn-bootstrap-line">
        <span className="conn-bootstrap-line-label">Setup line</span>
        <p className="conn-bootstrap-line-text">{bootstrapLine}</p>
      </div>

      {copied === 'blocked' && (
        <p className="conn-warn" role="status">
          Your browser refused clipboard access — select the block above and copy it by hand.
        </p>
      )}

      {carriesSecret ? (
        <p className="conn-warn" role="status">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>
            The credential on this screen is shown once and is never stored on the board.
            Copy it now; if you lose it, {recovery}.
          </span>
        </p>
      ) : (
        <p className="conn-note">
          The endpoint and the setup lines are not secret, so they are re-shown here any time.
          The credential is not: it was displayed once when the connection was made. If you no
          longer have it, {recovery}.
        </p>
      )}

      <p className="conn-note">
        Board endpoint: <code className="conn-inline-code">{boardEndpoint}</code>
      </p>

      {footer}
    </div>
  );
};
