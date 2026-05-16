// NEXUS Service Worker — Push Notifications

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(_) {}
  const title   = data.title  || 'NEXUS';
  const body    = data.body   || 'Task complete!';
  const tag     = data.tag    || 'nexus-notif';
  const url     = data.url    || '/';
  const options = {
    body,
    icon:    '/static/icon-192.png',
    badge:   '/static/icon-192.png',
    tag,
    data:    { url },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(location.origin) && 'focus' in c) {
          c.focus();
          return;
        }
      }
      return clients.openWindow(url);
    })
  );
});
