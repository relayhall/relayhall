import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { RequestStatus } from '../RequestStatus';
import { ChevronRight, ClipboardList } from 'lucide-react';
import { authenticatedFetch } from '../../utils/auth';
import './ReportsCard.css';
import { isIntentionalAbort } from '../../utils/fetchAbort';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface Report {
  id: string;
  title: string;
  summary: string | null;
  tags: string[];
  pinned: boolean;
  created_at: string;
}

const timeAgo = (dateStr: string): string => {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return 'Just now';
};

export const ReportsCard: React.FC = () => {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    fetchReports();
  }, []);

  const fetchReports = async () => {
    if (pending.current) return;
    pending.current = true; setLoading(true); setError(null);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/reports?limit=3&offset=0`);
      if (!response.ok) throw new Error('Reports could not be loaded.');
      const data = await response.json();
      if (data.reports) {
        setReports(data.reports);
      }
    } catch (err) {
      if (!isIntentionalAbort(err)) {
        console.error('Failed to fetch reports:', err);
        setError('Reports could not be loaded.');
      }
    } finally {
      pending.current = false; setLoading(false);
    }
  };

  return (
    <div className="reports-card" aria-busy={loading}>
      <div className="reports-card-header">
        <h2><ClipboardList size={16} aria-hidden="true" /> Reports</h2>
        <Link className="reports-card-view-all" to="/reports">
          <span>View all Reports</span><ChevronRight size={16} className="reports-card-arrow" />
        </Link>
      </div>
      <RequestStatus loading={loading} label="Loading reports…" error={error} onRetry={() => void fetchReports()} />
      {loading && reports.length === 0 && <div className="reports-card-placeholders" aria-hidden="true"><div /><div /><div /></div>}
      {!loading && !error && reports.length === 0 && <div className="reports-card-empty">No reports yet</div>}
      {reports.length > 0 && <div className="reports-card-list">
        {reports.map(report => <Link key={report.id} className="reports-card-row" to={`/reports/${report.id}`}>
          <div className="reports-card-row-content">
            <span className="reports-card-row-title">{report.title}</span>
            <div className="reports-card-row-meta">
              <span className="reports-card-row-date">{timeAgo(report.created_at)}</span>
              {report.tags.slice(0, 3).map(tag => <span key={tag} className="reports-card-tag">{tag}</span>)}
            </div>
          </div>
        </Link>)}
      </div>}
    </div>
  );
};
