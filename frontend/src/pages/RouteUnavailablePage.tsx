import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import './RouteUnavailablePage.css';

/**
 * The catch-all for any dashboard path no route claims.
 *
 * WHY THIS EXISTS. Plugin routes are registered FROM the plugin registry, and
 * the registry is filtered per Account by the host. An account that may not see
 * a plugin therefore has no route for it, React Router matched nothing, and the
 * main area rendered empty — indistinguishable, to a person, from a broken
 * release. Two separate lanes lost real time diagnosing exactly that.
 *
 * WHAT IT MUST NOT DO. It must not tell anyone which case they are in. A path
 * that was never a plugin, a plugin that does not exist, and a plugin this
 * Account may not see all land here and all render THE SAME WORDS. The
 * component deliberately takes no parameters from the URL and never echoes the
 * path back, so it cannot confirm that a name is real. Do not "improve" it by
 * naming the resource, distinguishing the cases, or looking up the registry to
 * say more — that would turn a blank page into a resource-existence oracle.
 *
 * An empty but AUTHORIZED collection is a different thing and is legitimate:
 * pages that load and show "nothing yet" keep doing so and must not route here.
 */
export function RouteUnavailablePage({ pluginsLoading }: { pluginsLoading: boolean }) {
  // The registry arrives asynchronously, so a granted Account deep-linking to
  // its own plugin briefly matches nothing. Claiming "unavailable" during that
  // window would be a lie with the same shape as the defect being fixed.
  if (pluginsLoading) {
    return (
      <div className="route-unavailable" role="status" aria-live="polite">
        <p className="route-unavailable-body">Loading…</p>
      </div>
    );
  }

  return (
    <div className="route-unavailable">
      <Compass size={48} className="route-unavailable-icon" aria-hidden="true" />
      <h2 className="route-unavailable-title">This page isn’t available</h2>
      <p className="route-unavailable-body">
        It may not exist, or it may not be available to your account. If you expected
        something here, ask an administrator to check your access.
      </p>
      <Link className="route-unavailable-action" to="/">Return to dashboard</Link>
    </div>
  );
}
