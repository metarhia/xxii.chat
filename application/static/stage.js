import { MediaCapture } from './media.js';

const LOBBY = 'waiting for an admin to let you in';

const ACTIONS = {
  mic: (stage) => stage.toggle('mic'),
  camera: (stage) => stage.toggle('camera'),
  join: (stage) => stage.join(),
  cancel: (stage) => stage.cancel(),
  leave: (stage) => stage.leave(),
  back: (stage) => stage.collapse(),
};

const hueOf = (id) => {
  let hash = 0;
  for (const char of id) hash = (hash * 33 + char.charCodeAt(0)) % 360;
  return hash;
};

const peerOf = (endpoint) => {
  const index = endpoint.indexOf(':');
  if (index <= 0) return endpoint;
  return endpoint.slice(0, index);
};

const colorOf = (endpoint) => {
  const peer = endpoint ? peerOf(endpoint) : 'guest';
  return `hsl(${hueOf(peer)} 42% 32%)`;
};

const initialsOf = (name) => {
  const text = typeof name === 'string' ? name.trim() : '';
  if (text === '') return '?';
  const parts = text.split(/\s+/);
  const first = parts[0];
  const second = parts[1];
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0]}${second[0]}`.toUpperCase();
};

const createButton = (action, label) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link-btn';
  button.dataset.action = action;
  button.textContent = label;
  return button;
};

const createField = (id, label) => {
  const wrap = document.createElement('label');
  wrap.className = 'call-field';
  const caption = document.createElement('span');
  caption.textContent = label;
  const select = document.createElement('select');
  select.id = id;
  wrap.append(caption, select);
  return wrap;
};

const createVideo = (muted) => {
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = muted;
  video.playsInline = true;
  return video;
};

const createAvatar = () => {
  const wrap = document.createElement('div');
  wrap.className = 'avatar-wrap';
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  wrap.append(avatar);
  return wrap;
};

const streamOf = (track) => {
  const Stream = globalThis.MediaStream;
  if (!Stream || !track) return null;
  return new Stream([track]);
};

const showTrack = (video, track, mirrored) => {
  video.classList.toggle('mirrored', mirrored);
  const current = video.srcObject?.getVideoTracks?.()[0] ?? null;
  if (current === track) return;
  video.srcObject = streamOf(track);
  if (track) video.play().catch(() => undefined);
};

const paintPerson = (root, track, name, color) => {
  const video = root.querySelector('video');
  const wrap = root.querySelector('.avatar-wrap');
  const avatar = wrap?.querySelector('.avatar');
  const live = Boolean(track);
  if (video) {
    video.classList.toggle('hidden', !live);
    showTrack(video, track, root.classList.contains('local'));
  }
  wrap?.classList.toggle('hidden', live);
  if (!avatar || live) return;
  avatar.style.background = color;
  avatar.textContent = initialsOf(name);
};

const hasOption = (select, value) => {
  for (const option of select.options) {
    if (option.value === value) return true;
  }
  return false;
};

const fillSelect = (select, devices, selected, noun) => {
  if (!select) return;
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'default';
  select.append(blank);
  let index = 0;
  for (const device of devices) {
    if (device.deviceId === '') continue;
    const option = document.createElement('option');
    option.value = device.deviceId;
    const label = device.label || `${noun} ${index + 1}`;
    option.textContent = label;
    select.append(option);
    index += 1;
  }
  const known = selected === '' || hasOption(select, selected);
  select.value = known ? selected : '';
};

const createPrejoin = (title, hasNick) => {
  const section = document.createElement('section');
  section.id = 'prejoin';
  const preview = document.createElement('div');
  preview.className = 'preview';
  const level = document.createElement('div');
  level.className = 'level';
  const bar = document.createElement('div');
  bar.className = 'level-bar';
  level.append(bar);
  const actions = document.createElement('div');
  actions.className = 'prejoin-actions';
  const micButton = createButton('mic', 'mic on');
  const cameraButton = createButton('camera', 'camera on');
  actions.append(micButton, cameraButton);
  preview.append(createVideo(true), createAvatar(), level, actions);
  const side = document.createElement('div');
  side.className = 'prejoin-side';
  const heading = document.createElement('p');
  heading.className = 'chat-title';
  heading.textContent = title;
  const note = document.createElement('p');
  note.className = 'call-note hidden';
  const nick = document.createElement('label');
  nick.className = 'call-field nick-field';
  nick.classList.toggle('hidden', hasNick);
  const nickCaption = document.createElement('span');
  nickCaption.textContent = 'nick';
  const input = document.createElement('input');
  input.id = 'prejoin-nick';
  input.type = 'text';
  input.maxLength = 32;
  input.placeholder = 'your name';
  nick.append(nickCaption, input);
  const camera = createField('prejoin-camera', 'camera');
  const mic = createField('prejoin-mic', 'mic');
  const speaker = createField('prejoin-speaker', 'speaker');
  speaker.classList.add('speaker-field');
  const row = document.createElement('div');
  row.className = 'prejoin-actions';
  row.append(createButton('join', 'join'), createButton('cancel', 'cancel'));
  side.append(heading, note, nick, camera, mic, speaker, row);
  section.append(preview, side);
  return section;
};

const createLobby = () => {
  const section = document.createElement('section');
  section.id = 'lobby';
  section.className = 'lobby';
  const text = document.createElement('p');
  text.textContent = LOBBY;
  section.append(text, createButton('cancel', 'cancel'));
  return section;
};

const createCall = (title) => {
  const section = document.createElement('section');
  section.id = 'call-view';
  const bar = document.createElement('header');
  bar.className = 'call-topbar';
  const back = createButton('back', '‹');
  back.setAttribute('aria-label', 'back');
  const heading = document.createElement('span');
  heading.className = 'chat-title';
  heading.textContent = title;
  bar.append(back, heading);
  const grid = document.createElement('div');
  grid.className = 'call-grid';
  const controls = document.createElement('footer');
  controls.className = 'call-controls';
  controls.append(
    createButton('mic', 'mic on'),
    createButton('camera', 'camera on'),
    createButton('leave', 'leave'),
  );
  section.append(bar, grid, controls);
  return section;
};

const createMini = () => {
  const tile = document.createElement('div');
  tile.id = 'mini-call';
  const controls = document.createElement('div');
  controls.className = 'mini-controls';
  controls.append(
    createButton('mic', 'mic on'),
    createButton('camera', 'camera on'),
    createButton('leave', 'leave'),
  );
  tile.append(createVideo(true), createAvatar(), controls);
  return tile;
};

const createTile = (endpoint) => {
  const tile = document.createElement('article');
  tile.className = 'call-tile';
  tile.dataset.endpoint = endpoint;
  const name = document.createElement('span');
  name.className = 'call-name';
  tile.append(createVideo(true), createAvatar(), name);
  return tile;
};

class CallStage {
  #onKey = null;
  #onPhase = null;
  #onTrack = null;
  #onCall = null;
  #listening = false;

  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.session = null;
    this.media = null;
    this.token = '';
    this.chat = '';
    this.mode = '';
    this.joining = false;
    this.host = null;
    this.mini = null;
    this.people = [];
    this.remote = new Map();
    this.audios = new Map();
    this.#onKey = (event) => this.onKey(event);
    this.#onPhase = (phase) => this.onPhase(phase);
    this.#onTrack = (payload) => this.onRemoteTrack(payload);
    this.#onCall = (state) => this.onCallState(state);
  }

  attach(session, token) {
    this.detach();
    this.session = session;
    this.token = token;
    this.chat = session.chat;
    this.joining = false;
    this.people = [];
    this.remote = new Map();
    this.media = new MediaCapture();
    this.media.onChange = () => this.onMedia();
    this.media.onLevel = (level) => this.paintLevel(level);
    session.on('state', this.#onPhase);
    session.on('track', this.#onTrack);
    this.hooks.listen(this.#onCall);
    document.addEventListener('keydown', this.#onKey, true);
    this.#listening = true;
    this.mount('prejoin');
    this.media.openPreview().catch((error) => this.hooks.fail(error));
  }

  detach() {
    const session = this.session;
    if (session) {
      session.off('state', this.#onPhase);
      session.off('track', this.#onTrack);
    }
    if (this.#listening) {
      this.hooks.unlisten(this.#onCall);
      document.removeEventListener('keydown', this.#onKey, true);
      this.#listening = false;
    }
    if (this.media) this.media.stop();
    this.media = null;
    this.session = null;
    this.mode = '';
    this.joining = false;
    this.host?.remove();
    this.host = null;
    this.mini?.remove();
    this.mini = null;
    this.stopAudios();
    this.people = [];
    this.remote = new Map();
    this.root.removeAttribute('data-call');
    this.hooks.closed();
    this.hooks.changed();
  }

  mount(mode) {
    this.mode = mode;
    this.ensureHost();
    this.host.classList.remove('hidden');
    const title = this.hooks.titleOf(this.chat);
    const view = this.viewOf(mode, title);
    this.host.replaceChildren(view);
    this.root.dataset.call = mode;
    this.mini?.remove();
    this.mini = null;
    this.parkAudios();
    if (mode === 'prejoin') this.onMedia();
    if (mode === 'call') {
      this.syncControls();
      this.renderTiles();
      this.hooks.focusChat(this.chat);
      this.hooks.changed();
    }
  }

  showLobby() {
    this.joining = false;
    this.mount('lobby');
  }

  showCall(state) {
    if (state) this.onCallState(state);
    this.joining = false;
    this.mount('call');
  }

  collapse() {
    if (this.mode !== 'call') return;
    this.mode = 'mini';
    this.host.classList.add('hidden');
    this.host.replaceChildren();
    this.root.dataset.call = 'mini';
    this.mini = createMini();
    this.mini.addEventListener('click', (event) => this.onMiniClick(event));
    document.body.append(this.mini);
    this.syncControls();
    this.paintMini();
    this.hooks.changed();
  }

  expand() {
    if (this.mode !== 'mini') return;
    this.showCall();
  }

  onMiniClick(event) {
    const button = event.target.closest('[data-action]');
    if (button) return void this.onAction(button.dataset.action);
    this.expand();
  }

  onAction(action) {
    const run = ACTIONS[action];
    if (!run) return;
    const result = run(this);
    if (result?.catch) result.catch((error) => this.hooks.fail(error));
  }

  onKey(event) {
    if (event.isComposing) return;
    if (this.mode === 'prejoin') return void this.onPrejoinKey(event);
    if (this.mode !== 'call') return;
    if (this.hooks.isText(event.target)) return;
    this.onCallKey(event);
  }

  onPrejoinKey(event) {
    const isEsc = event.key === 'Escape';
    const isEnter = event.key === 'Enter' && !event.isComposing;
    if (!isEsc && !isEnter) return;
    event.preventDefault();
    event.stopPropagation();
    if (isEsc) this.cancel();
    else this.join();
  }

  onCallKey(event) {
    const command = event.ctrlKey || event.metaKey;
    if (!command || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'd' && key !== 'e') return;
    event.preventDefault();
    event.stopPropagation();
    const kind = key === 'd' ? 'mic' : 'camera';
    this.toggle(kind);
  }

  async join() {
    if (this.mode !== 'prejoin' || this.joining || !this.session) return;
    this.joining = true;
    this.syncControls();
    this.media?.resume();
    const nick = this.readNick();
    this.pushTracks();
    const input = { nick };
    if (this.token) input.token = this.token;
    try {
      const result = await this.session.join(input);
      const status = result?.status;
      if (status === 'lobby') {
        this.showLobby();
      } else if (status === 'joined') {
        await this.updateServer();
        this.showCall(result.state);
      } else {
        this.joining = false;
      }
    } catch (error) {
      this.joining = false;
      this.showNote(error.message || 'Could not join');
      this.syncControls();
    }
  }

  cancel() {
    const leaving = this.hooks.leave();
    if (leaving?.catch) leaving.catch((error) => this.hooks.fail(error));
  }

  leave() {
    this.cancel();
  }

  async toggle(kind) {
    const media = this.media;
    if (!media) return;
    media.resume();
    if (kind === 'mic') await media.toggleMic();
    else await media.toggleCamera();
  }

  onPhase(phase) {
    if (phase === 'lobby' && this.mode !== 'lobby') this.showLobby();
    if (phase === 'joined' && this.mode === 'lobby') this.showCall();
    const showing = this.mode === 'call' || this.mode === 'mini';
    if (phase === 'joined' && showing) {
      this.updateServer().catch((error) => this.hooks.fail(error));
    }
    const idle = phase === 'idle';
    const open = this.mode !== 'prejoin' && this.mode !== '';
    if (idle && open) this.detach();
  }

  onCallState(state) {
    if (!this.session || state?.call !== this.session.call) return;
    const list = Array.isArray(state.participants) ? state.participants : [];
    const people = [];
    for (const item of list) {
      const endpoint = item.endpoint;
      if (!endpoint) continue;
      const nick = typeof item.nick === 'string' ? item.nick : '';
      const peer = typeof item.peer === 'string' ? item.peer : '';
      const camera = item.camera === true;
      people.push({ endpoint, nick, peer, camera });
    }
    this.people = people;
    if (this.mode === 'call' || this.mode === 'mini') this.renderTiles();
  }

  onRemoteTrack(payload) {
    const endpoint = payload?.endpoint;
    const slot = payload?.slot;
    if (!endpoint || (slot !== 'mic' && slot !== 'camera')) return;
    const track = payload.track ?? null;
    const current = this.remote.get(endpoint) ?? { mic: null, camera: null };
    current[slot] = track;
    this.remote.set(endpoint, current);
    if (track) this.watchTrack(endpoint, slot, track);
    if (slot === 'mic') this.attachAudio(endpoint, track);
    if (this.mode === 'call' || this.mode === 'mini') this.renderTiles();
  }

  watchTrack(endpoint, slot, track) {
    const refresh = () => {
      const current = this.remote.get(endpoint);
      const ended = track.readyState === 'ended';
      if (ended && current && current[slot] === track) current[slot] = null;
      if (this.mode === 'call' || this.mode === 'mini') this.renderTiles();
    };
    track.addEventListener('ended', refresh);
    track.addEventListener('mute', refresh);
    track.addEventListener('unmute', refresh);
  }

  onMedia() {
    if (!this.media) return;
    this.fillSelects();
    this.syncControls();
    this.paintPreview();
    this.showNote(this.media.message || this.media.notice);
    if (this.mode !== 'call' && this.mode !== 'mini') return;
    this.renderTiles();
    this.pushTracks();
    this.updateServer().catch((error) => this.hooks.fail(error));
  }

  readNick() {
    const input = this.host?.querySelector('#prejoin-nick');
    if (!input || input.closest('.nick-field')?.classList.contains('hidden')) {
      return this.hooks.nick();
    }
    const nick = input.value.trim();
    if (nick) this.hooks.saveNick(nick);
    return nick || this.hooks.nick();
  }

  pushTracks() {
    const session = this.session;
    const media = this.media;
    if (!session || !media) return;
    if (media.micTrack) media.micTrack.enabled = media.micOn;
    session.setTrack('mic', media.micTrack);
    if (!media.cameraOn) media.stopCamera();
    const camera = media.cameraOn ? media.cameraTrack : null;
    session.setTrack('camera', camera);
  }

  async updateServer() {
    const session = this.session;
    const media = this.media;
    if (!session || !media) return;
    const live = session.phase === 'joined' || session.phase === 'reconnecting';
    if (!live) return;
    const mic = media.micOn;
    const camera = media.cameraOn;
    await this.hooks.update({ mic, camera });
  }

  ensureHost() {
    if (this.host) return;
    const host = document.createElement('div');
    host.className = 'call-stage';
    this.hooks.before(host);
    host.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      this.onAction(button.dataset.action);
    });
    host.addEventListener('change', (event) => this.onDevice(event));
    this.host = host;
  }

  viewOf(mode, title) {
    if (mode === 'prejoin') return createPrejoin(title, this.hooks.hasNick());
    if (mode === 'lobby') return createLobby();
    return createCall(title);
  }

  onDevice(event) {
    const select = event.target;
    const media = this.media;
    if (!media) return;
    if (select.id === 'prejoin-camera') media.setCamera(select.value);
    if (select.id === 'prejoin-mic') media.setMic(select.value);
    if (select.id === 'prejoin-speaker') media.setSpeaker(select.value);
  }

  fillSelects() {
    const media = this.media;
    const host = this.host;
    if (!media || !host) return;
    const camera = host.querySelector('#prejoin-camera');
    const mic = host.querySelector('#prejoin-mic');
    fillSelect(camera, media.cameras, media.cameraId, 'camera');
    fillSelect(mic, media.mics, media.micId, 'microphone');
    fillSelect(
      host.querySelector('#prejoin-speaker'),
      media.speakers,
      media.speakerId,
      'speaker',
    );
    const speaker = host.querySelector('.speaker-field');
    speaker?.classList.toggle('hidden', !media.canSink);
  }

  syncControls() {
    const roots = [this.host, this.mini];
    for (const root of roots) {
      if (root) this.paintButtons(root);
    }
    const media = this.media;
    const host = this.host;
    if (!media || !host) return;
    const cameraSelect = host.querySelector('#prejoin-camera');
    const micSelect = host.querySelector('#prejoin-mic');
    const camera = cameraSelect?.closest('.call-field');
    const mic = micSelect?.closest('.call-field');
    camera?.classList.toggle('warn', media.cameraMissing);
    mic?.classList.toggle('warn', media.micMissing);
    const join = host.querySelector('[data-action="join"]');
    if (join) join.disabled = this.joining;
  }

  paintButtons(root) {
    const media = this.media;
    if (!media) return;
    const mics = root.querySelectorAll('[data-action="mic"]');
    for (const button of mics) {
      button.textContent = media.micOn ? 'mic on' : 'mic off';
      button.classList.toggle('off', !media.micOn);
      button.classList.toggle('warn', media.micMissing);
    }
    const cameras = root.querySelectorAll('[data-action="camera"]');
    for (const button of cameras) {
      button.textContent = media.cameraOn ? 'camera on' : 'camera off';
      button.classList.toggle('off', !media.cameraOn);
      button.classList.toggle('warn', media.cameraMissing);
    }
  }

  paintLevel(level) {
    const bar = this.host?.querySelector('.level-bar');
    if (!bar) return;
    const width = Math.round(level * 100);
    bar.style.width = `${width}%`;
  }

  paintPreview() {
    const preview = this.host?.querySelector('.preview');
    if (!preview || !this.media) return;
    const track = this.media.cameraOn ? this.media.cameraTrack : null;
    const live = track && track.readyState === 'live' ? track : null;
    preview.classList.toggle('local', true);
    const nick = this.hooks.nick() || 'you';
    const color = colorOf(this.session?.endpoint);
    paintPerson(preview, live, nick, color);
  }

  showNote(text) {
    const note = this.host?.querySelector('.call-note');
    if (!note) return;
    note.textContent = text;
    note.classList.toggle('hidden', text === '');
  }

  renderTiles() {
    if (this.mode === 'mini') return void this.paintMini();
    const grid = this.host?.querySelector('.call-grid');
    if (!grid) return;
    const endpoints = this.tileList();
    const seen = new Set(endpoints);
    const tiles = grid.querySelectorAll('.call-tile');
    for (const tile of tiles) {
      if (!seen.has(tile.dataset.endpoint)) tile.remove();
    }
    for (const endpoint of endpoints) this.paintTile(grid, endpoint);
    this.paintMini();
  }

  paintTile(grid, endpoint) {
    let tile = null;
    for (const item of grid.querySelectorAll('.call-tile')) {
      if (item.dataset.endpoint === endpoint) tile = item;
    }
    if (!tile) {
      tile = createTile(endpoint);
      grid.append(tile);
    }
    const local = endpoint === this.session?.endpoint;
    tile.classList.toggle('local', local);
    const name = this.nameOf(endpoint);
    const color = colorOf(endpoint);
    paintPerson(tile, this.videoTrack(endpoint), name, color);
    const chip = tile.querySelector('.call-name');
    if (chip) chip.textContent = name;
  }

  paintMini() {
    const mini = this.mini;
    if (!mini || !this.session) return;
    const endpoint = this.featured();
    mini.dataset.endpoint = endpoint;
    const local = endpoint === this.session.endpoint;
    mini.classList.toggle('local', local);
    const name = this.nameOf(endpoint);
    const color = colorOf(endpoint);
    paintPerson(mini, this.videoTrack(endpoint), name, color);
  }

  tileList() {
    const endpoints = [];
    const seen = new Set();
    const add = (endpoint) => {
      if (!endpoint || seen.has(endpoint)) return;
      seen.add(endpoint);
      endpoints.push(endpoint);
    };
    for (const person of this.people) add(person.endpoint);
    add(this.session?.endpoint);
    for (const endpoint of this.remote.keys()) add(endpoint);
    return endpoints;
  }

  featured() {
    for (const endpoint of this.tileList()) {
      if (endpoint === this.session?.endpoint) continue;
      if (this.videoTrack(endpoint)) return endpoint;
    }
    return this.session?.endpoint ?? '';
  }

  videoTrack(endpoint) {
    if (endpoint === this.session?.endpoint) {
      const track = this.media?.cameraTrack;
      const live = track && track.readyState === 'live' && this.media.cameraOn;
      return live ? track : null;
    }
    let listed = false;
    let cameraOn = false;
    for (const person of this.people) {
      if (person.endpoint !== endpoint) continue;
      listed = true;
      cameraOn = person.camera === true;
      break;
    }
    if (listed && !cameraOn) return null;
    const track = this.remote.get(endpoint)?.camera ?? null;
    const live = track && track.readyState === 'live' && !track.muted;
    if (!live) return null;
    return track;
  }

  nameOf(endpoint) {
    if (endpoint === this.session?.endpoint) return this.hooks.nick() || 'you';
    for (const person of this.people) {
      if (person.endpoint === endpoint) return person.nick || 'guest';
    }
    return 'guest';
  }

  attachAudio(endpoint, track) {
    const current = this.audios.get(endpoint) ?? null;
    const live = track && track.readyState === 'live';
    if (!live) {
      current?.remove();
      if (current) current.srcObject = null;
      this.audios.delete(endpoint);
      return;
    }
    const audio = current ?? document.createElement('audio');
    audio.autoplay = true;
    const playing = audio.srcObject?.getAudioTracks?.()[0] ?? null;
    if (playing !== track) audio.srcObject = streamOf(track);
    this.audios.set(endpoint, audio);
    this.parkAudios();
    this.media?.applySink(audio);
    audio.play().catch(() => undefined);
  }

  parkAudios() {
    if (!this.host) return;
    for (const audio of this.audios.values()) this.host.append(audio);
  }

  stopAudios() {
    for (const audio of this.audios.values()) {
      audio.srcObject = null;
      audio.remove();
    }
    this.audios.clear();
  }
}

export { CallStage };
