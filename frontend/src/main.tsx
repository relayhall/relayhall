import ReactDOM from 'react-dom/client';
import App from './App';
import { completeStepUpLanding } from './utils/stepUpLanding';
import './index.css';

// Card a3e76724: a load that is the step-up window landing back from the
// Identity provider reports to the dialog that opened it and renders nothing
// else — the app is not booted inside that window.
if (!completeStepUpLanding(window)) {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    // Temporarily disabled StrictMode - it double-mounts components and breaks WebGL
    // <React.StrictMode>
      <App />
    // </React.StrictMode>
  );
}
