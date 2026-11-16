let requested = false;

const requestCallNotifications = () => {
  const Notify = globalThis.Notification;
  if (requested || typeof Notify?.requestPermission !== 'function') return;
  if (Notify.permission !== 'default') return;
  const activation = globalThis.navigator?.userActivation;
  if (activation && !activation.isActive) return;
  requested = true;
  try {
    const pending = Notify.requestPermission();
    pending?.catch(() => undefined);
  } catch {
    return;
  }
};

const notificationClient = (worker) => {
  const Channel = globalThis.MessageChannel;
  if (!worker || typeof Channel !== 'function') return Promise.resolve('');
  return new Promise((resolve) => {
    const channel = new Channel();
    let timer = 0;
    const finish = (id) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(typeof id === 'string' ? id : '');
    };
    timer = setTimeout(() => finish(''), 1000);
    channel.port1.onmessage = (event) => finish(event.data);
    try {
      worker.postMessage({ type: 'xxii:client' }, [channel.port2]);
    } catch {
      finish('');
    }
  });
};

const showRingNotification = async (scope, event) => {
  const { title, tag } = event.data;
  if (typeof title !== 'string' || title === '') return;
  if (typeof tag !== 'string' || tag === '') return;
  const clientId = event.source?.id ?? '';
  const data = { clientId };
  const registration = scope.registration;
  if (typeof registration.showNotification !== 'function') return;
  try {
    await registration.showNotification(title, { tag, data, renotify: true });
  } catch {
    await registration.showNotification(title, { tag, data });
  }
};

const onNotificationMessage = (scope, event) => {
  const type = event.data?.type;
  if (type === 'xxii:client') {
    event.ports?.[0]?.postMessage(event.source?.id ?? '');
  } else if (type === 'xxii:ring') {
    event.waitUntil(showRingNotification(scope, event));
  }
};

const focusNotificationClient = async (scope, notification) => {
  const windows = await scope.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const app = new URL(scope.registration.scope);
  const matches = windows.filter((client) => {
    try {
      const url = new URL(client.url);
      return url.origin === app.origin && url.pathname.startsWith(app.pathname);
    } catch {
      return false;
    }
  });
  const clientId = notification.data?.clientId;
  const source = matches.find((client) => client.id === clientId);
  const client = source ?? matches[0];
  if (client) await client.focus();
  else await scope.clients.openWindow('/');
};

const onNotificationClick = (scope, event) => {
  event.notification.close();
  event.waitUntil(focusNotificationClient(scope, event.notification));
};

export {
  requestCallNotifications,
  notificationClient,
  onNotificationMessage,
  onNotificationClick,
};
