export class Notification {
  #config = {};

  constructor(config) {
    this.#config.notificationTimeout = config?.notificationTimeout || 3000;
  }

  showNotification(message, type = 'info') {
    this.notification = document.getElementById('notification');
    if (!this.notification) return;
    this.notification.textContent = message;
    this.notification.className = `notification ${type}`;
    this.notification.classList.remove('hidden');
    const timeout = this.#config.notificationTimeout;

    setTimeout(() => {
      this.notification.classList.add('hidden');
    }, timeout);
  }
}
