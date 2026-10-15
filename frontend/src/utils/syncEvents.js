import { useEffect, useRef, useState } from "react";
import { getSyncUrl } from "../config.js";

const EVENT_TYPES = [
  "treatment-updated",
  "distribution-group-updated",
  "distribution-status-changed",
  "suggestion-created",
  "notification-created",
  "quality-feedback-added",
  "treatment-history-added",
  "user-create",
  "user-updated",
  "user-deleted",
  "source-imported",
  "catalog-synced",
  "catalog-sheet-updated",
];

let eventSource = null;
let syncToken = null;
const listeners = new Map();
let reconnectTimer = null;

function getHeaders() {
  const headers = {};
  if (syncToken) headers["Authorization"] = `Bearer ${syncToken}`;
  return headers;
}

async function fetchSync(path, options = {}) {
  const baseUrl = getSyncUrl();
  if (!baseUrl) return null;
  const headers = { ...getHeaders(), ...(options.headers || {}) };
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  return response;
}

export function setSyncToken(token) {
  syncToken = token;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
    connect();
  }
}

export { fetchSync };

function connect() {
  const url = getSyncUrl();
  if (!url || eventSource) return;

  const eventUrl = `${url}/api/v1/events`;
  const init = { headers: getHeaders() };
  const source = new EventSource(eventUrl, { withCredentials: true });

  source.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  source.onerror = () => {
    source.close();
    if (eventSource === source) eventSource = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (eventSource === null) connect();
      }, 5000);
    }
  };

  EVENT_TYPES.forEach((type) => {
    source.addEventListener(type, (event) => {
      try {
        const data = JSON.parse(event.data);
        const callbacks = listeners.get(type);
        if (callbacks) {
          callbacks.forEach((cb) => cb(data));
        }
      } catch {
        // ignore parse errors
      }
    });
  });

  eventSource = source;
}

export function useSyncEvents(eventType, handler) {
  useEffect(() => {
    if (!getSyncUrl()) return;
    let callbacks = listeners.get(eventType);
    if (!callbacks) {
      callbacks = new Set();
      listeners.set(eventType, callbacks);
    }
    callbacks.add(handler);

    if (!eventSource) connect();

    return () => {
      callbacks.delete(handler);
      if (callbacks.size === 0) {
        listeners.delete(eventType);
      }
    };
  }, [eventType, handler]);
}

export function useSyncConnection(syncTokenValue) {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (syncTokenValue) {
      setSyncToken(syncTokenValue);
    }
    if (!getSyncUrl()) return;
    if (!eventSource && syncTokenValue) connect();

    const check = () => {
      setConnected(eventSource?.readyState === EventSource.CONNECTING || eventSource?.readyState === EventSource.OPEN);
    };

    if (!eventSource) return;
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [syncTokenValue]);

  return { connected, hasSyncUrl: Boolean(getSyncUrl()) };
}
