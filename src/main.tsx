import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './foundation.css';
import './searchSelect.css';
import './financeMaster.css';
import './settingsSecurity.css';
import './userAccess.css';
import './standardCoa.css';
import './journalCenter.css';
import './clientPurchase.css';
import './clientCashOut.css';
import './clientItemUsage.css';
import './menuGroups.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
