// Deepanvil service worker: brings the forge's bell (and blueprint / merge news) to your
// phone as notifications. No offline caching: the forge is live or it isn't.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Deepanvil', body: event.data ? event.data.text() : '' };
  }
  const options = {
    body: data.body || '',
    tag: data.tag || 'deepanvil',
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: data.data || {},
  };
  // Allow / Deny right on the notification where the platform supports actions
  // (desktop, Android). On iOS a tap opens the forge with the bell card waiting.
  if (data.data && data.data.requestId) {
    options.actions = [
      { action: 'allow', title: 'Allow' },
      { action: 'deny', title: 'Deny' },
    ];
    options.requireInteraction = true;
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Deepanvil', options));
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  n.close();
  const requestId = n.data && n.data.requestId;
  if (requestId && (event.action === 'allow' || event.action === 'deny')) {
    event.waitUntil(
      fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, approved: event.action === 'allow' }),
      }),
    );
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus();
      return self.clients.openWindow('/');
    }),
  );
});
