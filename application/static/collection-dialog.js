const element = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

const button = (label, run) => {
  const node = element('button', 'link-btn', label);
  node.type = 'button';
  node.onclick = run;
  return node;
};

const openCollection = (title, build) => {
  const dialog = element('dialog', 'collection-dialog');
  const header = element('header');
  const close = button('×', () => dialog.close());
  close.setAttribute('aria-label', 'Close');
  header.append(element('h2', '', title), close);
  const body = element('div', 'collection-body');
  dialog.setAttribute('aria-label', title);
  dialog.append(header, body);
  const dismiss = () => dialog.close();
  dialog.addEventListener('keydown', (event) => event.stopPropagation());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dismiss();
  });
  dialog.addEventListener('close', () => {
    window.removeEventListener('popstate', dismiss);
    dialog.remove();
  });
  window.addEventListener('popstate', dismiss);
  build(body, dismiss);
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
};

const filteredCollection = (body, groups, empty) => {
  const bar = element('div', 'collection-toolbar');
  const search = element('input');
  search.type = 'search';
  search.placeholder = 'Filter';
  search.setAttribute('aria-label', 'Filter');
  const select = element('select');
  select.setAttribute('aria-label', 'Category');
  for (const name of Object.keys(groups)) {
    select.append(element('option', '', name));
  }
  select.hidden = select.options.length < 2;
  const list = element('ul', 'collection-list');
  const status = element('p', 'muted', empty);
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const rows = groups[select.value]();
    const matches = rows.filter(({ text }) =>
      text.toLowerCase().includes(query),
    );
    list.replaceChildren(...matches.map(({ row }) => row));
    status.hidden = matches.length > 0;
  };
  bar.append(select, search);
  body.append(bar, list, status);
  select.onchange = search.oninput = render;
  render();
  return render;
};

export { element, button, openCollection, filteredCollection };
