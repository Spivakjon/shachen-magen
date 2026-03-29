// Push notification manager for hosts
const STORAGE_KEY = 'magen_push_subscribed';

export async function initPushManager() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('Push not supported');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('/service-worker.js');
    console.log('SW registered');

    // Check existing subscription
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      localStorage.setItem(STORAGE_KEY, '1');
      return;
    }
  } catch (err) {
    console.error('SW registration failed:', err);
  }
}

export async function subscribeToPush(token) {
  try {
    const registration = await navigator.serviceWorker.ready;

    // Get VAPID key
    const res = await fetch('/api/push/vapid-key');
    const { publicKey } = await res.json();
    if (!publicKey) {
      console.warn('No VAPID key configured');
      return false;
    }

    // Convert VAPID key
    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    // Subscribe
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });

    // Send to server
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });

    localStorage.setItem(STORAGE_KEY, '1');
    console.log('Push subscribed successfully');
    return true;
  } catch (err) {
    console.error('Push subscription failed:', err);
    return false;
  }
}

export async function unsubscribeFromPush() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await fetch('/api/push/unsubscribe', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('Push unsubscribe failed:', err);
  }
}

export function isPushSubscribed() {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
