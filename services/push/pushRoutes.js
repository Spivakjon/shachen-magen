// services/push/pushRoutes.js — Push subscription management
import { config } from '../../core/config.js';
import { addSubscription, removeSubscription } from './pushService.js';
import { hostAuth } from '../auth/authRoutes.js';

export function registerPushRoutes(app) {

  // ─── Get VAPID public key ───
  app.get('/api/push/vapid-key', async () => {
    return { ok: true, publicKey: config.push.publicKey };
  });

  // ─── Subscribe to push (host must be authenticated) ───
  app.post('/api/push/subscribe', { preHandler: hostAuth }, async (request) => {
    const { subscription } = request.body || {};
    if (!subscription?.endpoint) {
      return { ok: false, error: 'subscription required' };
    }
    addSubscription(request.hostId, subscription);
    return { ok: true };
  });

  // ─── Unsubscribe from push ───
  app.delete('/api/push/unsubscribe', async (request) => {
    const { endpoint } = request.body || {};
    if (endpoint) removeSubscription(endpoint);
    return { ok: true };
  });
}
