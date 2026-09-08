import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  // Temporarily disabled StrictMode - it double-mounts components and breaks WebGL
  // <React.StrictMode>
    <App />
  // </React.StrictMode>
);
