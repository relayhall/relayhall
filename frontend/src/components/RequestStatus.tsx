import { LoaderCircle } from 'lucide-react';
import { Button } from './Button';
import './RequestStatus.css';

/** Request feedback leaves layout and already loaded content with its owner. */
export function RequestStatus({ loading, label, error, onRetry }: {
  loading: boolean; label: string; error?: string | null; onRetry?: () => void;
}) {
  if (error) return <div className="request-status request-status--error" role="alert">
    <span>{error}</span>
    {onRetry && <Button variant="secondary" size="compact" disabled={loading} onClick={onRetry}>Retry</Button>}
  </div>;
  if (!loading) return null;
  return <div className="request-status" role="status">
    <LoaderCircle size={16} className="request-status-spinner" aria-hidden="true" />
    <span>{label}</span>
  </div>;
}
