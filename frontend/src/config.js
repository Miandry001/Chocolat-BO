// Configuration de l'API
// En développement, utilise le proxy Vite (/api/v1)
// En production, utilise l'URL complète du backend Render
export const API_BASE_URL = import.meta.env.MODE === 'production'
  ? import.meta.env.VITE_API_TARGET || 'https://chocolat-backend.onrender.com'
  : '/api/v1';

export const getApiUrl = (path) => {
  const baseUrl = API_BASE_URL.replace(/\/$/, '');
  const cleanPath = path.replace(/^\//, '');
  return `${baseUrl}/${cleanPath}`;
};

// Pour faciliter la transition, on peut aussi exporter une fonction wrapper
export const apiFetch = (path, options = {}) => {
  return fetch(getApiUrl(path), options);
};

// URL du serveur de synchronisation partagée (multi-utilisateurs)
// En Electron, la config est exposée via le preload (processus principal).
// Dans un navigateur, le backend diffuse lui-même les événements sur /api/v1/events
// (même origine) ; VITE_SYNC_URL permet encore de viser un autre serveur.
export const getSyncUrl = () => {
  if (typeof window === 'undefined') return '';
  if (window.electron?.syncConfig) return window.electron.syncConfig.enabled ? window.electron.syncConfig.url : '';
  return import.meta.env.VITE_SYNC_URL || window.location.origin;
};

export const isSyncEnabled = () => Boolean(getSyncUrl());

// Fenêtre « onglets du catalogue » : fenêtre Electron dédiée, ou onglet du navigateur en mode web.
let catalogTab = null;
export const openCatalogWindow = () => {
  if (window.electron?.openCatalogWindow) return window.electron.openCatalogWindow();
  if (catalogTab && !catalogTab.closed) catalogTab.focus();
  else catalogTab = window.open('/catalogue', 'chocolat-catalogue');
  return Promise.resolve(Boolean(catalogTab));
};

export const closeCatalogWindow = () => {
  if (window.electron?.closeCatalogWindow) return window.electron.closeCatalogWindow();
  if (catalogTab && !catalogTab.closed) catalogTab.close();
  catalogTab = null;
  return Promise.resolve(true);
};

export const getSyncApiUrl = (path) => {
  const baseUrl = getSyncUrl().replace(/\/$/, '');
  const cleanPath = path.replace(/^\//, '');
  return baseUrl ? `${baseUrl}/${cleanPath}` : '';
};
