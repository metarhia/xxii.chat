import { cloneTemplate } from './view.js';

const TEMPLATE = 'confirm-template';
const CONFIRMED = 'confirm';

const canShowModal = () =>
  typeof globalThis.HTMLDialogElement?.prototype.showModal === 'function';

const createLine = (text) => {
  const line = document.createElement('p');
  line.textContent = text;
  return line;
};

const build = ({ title, lines, action }) => {
  const template = document.getElementById(TEMPLATE);
  const dialog = cloneTemplate(template, 'dialog');
  dialog.setAttribute('aria-label', title);
  dialog.querySelector('.confirm-title').textContent = title;
  dialog.querySelector('.confirm-body').append(...lines.map(createLine));
  dialog.querySelector('.confirm-action').textContent = action;
  return dialog;
};

const askModal = (options) =>
  new Promise((resolve) => {
    const dialog = build(options);
    const dismiss = () => dialog.close();
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    dialog.addEventListener('close', () => {
      window.removeEventListener('popstate', dismiss);
      dialog.remove();
      resolve(dialog.returnValue === CONFIRMED);
    });
    window.addEventListener('popstate', dismiss);
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('.confirm-cancel').focus();
  });

const askConfirm = async (options) => {
  if (canShowModal()) return askModal(options);
  return window.confirm(`${options.title}\n${options.lines.join('\n')}`);
};

export { askConfirm };
