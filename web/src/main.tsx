import React from 'react';
import ReactDOM from 'react-dom/client';
import { SecureShell } from './SecureShell';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SecureShell />
  </React.StrictMode>
);
