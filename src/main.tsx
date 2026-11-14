import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { captureReferralFromUrl } from './lib/referral';

// Remember ?ref=CODE (and clean the address bar) before anything else runs.
captureReferralFromUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
