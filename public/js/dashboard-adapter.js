// Dashboard Adapter — configures the shared dashboard for שכן מגן

import { configure as configureDatabase } from '/shared/js/pages/database.js';
configureDatabase({ apiPrefix: '/api/database' });

import { render as renderShelters, onActivate as loadShelters } from './pages/shelters-tab.js';
import { render as renderMap, onActivate as loadMap, onDeactivate as unloadMap } from './pages/map-tab.js';
import { render as renderAlerts, onActivate as loadAlerts, onDeactivate as unloadAlerts } from './pages/alerts-tab.js';
import { render as renderHosts, onActivate as loadHosts } from './pages/hosts-tab.js';
import { render as renderStats, onActivate as loadStats } from './pages/stats-tab.js';
import { render as renderPikud, onActivate as loadPikud } from './pages/pikud-tab.js';

export const dashboardConfig = {
  projectId:   'magen-shachen',
  projectName: 'שכן מגן',
  logoText:    'מ',
  theme:       'cyan',

  pages: [
    { id: 'shelters', label: 'ממ"דים',       icon: '#', title: 'ניהול ממ"דים רשומים',          type: 'custom', render: renderShelters, onActivate: loadShelters },
    { id: 'map',      label: 'מפה',          icon: '@', title: 'מפה חיה — ממ"דים',             type: 'custom', render: renderMap,      onActivate: loadMap, onDeactivate: unloadMap },
    { id: 'alerts',   label: 'אזעקות',       icon: '!', title: 'תרגול + היסטוריית אזעקות',     type: 'custom', render: renderAlerts,   onActivate: loadAlerts, onDeactivate: unloadAlerts },
    { id: 'pikud',    label: 'פיקוד העורף',  icon: '~', title: 'API פיקוד העורף — אינטגרציה',  type: 'custom', render: renderPikud,    onActivate: loadPikud },
    { id: 'hosts',    label: 'מארחים',       icon: '%', title: 'ניהול מארחים',                  type: 'custom', render: renderHosts,    onActivate: loadHosts },
    { id: 'stats',    label: 'סטטיסטיקות',   icon: '*', title: 'סטטיסטיקות שימוש',             type: 'custom', render: renderStats,    onActivate: loadStats },
  ],

  features: {
    draggableTabs: false,
    envToggle: false,
    storagePrefix: 'magen-shachen_',
  },

  footerLinks: [
    { label: 'Hub', icon: '\uD83C\uDFE0', href: 'http://localhost:3000/', target: '_self' },
    { label: 'אפליקציה', icon: '\uD83D\uDDFA\uFE0F', href: '/app', target: '_blank' },
  ],
};
