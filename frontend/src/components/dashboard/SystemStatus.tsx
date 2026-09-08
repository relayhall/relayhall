import React, { useState, useEffect } from 'react';
import { Database, Radio, Server, Wifi, WifiOff, Wrench } from 'lucide-react';
import { useWebSocket } from '../../hooks/useWebSocket';
import './SystemStatus.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface HealthData {
  api: boolean;
  database: boolean;
  websocket: boolean;
  uptime?: string;
  dbResponseMs?: number;
}

export const SystemStatus: React.FC = () => {
  const [health, setHealth] = useState<HealthData>({
    api: false,
    database: false,
    websocket: false,
  });
  const [loading, setLoading] = useState(true);
  const { connected } = useWebSocket();

  useEffect(() => {
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setHealth(prev => ({ ...prev, websocket: connected }));
  }, [connected]);

  const fetchHealth = async () => {
    try {
      const start = Date.now();
      const response = await fetch(`${API_BASE_URL}/health`);
      const elapsed = Date.now() - start;

      if (response.ok) {
        const data = await response.json();
        setHealth(prev => ({
          ...prev,
          api: true,
          database: data.database === 'connected' || data.database?.status === 'ok' || data.status === 'ok' || data.status === 'healthy',
          dbResponseMs: data.database?.responseMs || elapsed,
          uptime: data.uptime,
        }));
      } else {
        setHealth(prev => ({ ...prev, api: true, database: false }));
      }
    } catch {
      setHealth(prev => ({ ...prev, api: false }));
    } finally {
      setLoading(false);
    }
  };

  const formatUptime = (seconds?: string | number): string => {
    if (!seconds) return '';
    const s = typeof seconds === 'string' ? parseInt(seconds, 10) : seconds;
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    if (days > 0) return `${days}d ${hours}h`;
    const mins = Math.floor((s % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  const StatusDot: React.FC<{ ok: boolean; label: string; icon: React.ReactNode }> = ({ ok, label, icon }) => (
    <div className="system-status-item">
      <div className="system-status-icon">{icon}</div>
      <div className="system-status-dot-wrapper">
        <span className={`system-status-dot ${ok ? 'dot-green' : 'dot-red'}`} />
      </div>
      <span className="system-status-label">{label}</span>
    </div>
  );

  if (loading) return null;

  return (
    <div className={`system-status ${(!health.api || !health.database) ? 'system-status-unhealthy' : ''}`}>
      <div className="system-status-header">
        <h2><Wrench size={16} aria-hidden="true" /> System Status</h2>
      </div>

      <div className="system-status-grid">
        <StatusDot ok={health.api} label="API Connected" icon={<Server size={16} />} />
        <StatusDot ok={health.database} label="Database" icon={<Database size={16} />} />
        <StatusDot
          ok={health.websocket}
          label="WebSocket"
          icon={health.websocket ? <Wifi size={16} /> : <WifiOff size={16} />}
        />
        <StatusDot ok={health.api} label="Backend" icon={<Radio size={16} />} />
      </div>

      {(health.uptime || health.dbResponseMs) && (
        <div className="system-status-footer">
          {health.uptime && (
            <span>Uptime: {formatUptime(health.uptime)}</span>
          )}
          {health.dbResponseMs && (
            <span>DB: {health.dbResponseMs}ms</span>
          )}
        </div>
      )}
    </div>
  );
};
