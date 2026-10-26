import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Github } from 'lucide-react';
import { Wordmark } from '../components/Wordmark';
import { loadAppearanceInfo, type AppearanceInfo, type AppearanceLink } from '../services/appearance';
import { BLUEPRINT_GUIDE_URL, DOCS_URL, LICENSE_URL, PROBLEM_URL, PRODUCT_URL, SOURCE_LABEL, SOURCE_URL } from '../utils/build';
import {
  builtAtInstant,
  isUnreleasedVersion,
  loadApiInfo,
  loadReleaseManifest,
  type ApiInfo,
  type BuildIdentity,
} from '../utils/releaseInfo';
import { renderMarkdownSafe } from '../utils/renderMarkdown';
import './AboutPage.css';

interface AboutFacts {
  manifest: BuildIdentity | null;
  api: ApiInfo | null;
  appearance: AppearanceInfo | null;
}

const UNAVAILABLE = 'Unavailable';

/** 'A', 'A and B', 'A, B and C'. */
function listPhrase(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function nonBlank(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeHttpLink(link: AppearanceLink): AppearanceLink | null {
  const label = nonBlank(link.label);
  const url = nonBlank(link.url);
  if (!label || !url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? { ...link, label, url: parsed.toString() }
      : null;
  } catch {
    return null;
  }
}

function ProductLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}<ExternalLink size={16} aria-hidden="true" />
    </a>
  );
}

/**
 * A version exactly as the artefact reported it. There is deliberately no
 * fallback: a version the artefact did not report is Unavailable, never the
 * bundled package version passed off as what is deployed.
 */
function VersionValue({ version }: { version: string | null | undefined }) {
  if (!version) return <>{UNAVAILABLE}</>;
  return (
    <>
      {version}
      {isUnreleasedVersion(version) && <span className="about-page__qualifier"> (unreleased build)</span>}
    </>
  );
}

function BuildFacts({ heading, headingId, identity }: { heading: string; headingId: string; identity: BuildIdentity | null }) {
  const instant = identity?.builtAt ? builtAtInstant(identity.builtAt) : null;
  return (
    <section className="about-page__build" aria-labelledby={headingId}>
      <h3 id={headingId}>{heading}</h3>
      <dl className="about-page__facts">
        <div><dt>Build SHA</dt><dd>{identity?.sha ? <code>{identity.sha}</code> : UNAVAILABLE}</dd></div>
        <div><dt>Dirty</dt><dd>{identity?.dirty ? <code>{identity.dirty}</code> : UNAVAILABLE}</dd></div>
        <div><dt>Build context</dt><dd>{identity?.buildContext ? <code>{identity.buildContext}</code> : UNAVAILABLE}</dd></div>
        <div>
          <dt>Built at</dt>
          <dd>{identity?.builtAt && instant ? <time dateTime={instant}>{identity.builtAt}</time> : UNAVAILABLE}</dd>
        </div>
      </dl>
    </section>
  );
}

/** What the two artefacts report differently, when both report it. */
function identityConflicts(frontend: BuildIdentity | null, api: ApiInfo | null): string[] {
  const conflicts: string[] = [];
  if (frontend?.version && api?.version && frontend.version !== api.version) conflicts.push('version');
  if (frontend?.sha && api?.build?.sha && frontend.sha !== api.build.sha) conflicts.push('build SHA');
  return conflicts;
}

function identityIncomplete(frontend: BuildIdentity | null, api: ApiInfo | null): boolean {
  const complete = (identity: BuildIdentity | null | undefined) => Boolean(
    identity && identity.version && identity.sha && identity.dirty && identity.buildContext && identity.builtAt,
  );
  return !complete(frontend) || !api?.version || !complete(api.build);
}

export function AboutPage() {
  const [facts, setFacts] = useState<AboutFacts>({ manifest: null, api: null, appearance: null });
  const [failures, setFailures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setFacts({ manifest: null, api: null, appearance: null });
    setFailures([]);
    setLoading(true);
    Promise.allSettled([
      loadReleaseManifest(controller.signal),
      loadApiInfo(controller.signal),
      loadAppearanceInfo(controller.signal),
    ]).then(([manifest, api, appearance]) => {
      if (!active) return;
      const nextFailures: string[] = [];
      if (manifest.status === 'rejected') nextFailures.push('Build identity');
      if (api.status === 'rejected') nextFailures.push('API version');
      if (appearance.status === 'rejected') nextFailures.push('Deployment information');
      setFacts({
        manifest: manifest.status === 'fulfilled' ? manifest.value : null,
        api: api.status === 'fulfilled' ? api.value : null,
        appearance: appearance.status === 'fulfilled' ? appearance.value : null,
      });
      setFailures(nextFailures);
      setLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);

  const retry = () => setAttempt(current => current + 1);

  const deployment = useMemo(() => {
    if (!facts.appearance) return null;
    const displayName = nonBlank(facts.appearance.displayName);
    const description = nonBlank(facts.appearance.description);
    const teamMarkdown = nonBlank(facts.appearance.teamMarkdown);
    const links = facts.appearance.links.map(safeHttpLink).filter((link): link is AppearanceLink => link !== null);
    if (!displayName && !description && !teamMarkdown && links.length === 0) return null;
    return { displayName, description, teamMarkdown, links };
  }, [facts.appearance]);

  const conflicts = identityConflicts(facts.manifest, facts.api);
  const incomplete = !loading && failures.length === 0 && identityIncomplete(facts.manifest, facts.api);

  return (
    <div className="about-page">
      <header className="about-page__header">
        <h1>About</h1>
        <p>Product identity and deployment information for this RelayHall instance.</p>
      </header>

      {failures.length > 0 && (
        <div className="about-page__error" role="alert">
          <span>{listPhrase(failures)} {failures.length === 1 ? 'is' : 'are'} unavailable.</span>
          <button type="button" onClick={retry}>Retry</button>
        </div>
      )}
      {incomplete && (
        <div className="about-page__notice">
          <span>Some build identity fields are unavailable: the build did not record them, or they could not be read.</span>
          <button type="button" onClick={retry}>Retry</button>
        </div>
      )}
      {loading && <p className="about-page__loading" role="status">Loading release information…</p>}

      {!loading && (
        <>
          <section className="about-page__card" aria-labelledby="about-product-heading">
            <div className="about-page__identity">
              <Wordmark height={28} />
              <h2 id="about-product-heading">Product</h2>
            </div>
            <dl className="about-page__facts">
              <div><dt>Version</dt><dd><VersionValue version={facts.manifest?.version} /></dd></div>
              <div><dt>API version</dt><dd><VersionValue version={facts.api?.version} /></dd></div>
            </dl>
            <nav className="about-page__links" aria-label="RelayHall product links">
              <ProductLink href={LICENSE_URL}>MIT licence</ProductLink>
              <ProductLink href={SOURCE_URL}>{SOURCE_LABEL}</ProductLink>
              <ProductLink href={DOCS_URL}>Documentation</ProductLink>
              <ProductLink href={BLUEPRINT_GUIDE_URL}>Blueprint authoring and use guide</ProductLink>
              <ProductLink href={PROBLEM_URL}>Report a problem</ProductLink>
            </nav>
          </section>

          <section className="about-page__card" aria-labelledby="about-build-heading">
            <h2 id="about-build-heading">Build identity</h2>
            <p>Read from what each deployed artefact recorded when it was built.</p>
            {conflicts.length > 0 && (
              <p className="about-page__conflict" role="status" aria-labelledby="about-conflict-heading">
                <strong id="about-conflict-heading">Frontend and backend identities differ</strong>: {listPhrase(conflicts)}.
              </p>
            )}
            <BuildFacts heading="Frontend build" headingId="about-frontend-build-heading" identity={facts.manifest} />
            <BuildFacts heading="Backend build" headingId="about-backend-build-heading" identity={facts.api?.build ?? null} />
          </section>

          {deployment && (
            <section className="about-page__card" aria-labelledby="about-deployment-heading">
              <h2 id="about-deployment-heading">Deployment</h2>
              {deployment.displayName && <h3>{deployment.displayName}</h3>}
              {deployment.description && <p>{deployment.description}</p>}
              {deployment.links.length > 0 && (
                <ul className="about-page__deployment-links">
                  {deployment.links.map((link) => (
                    <li key={`${link.kind}:${link.label}:${link.url}`} data-link-kind={link.kind}>
                      <a href={link.url} target="_blank" rel="noreferrer noopener">
                        <span className="about-page__link-kind">{link.kind}</span>
                        {link.label}<ExternalLink size={16} aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {deployment.teamMarkdown && (
                <div
                  className="about-page__markdown"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownSafe(deployment.teamMarkdown) }}
                />
              )}
            </section>
          )}
        </>
      )}
      <footer className="about-page__footer" aria-label="RelayHall official links">
        <a href={PRODUCT_URL} target="_blank" rel="noreferrer noopener">
          relayhall.com<ExternalLink size={16} aria-hidden="true" />
        </a>
        <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
          <Github size={16} aria-hidden="true" />GitHub
        </a>
      </footer>
    </div>
  );
}
