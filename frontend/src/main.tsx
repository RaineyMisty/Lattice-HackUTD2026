import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

if (window.location.pathname.replace(/\/$/, '') === '/map-demo') {
  window.history.replaceState(null, '', `/${window.location.search}${window.location.hash}`);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
