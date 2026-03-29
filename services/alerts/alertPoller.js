// services/alerts/alertPoller.js — Pikud HaOref API polling
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { handleNewAlert } from './alertHandler.js';

// Pikud HaOref real-time alerts API
// Primary endpoint (current), fallback to legacy
const PIKUD_HAOREF_URLS = [
  'https://www.oref.org.il/WarningMessages/alert/alerts.json',
];

let pollTimer = null;
let lastAlertId = null;
let consecutiveFailures = 0;

export function startAlertPoller() {
  if (pollTimer) return;

  logger.info({
    cities: config.alerts.monitoredCities,
    interval: config.alerts.pollInterval,
  }, 'Alert poller started — connected to Pikud HaOref API');

  pollTimer = setInterval(pollAlerts, config.alerts.pollInterval);
  pollAlerts();
}

export function stopAlertPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    logger.info('Alert poller stopped');
  }
}

async function pollAlerts() {
  for (const url of PIKUD_HAOREF_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        headers: {
          'Referer': 'https://www.oref.org.il/',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json',
          'Accept-Language': 'he',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) continue;

      const text = await response.text();
      consecutiveFailures = 0; // reset on successful fetch

      if (!text || text.trim() === '' || text.trim() === '[]') return; // No active alerts — normal

      let alerts;
      try {
        alerts = JSON.parse(text);
      } catch {
        return; // BOM or invalid JSON = no alerts
      }

      if (!Array.isArray(alerts) || alerts.length === 0) return;

      // Filter for monitored cities
      const relevantAlerts = alerts.filter(a => {
        const alertCity = a.data || a.title || '';
        return config.alerts.monitoredCities.some(city =>
          alertCity.includes(city) || city.includes(alertCity)
        );
      });

      if (relevantAlerts.length === 0) return;

      // Deduplicate by alert ID
      const alertId = relevantAlerts.map(a => a.id || a.notificationId || a.rid).join(',');
      if (alertId === lastAlertId) return;
      lastAlertId = alertId;

      logger.warn({ count: relevantAlerts.length, cities: relevantAlerts.map(a => a.data || a.title) }, 'ALERT DETECTED from Pikud HaOref!');

      await handleNewAlert(relevantAlerts);
      return; // Success — don't try fallback
    } catch (err) {
      if (err.name === 'AbortError') continue; // Timeout, try next URL
      continue;
    }
  }

  // All URLs failed
  consecutiveFailures++;
  if (consecutiveFailures % 20 === 1) {
    logger.debug({ failures: consecutiveFailures }, 'Alert poll — all endpoints unreachable');
  }
}
