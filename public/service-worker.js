// Service Worker — מגן שכן Push Notifications

const CACHE_NAME = 'shachen-magen-v1';

// Install — cache shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Push — show notification
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'שכן מגן', body: event.data.text() };
  }

  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    dir: 'rtl',
    lang: 'he',
    tag: data.tag || 'shachen-magen',
    renotify: true,
    requireInteraction: true, // Keep notification visible (important for alerts!)
    data: {
      url: data.url || '/host',
    },
    vibrate: [300, 100, 300, 100, 300], // Strong vibration for alerts
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'שכן מגן', options)
  );
});

// Notification click — open/focus app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/host';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus();
        }
      }
      // Open new window
      return self.clients.openWindow(url);
    })
  );
});
