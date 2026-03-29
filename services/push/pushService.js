// services/push/pushService.js — Web Push notification service
import webPush from 'web-push';
import db from '../db.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';

let initialized = false;

function ensureInit() {
  if (initialized) return;
  if (!config.push.publicKey || !config.push.privateKey) {
    logger.warn('VAPID keys not configured — push disabled');
    return;
  }
  webPush.setVapidDetails(config.push.email, config.push.publicKey, config.push.privateKey);
  initialized = true;
}

export function addSubscription(hostId, subscription) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Invalid subscription');
  }

  db.prepare(`
    INSERT INTO push_subscriptions (host_id, endpoint, keys_p256dh, keys_auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      host_id = excluded.host_id,
      keys_p256dh = excluded.keys_p256dh,
      keys_auth = excluded.keys_auth
  `).run(hostId, endpoint, keys.p256dh, keys.auth);

  logger.info({ hostId }, 'Push subscription saved');
}

export function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export async function sendPushToHosts(hostIds, payload) {
  ensureInit();
  if (!initialized) return;

  const placeholders = hostIds.map(() => '?').join(',');
  const subs = db.prepare(`
    SELECT * FROM push_subscriptions WHERE host_id IN (${placeholders})
  `).all(...hostIds);

  if (subs.length === 0) {
    logger.debug({ hostIds }, 'No push subscriptions for these hosts');
    return;
  }

  const payloadStr = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;

  for (const sub of subs) {
    try {
      await webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
        },
        payloadStr
      );
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        removeSubscription(sub.endpoint);
        logger.debug({ endpoint: sub.endpoint }, 'Removed expired push subscription');
      } else {
        logger.warn({ err: err.message, endpoint: sub.endpoint }, 'Push send failed');
      }
      failed++;
    }
  }

  logger.info({ sent, failed, total: subs.length }, 'Push notifications sent');
}

export async function sendPushToAll(payload) {
  ensureInit();
  if (!initialized) return;

  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (subs.length === 0) return;

  const payloadStr = JSON.stringify(payload);
  for (const sub of subs) {
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth } },
        payloadStr
      );
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        removeSubscription(sub.endpoint);
      }
    }
  }
}
