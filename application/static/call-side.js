const TABS = ['chat', 'people', 'record', 'studio'];

const LABELS = {
  chat: 'Chat',
  people: 'People',
  record: 'Record',
  studio: 'Studio',
};

const createElement = (tag, className) => {
  const element = document.createElement(tag);
  element.className = className;
  return element;
};

const createTab = (name) => {
  const tab = createElement('button', `call-tab call-tab-${name}`);
  tab.type = 'button';
  tab.dataset.tab = name;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  const label = createElement('span', 'call-tab-label');
  label.textContent = LABELS[name];
  const badge = createElement('span', 'call-tab-badge hidden');
  tab.append(label, badge);
  return tab;
};

const createClose = () => {
  const close = createElement('button', 'call-tabs-close');
  close.type = 'button';
  close.dataset.action = 'close-sheet';
  close.title = 'Close panel';
  close.setAttribute('aria-label', 'Close panel');
  close.textContent = '×';
  return close;
};

const createTabs = (hasStudio) => {
  const tabs = createElement('div', 'call-tabs');
  const list = createElement('div', 'call-tablist');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', 'Call panels');
  const names = hasStudio ? TABS : TABS.filter((name) => name !== 'studio');
  list.append(...names.map(createTab));
  tabs.append(list, createClose());
  return tabs;
};

const createSideBar = (...controls) => {
  const bar = createElement('footer', 'side-bar');
  bar.append(...controls);
  return bar;
};

const createSideBody = (...children) => {
  const body = createElement('div', 'side-body');
  body.append(...children);
  return body;
};

const createSide = (hasStudio, ...panes) => {
  const side = createElement('div', 'call-side');
  side.append(createTabs(hasStudio), ...panes);
  return side;
};

const tabsOf = (side) => Array.from(side.querySelectorAll('.call-tab'));

const stepTab = (side, tab, step) => {
  const tabs = tabsOf(side);
  const index = tabs.indexOf(tab);
  if (index === -1) return null;
  return tabs[(index + step + tabs.length) % tabs.length];
};

const TAB_STEPS = { ArrowRight: 1, ArrowLeft: -1 };

const nextTab = (side, event) => {
  const tab = event.target.closest('.call-tab');
  const step = TAB_STEPS[event.key];
  if (!tab || !step) return null;
  return stepTab(side, tab, step);
};

const paintBadge = (tab, text, isAlert = false) => {
  const badge = tab.querySelector('.call-tab-badge');
  badge.textContent = text;
  badge.classList.toggle('hidden', text === '');
  badge.classList.toggle('alert', isAlert);
};

const nameOf = (name, state) => {
  const parts = [LABELS[name]];
  if (state.badge !== '') parts.push(state.note || state.badge);
  return parts.join(', ');
};

const paintTab = (tab, shown, state) => {
  const name = tab.dataset.tab;
  const isShown = name === shown;
  tab.setAttribute('aria-selected', `${isShown}`);
  tab.tabIndex = isShown || (shown === '' && name === 'chat') ? 0 : -1;
  tab.classList.toggle('open', isShown);
  paintBadge(tab, state.badge, state.alert);
  tab.setAttribute('aria-label', nameOf(name, state));
};

const paintTabs = (side, shown, states) => {
  for (const tab of tabsOf(side)) {
    paintTab(tab, shown, states[tab.dataset.tab]);
  }
};

export { TABS, createSide, createSideBar, createSideBody, paintTabs };
export { nextTab };
