import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Github } from 'lucide-react';
import { Wordmark } from '../components/Wordmark';
import { loadAppearanceInfo, type AppearanceInfo, type AppearanceLink } from '../services/appearance';
import { DOCS_URL, IS_PUBLIC_BUILD, LICENSE_URL, PROBLEM_URL, PRODUCT_URL, SOURCE_LABEL, SOURCE_URL } from '../utils/build';
import { loadApiInfo, loadReleaseManifest, RELAYHALL_VERSION, type ApiInfo, type ReleaseManifest } from '../utils/releaseInfo';
import { renderMarkdownSafe } from '../utils/renderMarkdown';
import './AboutPage.css';

interface AboutFacts {
  manifest: ReleaseManifest | null;
  api: ApiInfo | null;
  appearance: AppearanceInfo | null;
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
  return IS_PUBLIC_BUILD ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}<ExternalLink size={16} aria-hidden="true" />
    </a>
  ) : <span>{children}</span>;
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

  const deployment = useMemo(() => {
    if (!facts.appearance) return null;
    const displayName = nonBlank(facts.appearance.displayName);
    const description = nonBlank(facts.appearance.description);
    const teamMarkdown = nonBlank(facts.appearance.teamMarkdown);
    const links = facts.appearance.links.map(safeHttpLink).filter((link): link is AppearanceLink => link !== null);
    if (!displayName && !description && !teamMarkdown && links.length === 0) return null;
    return { displayName, description, teamMarkdown, links };
  }, [facts.appearance]);

  return (
    <div className="about-page">
      <header className="about-page__header">
        <h1>About</h1>
        <p>Product identity and deployment information for this RelayHall instance.</p>
      </header>

      {failures.length > 0 && (
        <div className="about-page__error" role="alert">
          <span>{failures.join(', ')} {failures.length === 1 ? 'is' : 'are'} unavailable.</span>
          <button type="button" onClick={() => setAttempt(current => current + 1)}>Retry</button>
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
              <div><dt>Version</dt><dd>{RELAYHALL_VERSION}</dd></div>
              <div><dt>API version</dt><dd>{facts.api?.version ?? 'Unavailable'}</dd></div>
              <div><dt>Build SHA</dt><dd>{facts.manifest ? <code>{facts.manifest.sha}</code> : 'Unavailable'}</dd></div>
              <div><dt>Dirty</dt><dd>{facts.manifest ? <code>{facts.manifest.dirty}</code> : 'Unavailable'}</dd></div>
              <div><dt>Build context</dt><dd>{facts.manifest?.buildContext ?? 'Unavailable'}</dd></div>
              <div><dt>Built at</dt><dd>{facts.manifest ? <time dateTime={facts.manifest.builtAt}>{facts.manifest.builtAt}</time> : 'Unavailable'}</dd></div>
            </dl>
            <nav className="about-page__links" aria-label="RelayHall product links">
              <ProductLink href={LICENSE_URL}>MIT licence</ProductLink>
              <ProductLink href={SOURCE_URL}>{SOURCE_LABEL}</ProductLink>
              <ProductLink href={DOCS_URL}>Documentation</ProductLink>
              <ProductLink href={SOURCE_URL+'/blob/main/docs/blueprints/README.md'}>Blueprint authoring and use guide</ProductLink>
              <ProductLink href={PROBLEM_URL}>Report a problem</ProductLink>
            </nav>
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
        {IS_PUBLIC_BUILD ? (
          <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
            <Github size={16} aria-hidden="true" />GitHub
          </a>
        ) : (
          <span><Github size={16} aria-hidden="true" />GitHub: linked once published</span>
        )}
      </footer>
    </div>
  );
}
