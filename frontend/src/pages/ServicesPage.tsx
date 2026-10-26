import { Server } from 'lucide-react';
import { KnowledgeSourceRegistrationPanel } from '../components/services/KnowledgeSourceRegistrationPanel';
import './AdministrationPages.css';

/**
 * SETTINGS > SERVICES (card 08792425, member N6; the default-store design's
 * choice C7). Where an administrator registers a knowledge source from the
 * bundle its installer printed, hands the return bundle back, and sees what
 * the operator still has to do on the core host. The board decides who may
 * act: the panel renders what `GET /knowledge-source-registrations` answers
 * this session, and every act is checked again on the server.
 */
export function ServicesPage() {
  return <div className="admin-page">
    <header className="admin-page-header">
      <Server size={24} aria-hidden="true" />
      <h1>Services</h1>
    </header>
    <p className="admin-page-intro">
      Services the board talks to. A knowledge source registers here in two steps: you upload its installer&apos;s bundle
      and confirm its certificate fingerprint, and the operator places its channel credential on the core host.
    </p>
    <div className="admin-page-panel">
      <KnowledgeSourceRegistrationPanel />
    </div>
  </div>;
}
