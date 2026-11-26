const IN_CALL_TITLE = 'Use the record control in your call';
const VIEW = 'recordings';

class RecordingsScreen {
  constructor(root, hooks) {
    this.root = root;
    this.app = root.closest('.app');
    this.capture = root.querySelector('#recordings-capture');
    const canRecord = typeof MediaRecorder === 'function';
    this.capture.classList.toggle('hidden', !canRecord);
    this.capture.onclick = () => hooks.capture();
    root.querySelector('#recordings-close').onclick = () => hooks.close();
  }

  get isOpen() {
    return this.app.dataset.view === VIEW;
  }

  open() {
    this.app.dataset.view = VIEW;
  }

  hide() {
    if (this.isOpen) delete this.app.dataset.view;
  }

  paint(isBusy) {
    this.capture.disabled = isBusy;
    this.capture.title = isBusy ? IN_CALL_TITLE : '';
  }
}

export { RecordingsScreen };
