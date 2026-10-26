import React, { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Download, Upload } from 'lucide-react';
import { Button } from '../Button';
import { StepUpDialog } from '../access/StepUpDialog';
import {
  KNOWLEDGE_SOURCE_REGISTER_STEP_UP_ACTION, RegistrationRequestError, fetchRegistrations, fetchReturnBundle,
  previewBundle, registerKnowledgeSource,
  type BundlePreview, type RegistrationState, type ReturnBundle,
} from '../../utils/knowledgeSourceRegistrationApi';
import './KnowledgeSourceRegistrationPanel.css';

/** The step-up the registration is waiting on, and the act it unlocks. */
interface PendingStepUp { fingerprint: string; description: string; advertised?: Array<'password' | 'sso'> }

/** A refusal in words: the code the board named and its own sentence. */
function refusalText(error: unknown): string {
  if (error instanceof RegistrationRequestError) return `Refused (${error.code}): ${error.message}`;
  return 'The request could not be sent. Try again.';
}

/** Offer the return bundle as a file the browser saves. */
function downloadJson(name: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * ONE REGISTERED SOURCE: its state, honestly. The fingerprint as it was
 * confirmed, what a search of it answers now, the operator's step by NAME
 * (never a value), the return bundle to hand back to the installer, and the
 * grant its readers need, made on Access grants. The page offers no change
 * request for that grant: today the board refuses an administrator's grant.rows
 * filing for a Service read grant ALREADY_HELD (knowledgeSourceRegistrationLive
 * pins that answer), so a button would only ever be refused.
 */
function RegistrationCard({ state, onMessage }: { state: RegistrationState; onMessage: (text: string, kind: 'status' | 'alert') => void }) {
  const headingId = useId();
  const [bundle, setBundle] = useState<ReturnBundle | null>(null);
  const waiting = !state.channel.resolves;

  const withBundle = async (act: (value: ReturnBundle) => Promise<void> | void) => {
    try {
      const value = bundle ?? await fetchReturnBundle(state.service.id);
      setBundle(value);
      await act(value);
    } catch (error) {
      onMessage(refusalText(error), 'alert');
    }
  };

  return <article className="ksr-card" aria-labelledby={headingId}>
    <h4 id={headingId} className="ksr-card-title">{state.service.name}</h4>
    <dl className="ksr-facts">
      <div><dt>Service id</dt><dd className="ksr-mono">{state.service.id}</dd></div>
      <div><dt>Endpoint</dt><dd className="ksr-mono">{state.endpoints.query ?? 'none'}</dd></div>
      {state.endpoints.allowedNetworks.length > 0 && <div><dt>Allowed networks</dt><dd className="ksr-mono">{state.endpoints.allowedNetworks.join(', ')}</dd></div>}
      <div><dt>Certificate fingerprint (sha256)</dt><dd className="ksr-mono">{state.fingerprint.display}</dd></div>
      <div><dt>Fingerprint confirmed</dt><dd>{state.fingerprint.confirmation === 'checked' ? 'Checked against the installer console' : 'Typed from the installer console'} on {new Date(state.fingerprint.confirmedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</dd></div>
      <div><dt>Channel credential reference</dt><dd className="ksr-mono">{state.channel.credentialReference ?? 'none'}</dd></div>
    </dl>
    <p className="ksr-note">The fingerprint was checked when the bundle was uploaded. The board does not pin it: it reaches this source only through a certificate its default trust store accepts.</p>

    <section className="ksr-state" aria-label={`Connection state of ${state.service.name}`}>
      {waiting ? <>
        <p className="ksr-state-line"><strong>Waiting for the operator.</strong> Until the step below is done, every search of this source answers <span className="ksr-mono">{state.channel.refusal}</span>.</p>
        <ol className="ksr-steps">
          {state.operatorSteps.map((step) => <li key={step.id}>{step.text}</li>)}
        </ol>
      </> : <>
        <p className="ksr-state-line"><strong>Channel credential in place.</strong> The board finds an entry named <span className="ksr-mono">{state.channel.credentialReference}</span> in its environment, so it now tries this source when someone searches.</p>
        <p className="ksr-note">That is not yet a successful connection. The board trusts only its default certificate store, so the source&apos;s certificate must chain to a public certificate authority for the endpoint&apos;s name. A self-signed or private-authority certificate still fails every search with <span className="ksr-mono">unavailable:transport</span>.</p>
      </>}
      {!state.lifecycleExport.configured && <p className="ksr-note">The lifecycle exporter is not signing snapshots for this Service yet, so the return bundle carries no lifecycle key. Configure it for this Service id and download the return bundle again.</p>}
    </section>

    <div className="ksr-actions">
      <Button size="compact" variant="secondary" icon={<Download size={16} aria-hidden="true" />}
        onClick={() => void withBundle((value) => { downloadJson(`return-bundle-${state.service.slug}.json`, value); onMessage('Return bundle downloaded. Import it with the installer.', 'status'); })}>
        Download the return bundle
      </Button>
      <Button size="compact" variant="secondary" icon={<Copy size={16} aria-hidden="true" />}
        onClick={() => void withBundle(async (value) => {
          if (!navigator.clipboard) { onMessage('This browser cannot copy here. Use Download instead.', 'alert'); return; }
          await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
          onMessage('Return bundle copied. It holds public keys and ids only.', 'status');
        })}>
        Copy the return bundle
      </Button>
    </div>

    <section className="ksr-grants" aria-label={`Grants for ${state.service.name}`}>
      <p className="ksr-note">Each person who searches this source needs <span className="ksr-mono">{state.grantsForApproval.scope}</span> and a read grant on this Service. Root, or an admin or orchestrator signed in to the dashboard, makes the grant on <Link to="/settings/access">Access grants</Link> (resource type service, this Service id, verb read). An operator cannot make it there.</p>
    </section>
  </article>;
}

/**
 * SETTINGS > SERVICES: REGISTER A KNOWLEDGE SOURCE (card 08792425, member N6;
 * the default-store design's choice C7, "two-way registration, no new
 * credential type").
 *
 * The board decides who sees it: the panel asks `GET
 * /knowledge-source-registrations`, and a session the board refuses (anything
 * but root or an administrator login session) is told so and offered nothing.
 * An administrator pastes or uploads the installer's bundle, compares the
 * fingerprint with the installer's console and ticks that it matches, then
 * confirms it is them (a single-use step-up bound to the fingerprint). The
 * board checks all of it again.
 */
export const KnowledgeSourceRegistrationPanel: React.FC = () => {
  const idBase = useId();
  const [registrations, setRegistrations] = useState<RegistrationState[] | null>(null);
  const [refused, setRefused] = useState(false);
  const [text, setText] = useState('');
  const [networks, setNetworks] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [stepUp, setStepUp] = useState<PendingStepUp | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setRegistrations(await fetchRegistrations());
    } catch (error) {
      if (error instanceof RegistrationRequestError && (error.status === 401 || error.status === 403)) { setRefused(true); return; }
      setRegistrations([]);
      setMessage({ kind: 'alert', text: 'The registered knowledge sources could not be loaded.' });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const preview = text.trim().length > 0 ? previewBundle(text) : null;
  const ready: BundlePreview | null = preview && preview.ok ? preview.preview : null;
  // A fingerprint change is a different certificate: the tick never carries over.
  useEffect(() => { setConfirmed(false); }, [ready?.fingerprint]);
  const allowedNetworks = networks.split(/[\s,]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
  };

  const register = (token: string, bundle: BundlePreview) => {
    setStepUp(null);
    void (async () => {
      setBusy(true);
      setMessage(null);
      try {
        const done = await registerKnowledgeSource({
          bundle: bundle.bundle, confirmedFingerprint: bundle.fingerprint, allowedNetworks, stepUpToken: token,
        });
        setText('');
        setNetworks('');
        setConfirmed(false);
        await load();
        setMessage({ kind: 'status', text: `${done.registration.service.name} is registered. Hand the return bundle to the installer, then do the operator step shown below.` });
      } catch (error) {
        setMessage({ kind: 'alert', text: refusalText(error) });
      } finally {
        setBusy(false);
      }
    })();
  };

  if (refused) {
    return <section className="ksr-panel" aria-label="Knowledge sources">
      <h2 className="ksr-heading">Knowledge sources</h2>
      <p className="ksr-note">Registering a knowledge source is for root or an administrator, signed in to the dashboard.</p>
    </section>;
  }
  if (registrations === null) return <p role="status">Loading the knowledge sources…</p>;

  return <section className="ksr-panel" aria-label="Knowledge sources">
    <h2 className="ksr-heading">Knowledge sources</h2>
    <p className="ksr-note">Register a knowledge source from the bundle its installer printed. The board creates the Service, records its endpoint and the fingerprint you confirm, and gives you a return bundle for the installer. Nothing secret passes through this page.</p>
    {message && <p role={message.kind} className="ksr-message">{message.text}</p>}

    <form className="ksr-form" onSubmit={(event) => {
      event.preventDefault();
      if (!ready || !confirmed || busy) return;
      setStepUp({ fingerprint: ready.fingerprint, description: `Register the knowledge source ${ready.name || ready.endpoint} at ${ready.endpoint}, whose certificate fingerprint you confirmed.` });
    }}>
      <h3 className="ksr-subheading">Register a knowledge source</h3>
      <div className="form-group">
        <label htmlFor={`${idBase}-bundle`}>Registration bundle <span className="ksr-hint">paste the JSON the installer printed</span></label>
        <textarea id={`${idBase}-bundle`} className="form-input ksr-bundle" value={text} spellCheck={false}
          onChange={(event) => setText(event.target.value)} />
      </div>
      <div className="form-group">
        <label htmlFor={`${idBase}-file`}>Or upload the bundle file</label>
        <span className="ksr-file">
          <Upload size={16} aria-hidden="true" />
          <input id={`${idBase}-file`} type="file" accept="application/json,.json"
            onChange={(event) => void readFile(event.target.files?.[0])} />
        </span>
      </div>
      {preview && !preview.ok && <p role="alert">{preview.message}</p>}
      {ready && <div className="ksr-preview">
        <dl className="ksr-facts">
          <div><dt>Name</dt><dd>{ready.name || 'none'}</dd></div>
          <div><dt>Endpoint</dt><dd className="ksr-mono">{ready.endpoint || 'none'}</dd></div>
          <div><dt>Descriptor</dt><dd>{ready.protocolVersion === 2 ? 'knowledge protocol version 2' : 'not a version 2 knowledge descriptor; the board will refuse it'}</dd></div>
          <div><dt>Certificate fingerprint (sha256)</dt><dd className="ksr-mono ksr-fingerprint">{ready.fingerprintDisplay}</dd></div>
        </dl>
        <div className="form-group">
          <label htmlFor={`${idBase}-networks`}>Allowed networks <span className="ksr-hint">only for a private endpoint address: CIDRs, separated by commas</span></label>
          <input id={`${idBase}-networks`} className="form-input" type="text" value={networks} onChange={(event) => setNetworks(event.target.value)} />
        </div>
        <label className="ksr-confirm">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          I compared this fingerprint with the one the installer printed on its console, and they match.
        </label>
        <div className="ksr-actions">
          <Button type="submit" size="compact" variant="primary" disabled={!confirmed || busy}>
            {busy ? 'Registering…' : 'Register'}
          </Button>
        </div>
      </div>}
    </form>

    <h3 className="ksr-subheading">Registered knowledge sources</h3>
    {registrations.length === 0
      ? <p className="ksr-note">No knowledge source has been registered from a bundle yet.</p>
      : <div className="ksr-list">{registrations.map((state) => <RegistrationCard key={state.service.id} state={state}
        onMessage={(value, kind) => setMessage({ kind, text: value })} />)}</div>}

    {stepUp && ready && <StepUpDialog action={KNOWLEDGE_SOURCE_REGISTER_STEP_UP_ACTION} targetId={stepUp.fingerprint}
      description={stepUp.description} advertisedMethods={stepUp.advertised}
      onToken={(token) => register(token, ready)} onCancel={() => setStepUp(null)} />}
  </section>;
};
