import { generateUUID } from './metautil.js';
import { createButton, defaultsOf, paintSceneFields } from './record-panel.js';
import { valueOf } from './record-panel.js';
import { builtInScenes, scenesOf, sceneOf, brandOf } from './studio-layout.js';
import { brandFont, countdownUntil, fadeAlpha } from './studio-layout.js';
import { DEFAULT_MUSIC_VOLUME, TRANSITIONS } from './studio-layout.js';
import { OVERLAYS } from './studio-layout.js';
import { textsOf, overlayOpacity, commentText } from './studio-layout.js';
import { StudioClip } from './studio-clip.js';
import { countOf } from './layout.js';
import { labeled } from './view.js';
import { groupOf, SCENES, BRAND, MUSIC, TEXTS } from './studio-storage.js';
import { readJSON, writeJSON, readAssets } from './studio-storage.js';
import { readAsset } from './studio-storage.js';
import { withStudioDirectory, addAsset } from './studio-storage.js';
import { deleteAsset } from './studio-storage.js';
import { createDestinationControls } from './stream-panel.js';
import { createSideBar, createSideBody } from './call-side.js';
import { createSceneControls, createSceneEditor } from './studio-panel.js';
import { createBrandControls, createAssetControls } from './studio-panel.js';
import { createSceneRow, createAssetRow, paintValues } from './studio-panel.js';
import { createTextControls, createBannerRow } from './studio-panel.js';
import { createLowerThird } from './studio-panel.js';
import { paintOptions, paintList } from './studio-panel.js';

const STAGES = [
  { label: 'On stage', onStage: true },
  { label: 'Backstage', onStage: false },
];

const BRAND_FIELDS = {
  accent: 'accent',
  brandText: 'text',
  chip: 'chip',
  chipStyle: 'chipStyle',
  font: 'font',
};

const isLowerThirdEligible = (person) =>
  Boolean(person) && person.stage !== false && !person.optOut;

const LOGO_FIELDS = { logoAsset: 'asset', corner: 'corner', size: 'size' };

const stageMove = (person) =>
  person.stage === false
    ? { action: 'move-to-stage', label: 'Move to stage' }
    : { action: 'move-to-backstage', label: 'Move to backstage' };

const createStageLists = (people, createRow) =>
  STAGES.map(({ label, onStage }) => {
    const section = document.createElement('section');
    section.className = 'call-stage-group';
    const title = document.createElement('h3');
    title.textContent = label;
    const list = document.createElement('ul');
    list.className = 'call-roster';
    const members = people.filter(
      (person) => (person.stage !== false) === onStage,
    );
    list.append(...members.map(createRow));
    section.append(title, list);
    return section;
  });

const createSwitch = (name, label) => {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.studio = name;
  input.setAttribute('role', 'switch');
  return labeled(input, label);
};

const createRow = (person, isAdmin) => {
  const row = document.createElement('li');
  row.dataset.endpoint = person.endpoint;
  const name = document.createElement('span');
  name.textContent = person.nick || person.endpoint;
  row.append(name);
  if (isAdmin) {
    const { action, label } = stageMove(person);
    const move = createButton(action, label);
    move.setAttribute('aria-label', `${label} (${name.textContent})`);
    row.append(move);
  }
  if (isLowerThirdEligible(person)) {
    const lowerThird = createLowerThird(person);
    lowerThird.setAttribute('aria-label', `Lower third (${name.textContent})`);
    row.append(lowerThird);
  }
  return row;
};

const createStudioPanel = () => {
  const panel = document.createElement('aside');
  panel.className = 'call-studio';
  panel.setAttribute('aria-label', 'Studio');
  const preview = document.createElement('div');
  preview.className = 'studio-preview';
  const note = document.createElement('p');
  note.className = 'call-note studio-note';
  note.setAttribute('role', 'status');
  const status = document.createElement('p');
  status.className = 'call-note studio-status';
  status.setAttribute('role', 'status');
  const permission = document.createElement('p');
  permission.className = 'studio-permission';
  permission.textContent = 'Only hosts can move people';
  const stageLists = document.createElement('div');
  stageLists.className = 'studio-stage-lists';
  const live = createButton('go-live', 'Go live');
  live.classList.add('stream-live');
  const body = createSideBody(
    createSwitch('enabled', 'Enable Studio'),
    preview,
    note,
    status,
    createDestinationControls(),
    createSceneControls(),
    createSceneEditor(),
    createSwitch('join-backstage', 'New people go backstage'),
    permission,
    stageLists,
    createTextControls(),
    createBrandControls(),
    createAssetControls(),
  );
  panel.append(body, createSideBar(live));
  return panel;
};

const volumeOf = (value) => countOf(value, 0, 100, DEFAULT_MUSIC_VOLUME);

const readFont = async () => {
  if (!document.fonts) return 'system-ui';
  if ((await document.fonts.load(brandFont('Fira Code', 22))).length) {
    return 'Fira Code';
  }
  const Face = globalThis.FontFace;
  if (typeof Face !== 'function') return 'system-ui';
  const local = new Face('Fira Code', 'local("Fira Code")', {
    weight: '100 900',
  });
  await local.load();
  document.fonts.add(local);
  return 'Fira Code';
};

const decodeImage = async (blob) => {
  const url = URL.createObjectURL(blob);
  const image = document.createElement('img');
  image.src = url;
  try {
    if (typeof image.decode === 'function') {
      await image.decode();
    } else {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
    }
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
};

const availableAsset = (assets, id, group) =>
  groupOf(assets.get(id)?.type) === group ? id : '';

const scenesWithAssets = (settings, assets) => ({
  ...settings,
  scenes: settings.scenes.map((scene) => ({
    ...scene,
    background: {
      ...scene.background,
      image: availableAsset(assets, scene.background.image, 'image'),
    },
    music: availableAsset(assets, scene.music, 'audio'),
  })),
});

const brandWithAssets = (brand, assets) => ({
  ...brand,
  logo: {
    ...brand.logo,
    asset: availableAsset(assets, brand.logo.asset, 'image'),
  },
});

const sceneValues = (draft) => ({
  name: draft.name,
  type: draft.type,
  text: draft.text,
  minutes: draft.minutes,
  color: draft.background.color,
  image: draft.background.image,
  music: draft.music,
  ...Object.fromEntries(
    OVERLAYS.map((name) => [name, draft.overlays.includes(name)]),
  ),
});

const brandValues = (brand) => ({
  accent: brand.accent,
  brandText: brand.text,
  chip: brand.chip,
  chipStyle: brand.chipStyle,
  font: brand.font,
  logoAsset: brand.logo.asset,
  corner: brand.logo.corner,
  size: brand.logo.size,
});

const editScene = (draft, control) => {
  const { studio, record, pin, volume } = control.dataset;
  const value = valueOf(control);
  if (record) {
    return { ...draft, program: { ...draft.program, [record]: value } };
  }
  if (pin) {
    const pinned = draft.program.pinned.filter((item) => item !== pin);
    if (value) pinned.push(pin);
    return { ...draft, program: { ...draft.program, pinned } };
  }
  if (volume) {
    const volumes = { ...draft.program.volumes, [volume]: Number(value) / 100 };
    return { ...draft, program: { ...draft.program, volumes } };
  }
  if (studio === 'color' || studio === 'image') {
    return { ...draft, background: { ...draft.background, [studio]: value } };
  }
  if (OVERLAYS.includes(studio)) {
    const overlays = draft.overlays.filter((overlay) => overlay !== studio);
    if (value) overlays.push(studio);
    return { ...draft, overlays };
  }
  return { ...draft, [studio]: studio === 'minutes' ? Number(value) : value };
};

class Studio {
  #ready = null;
  #pending = Promise.resolve();
  #settings = null;
  #brand = brandOf();
  #font = 'system-ui';
  #loadFont = null;
  #draft = null;
  #isNew = false;
  #assets = new Map();
  #media = new Map();
  #volume = DEFAULT_MUSIC_VOLUME;
  #texts = textsOf();
  #bannerDraft = null;
  #tickerAt = 0;
  #shown = new Map();
  #clip = null;
  #current = null;
  #previous = null;
  #switchedAt = 0;
  #until = 0;
  #notice = '';
  #disposed = false;

  constructor(stage) {
    this.stage = stage;
    this.enabled = false;
    this.#setScenes(builtInScenes(this.#defaults()));
  }

  get activeScene() {
    return this.#current;
  }

  get music() {
    if (!this.enabled) return null;
    const checksum = this.#current?.music;
    const blob = this.#media.get(checksum)?.blob;
    return blob ? { checksum, blob, volume: this.#volume / 100 } : null;
  }

  musicFailed(error) {
    this.#notice = `Could not play Studio music: ${error.message}`;
    this.paint();
  }

  get clip() {
    return this.enabled ? this.#clip : null;
  }

  clipFailed(error) {
    this.#notice = `Could not play Studio clip: ${error.message}`;
    this.#stopClip();
    this.paint();
  }

  isCommentShown(id) {
    return this.#selected('comment') === id;
  }

  toggleComment({ id, nick, content }) {
    if (!this.enabled) return;
    const value = { nick: nick || 'guest', text: commentText(content) };
    if (!value.text) return;
    this.#selectOverlay('comment', id, value);
  }

  #selected(kind) {
    const entry = this.#shown.get(kind);
    return entry?.to === 1 ? entry.id : '';
  }

  #selectOverlay(kind, id, value) {
    const current = this.#shown.get(kind);
    const same = current?.id === id;
    const now = Date.now();
    const from = same ? overlayOpacity(current, now) : 0;
    const to = same && current.to === 1 ? 0 : 1;
    this.#shown.set(kind, { id, value, from, to, started: now });
  }

  #overlays(now, reduced) {
    const overlays = [];
    if (this.#texts.ticker) {
      overlays.push({
        kind: 'ticker',
        text: this.#texts.ticker,
        elapsed: now - this.#tickerAt,
        alpha: 1,
      });
    }
    for (const kind of this.#shown.keys()) {
      const entry = this.#shown.get(kind);
      const alpha = overlayOpacity(entry, now, reduced);
      if (entry.to === 0 && alpha === 0) this.#shown.delete(kind);
      if (alpha === 0) continue;
      let value = entry.value;
      if (kind === 'lowerThird') {
        const person = this.stage.personOf(entry.id);
        if (!isLowerThirdEligible(person)) continue;
        value = {
          nick: person.nick || 'guest',
          text: person.title || '',
          local: this.stage.session?.endpoint === entry.id,
        };
      }
      overlays.push({ kind, ...value, alpha });
    }
    return overlays;
  }

  frame(now, reduced = false) {
    if (!this.enabled || !this.#current) return null;
    const alpha = fadeAlpha(this.#switchedAt, now);
    if (alpha === 1) this.#previous = null;
    return {
      scene: this.#current,
      previous: this.#previous,
      alpha,
      until: this.#until,
      brand: this.#brand,
      font: this.#brand.font === 'Fira Code' ? this.#font : 'system-ui',
      image: (id) => this.#media.get(id)?.image,
      overlays: this.#overlays(now, reduced),
      clip: this.clip,
    };
  }

  dispose() {
    this.#disposed = true;
    this.#stopClip();
    this.#media.clear();
  }

  #defaults() {
    return defaultsOf(this.stage.preferences);
  }

  #readScenes(directory) {
    return readJSON(directory, SCENES).then((raw) =>
      scenesOf(raw, this.#defaults()),
    );
  }

  #setScenes(settings, switchScene = false) {
    const before = this.#current;
    const scene = settings.scenes.find(({ id }) => id === settings.active);
    this.#settings = settings;
    this.#current = scene ?? null;
    if (!scene) {
      this.enabled = false;
      this.#stopClip();
    }
    const typeChanged = scene?.type !== before?.type;
    const minutesChanged = scene?.minutes !== before?.minutes;
    if (scene?.id !== before?.id) {
      const now = Date.now();
      const fades =
        switchScene && this.enabled && settings.transition === 'fade';
      this.#previous =
        fades && before ? { scene: before, until: this.#until } : null;
      this.#switchedAt = now;
      this.#startCountdown(now);
    } else if (typeChanged || minutesChanged) {
      this.#startCountdown(Date.now());
    }
  }

  #startCountdown(now) {
    const scene = this.#current;
    this.#until =
      scene?.type === 'countdown' ? countdownUntil(scene.minutes, now) : 0;
  }

  #load() {
    if (this.#ready) return this.#ready;
    this.#ready = withStudioDirectory(async (directory) => {
      const settings = await this.#readScenes(directory);
      const brand = brandOf(await readJSON(directory, BRAND));
      const assets = await readAssets(directory);
      const volume = await readJSON(directory, MUSIC);
      const texts = textsOf(await readJSON(directory, TEXTS));
      if (this.#disposed) return;
      this.#setScenes(scenesWithAssets(settings, assets));
      this.#brand = brandWithAssets(brand, assets);
      this.#assets = assets;
      this.#volume = volumeOf(volume);
      this.#texts = texts;
    })
      .then(() => this.#prepareMedia())
      .catch((error) => {
        this.#notice = error.message;
      })
      .finally(() => this.paint());
    return this.#ready;
  }

  async #prepareMedia() {
    if (this.#disposed) return;
    if (this.#brand.font === 'Fira Code' && !this.#loadFont) {
      this.#loadFont = readFont()
        .catch(() => 'system-ui')
        .then((font) => {
          this.#font = font;
        });
    }
    const wanted = new Set();
    for (const scene of this.#settings.scenes) {
      if (scene.background.image) wanted.add(scene.background.image);
      if (scene.music) wanted.add(scene.music);
    }
    if (this.#brand.logo.asset) wanted.add(this.#brand.logo.asset);
    if (this.#previous?.scene.background.image) {
      wanted.add(this.#previous.scene.background.image);
    }
    for (const id of this.#media.keys()) {
      if (!wanted.has(id) || !this.#assets.has(id)) this.#media.delete(id);
    }
    const pending = [];
    for (const id of wanted) {
      const asset = this.#assets.get(id);
      if (!asset) continue;
      if (!this.#media.has(id)) this.#readMedia(asset);
      pending.push(this.#media.get(id).ready);
    }
    await Promise.all(pending);
  }

  #readMedia(asset) {
    const { checksum, type, name } = asset;
    const entry = {};
    this.#media.set(checksum, entry);
    entry.ready = withStudioDirectory((directory) =>
      readAsset(directory, asset),
    )
      .then(async (blob) => {
        if (!blob) throw new Error('Missing Studio asset');
        if (groupOf(type) === 'image') entry.image = await decodeImage(blob);
        else entry.blob = blob;
      })
      .catch(() => {
        if (this.#media.get(checksum) !== entry) return;
        this.#media.delete(checksum);
        this.#notice = `Could not load ${name}`;
        this.paint();
      });
  }

  #enqueue(change) {
    const waiting = this.#load();
    this.#pending = this.#pending.then(async () => {
      await waiting;
      if (this.#disposed) return;
      this.#notice = '';
      try {
        await change();
      } catch (error) {
        this.#notice = error.message;
      }
      if (this.#disposed) return;
      this.paint();
      this.stage.recording?.paint();
    });
    return this.#pending;
  }

  #changeScenes(transform, switchScene = false) {
    return this.#enqueue(async () => {
      const settings = await withStudioDirectory(async (directory) => {
        const before = await this.#readScenes(directory);
        const assets = await readAssets(directory);
        const after = scenesWithAssets(transform(before), assets);
        await writeJSON(directory, SCENES, after);
        this.#assets = assets;
        return after;
      });
      this.#setScenes(settings, switchScene);
      await this.#prepareMedia();
    });
  }

  #changeBrand(name, value) {
    return this.#enqueue(async () => {
      this.#brand = await withStudioDirectory(async (directory) => {
        const brand = brandOf(await readJSON(directory, BRAND));
        if (Object.hasOwn(LOGO_FIELDS, name)) {
          brand.logo[LOGO_FIELDS[name]] =
            name === 'size' ? Number(value) : value;
        } else {
          brand[BRAND_FIELDS[name]] = value;
        }
        const assets = await readAssets(directory);
        const next = brandWithAssets(brandOf(brand), assets);
        await writeJSON(directory, BRAND, next);
        this.#assets = assets;
        return next;
      });
      await this.#prepareMedia();
    });
  }

  #removeAsset(id) {
    return this.#enqueue(async () => {
      await withStudioDirectory(async (directory) => {
        const assets = await readAssets(directory);
        if (!assets.has(id)) return;
        const remaining = new Map(assets);
        remaining.delete(id);
        const before = await this.#readScenes(directory);
        const scenes = scenesWithAssets(before, remaining);
        const brand = brandWithAssets(
          brandOf(await readJSON(directory, BRAND)),
          remaining,
        );
        await writeJSON(directory, SCENES, scenes);
        await writeJSON(directory, BRAND, brand);
        const cleanup = await deleteAsset(directory, assets, id);
        this.#assets = assets;
        if (this.#clip?.checksum === id) this.#stopClip();
        this.#setScenes(scenes);
        this.#brand = brand;
        if (cleanup) this.#notice = cleanup.message;
        if (this.#draft) {
          const draft = { scenes: [this.#draft] };
          this.#draft = scenesWithAssets(draft, assets).scenes[0];
        }
      });
      await this.#prepareMedia();
    });
  }

  async change(control) {
    const name = control.dataset.studio;
    if (name === 'join-backstage') {
      await this.stage.command('joinBackstage', '', control.checked);
      if (this.stage.studio === this) this.paint();
      return;
    }
    if (control.closest('[data-studio-section="editor"]')) {
      if (!this.#draft) return;
      this.#draft = editScene(this.#draft, control);
      this.paint();
      return;
    }
    const value = valueOf(control);
    if (name === 'bannerText' && this.#bannerDraft) {
      this.#bannerDraft.text = value;
      return;
    }
    if (name === 'tickerText') {
      await this.#changeTexts((texts) => ({ ...texts, ticker: value }));
      return;
    }
    if (name === 'enabled') {
      await this.#enqueue(() => {
        this.enabled = value && Boolean(this.#current);
        this.#previous = null;
        if (this.enabled) {
          const now = Date.now();
          this.#startCountdown(now);
          this.#tickerAt = now;
        } else {
          this.#stopClip();
        }
      });
      return;
    }
    if (name === 'transition') {
      if (!TRANSITIONS.includes(value)) return;
      await this.#changeScenes((settings) => ({
        ...settings,
        transition: value,
      }));
      return;
    }
    if (Object.hasOwn(BRAND_FIELDS, name) || Object.hasOwn(LOGO_FIELDS, name)) {
      await this.#changeBrand(name, value);
      return;
    }
    if (name === 'musicVolume') {
      await this.#enqueue(async () => {
        const volume = volumeOf(Number(value));
        await withStudioDirectory((directory) =>
          writeJSON(directory, MUSIC, volume),
        );
        this.#volume = volume;
      });
      return;
    }
    if (name === 'upload') {
      const file = control.files?.[0];
      control.value = '';
      if (!file) return;
      await this.#enqueue(async () => {
        this.#assets = await withStudioDirectory((directory) =>
          addAsset(directory, file),
        );
        await this.#prepareMedia();
      });
    }
  }

  async action(control) {
    const { studioAction, id } = control.dataset;
    if (studioAction === 'switch-scene') {
      await this.#changeScenes((settings) => {
        if (!settings.scenes.some((scene) => scene.id === id)) return settings;
        return { ...settings, active: id };
      }, true);
      return;
    }
    if (studioAction === 'delete-asset') {
      await this.#removeAsset(id);
      return;
    }
    if (studioAction === 'lower-third') {
      if (this.enabled && isLowerThirdEligible(this.stage.personOf(id))) {
        this.#selectOverlay('lowerThird', id);
        this.paint();
      }
      return;
    }
    if (studioAction === 'stop-clip') {
      await this.#enqueue(() => {
        if (this.#clip?.checksum === id) this.#stopClip();
      });
      return;
    }
    if (studioAction === 'play-full' || studioAction === 'play-tile') {
      await this.#playClip(id, studioAction === 'play-tile' ? 'tile' : 'full');
      return;
    }
    if (studioAction.endsWith('-banner')) {
      await this.#bannerAction(studioAction, id);
      return;
    }
    if (studioAction === 'save-scene') {
      await this.#saveScene();
      return;
    }
    if (studioAction === 'delete-scene') {
      await this.#deleteScene();
      return;
    }
    await this.#enqueue(() => {
      this.#isNew = studioAction === 'add-scene';
      if (this.#isNew) {
        const scene = { id: generateUUID(), name: 'Untitled', type: 'live' };
        this.#draft = sceneOf(scene, this.#defaults());
      } else {
        this.#draft = this.#settings.scenes.find((scene) => scene.id === id);
      }
    });
  }

  #changeTexts(transform) {
    return this.#enqueue(() =>
      withStudioDirectory(async (directory) => {
        const before = this.#texts;
        const saved = textsOf(await readJSON(directory, TEXTS));
        const texts = textsOf(transform(saved));
        await writeJSON(directory, TEXTS, texts);
        if (texts.ticker !== before.ticker) this.#tickerAt = Date.now();
        this.#texts = texts;
        const selected = this.#shown.get('banner');
        if (!selected || selected.to === 0) return;
        const banner = texts.banners.find(({ id }) => id === selected.id);
        if (banner) selected.value = { text: banner.text };
        else this.#selectOverlay('banner', selected.id, selected.value);
      }),
    );
  }

  async #bannerAction(action, id) {
    const banner = this.#texts.banners.find((item) => item.id === id);
    if (action === 'show-banner') {
      if (this.enabled && banner) {
        this.#selectOverlay('banner', id, { text: banner.text });
        this.paint();
      }
      return;
    }
    if (action === 'add-banner') {
      this.#bannerDraft = { id: generateUUID(), text: '' };
    } else if (action === 'edit-banner' && banner) {
      this.#bannerDraft = { ...banner };
    } else if (action === 'cancel-banner') {
      this.#bannerDraft = null;
    } else if (action === 'save-banner') {
      await this.#saveBanner();
      return;
    } else if (action === 'delete-banner' && banner) {
      if (this.#bannerDraft?.id === id) this.#bannerDraft = null;
      await this.#changeTexts((texts) => ({
        ...texts,
        banners: texts.banners.filter((item) => item.id !== id),
      }));
      return;
    }
    this.paint();
  }

  async #saveBanner() {
    const draft = this.#bannerDraft;
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) {
      this.#notice = 'Enter banner text';
      this.paint();
      return;
    }
    const { id } = draft;
    await this.#changeTexts((texts) => {
      const banners = new Map(texts.banners.map((item) => [item.id, item]));
      banners.set(id, { id, text });
      return { ...texts, banners: [...banners.values()] };
    });
    if (this.#notice || this.#bannerDraft !== draft) return;
    this.#bannerDraft = null;
    this.paint();
  }

  #playClip(id, mode) {
    return this.#enqueue(async () => {
      const asset = this.#assets.get(id);
      if (!this.enabled || groupOf(asset?.type) !== 'video') return;
      const blob = await withStudioDirectory((directory) =>
        readAsset(directory, asset),
      );
      if (this.#disposed) return;
      if (!blob) throw new Error(`Could not load ${asset.name}`);
      this.#stopClip();
      const clip = new StudioClip(
        asset,
        mode,
        blob,
        () => this.#stopClip(),
        (error) => this.clipFailed(error),
      );
      this.#clip = clip;
      this.stage.recording?.mixer?.update();
      if (this.#clip === clip && !clip.media) clip.preview();
    });
  }

  #stopClip() {
    const clip = this.#clip;
    if (!clip) return;
    this.#clip = null;
    clip.stop();
    this.stage.recording?.mixer?.update();
    this.paint();
  }

  async #saveScene() {
    const draft = this.#draft;
    if (!draft) return;
    const scene = sceneOf(draft, this.#defaults());
    if (!scene) {
      this.#notice = 'Enter a scene name';
      this.paint();
      return;
    }
    const isNew = this.#isNew;
    await this.#changeScenes((settings) => {
      const found = settings.scenes.some(({ id }) => id === scene.id);
      if (!found && !isNew) throw new Error('This scene was deleted');
      const scenes = found
        ? settings.scenes.map((current) =>
            current.id === scene.id ? scene : current,
          )
        : settings.scenes.concat(scene);
      return { ...settings, scenes, active: settings.active || scene.id };
    });
    if (this.#notice || this.#draft !== draft) return;
    this.#draft = null;
    this.paint();
  }

  async #deleteScene() {
    const id = this.#draft?.id;
    if (!id) return;
    await this.#changeScenes((settings) => {
      const scenes = settings.scenes.filter((scene) => scene.id !== id);
      const first = scenes[0]?.id ?? '';
      const active = settings.active === id ? first : settings.active;
      return { ...settings, scenes, active };
    });
    if (this.#notice || this.#draft?.id !== id) return;
    this.#draft = null;
    this.paint();
  }

  #paintControls(panel, people) {
    const { transition, active, scenes } = this.#settings;
    const notice = panel.querySelector('.studio-status');
    notice.textContent = this.#notice;
    panel.querySelector('[data-studio="enabled"]').disabled = !active;
    const assets = this.#assets;
    const assetKey = JSON.stringify([...assets.values()]);
    const sceneKey = JSON.stringify(scenes.map(({ id, name }) => [id, name]));
    paintOptions(panel, assets, assetKey);
    paintList(panel, 'scenes', sceneKey, scenes, createSceneRow);
    const switches = panel.querySelectorAll(
      '[data-studio-action="switch-scene"]',
    );
    for (const button of switches) {
      button.setAttribute('aria-pressed', `${button.dataset.id === active}`);
    }
    paintList(panel, 'assets', assetKey, [...assets.values()], createAssetRow);
    paintValues(panel, { transition, musicVolume: this.#volume });
    paintValues(panel, brandValues(this.#brand));
    this.#paintTexts(panel);
    for (const button of panel.querySelectorAll(
      '[data-studio-list="assets"] button',
    )) {
      const active = this.#clip?.checksum === button.dataset.id;
      const action = button.dataset.studioAction;
      if (action === 'stop-clip') button.disabled = !active;
      if (action === 'play-full' || action === 'play-tile') {
        button.disabled = !this.enabled;
        const mode = action === 'play-full' ? 'full' : 'tile';
        button.setAttribute(
          'aria-pressed',
          `${active && this.#clip.mode === mode}`,
        );
      }
    }
    const box = panel.querySelector('[data-studio-section="editor"]');
    const draft = this.#draft;
    box.hidden = !draft;
    if (!draft) return;
    paintValues(box, sceneValues(draft));
    box.querySelector('[data-studio="minutes"]').closest('label').hidden =
      draft.type !== 'countdown';
    box.querySelector('[data-studio="text"]').closest('label').hidden =
      draft.type === 'live';
    box.querySelector('[data-studio-action="delete-scene"]').hidden =
      this.#isNew;
    const endpoint = this.stage.session?.endpoint;
    const others = people.filter((person) => person.endpoint !== endpoint);
    paintSceneFields(box, draft.program, others);
  }

  #paintTexts(panel) {
    const { banners, ticker } = this.#texts;
    paintList(
      panel,
      'banners',
      JSON.stringify(banners),
      banners,
      createBannerRow,
    );
    paintValues(panel, { tickerText: ticker });
    const editor = panel.querySelector('[data-studio-section="banner-editor"]');
    editor.hidden = !this.#bannerDraft;
    if (this.#bannerDraft) {
      paintValues(editor, { bannerText: this.#bannerDraft.text });
    }
    for (const button of panel.querySelectorAll(
      '[data-studio-action="show-banner"]',
    )) {
      const shown = this.#selected('banner') === button.dataset.id;
      const label = shown ? 'Hide' : 'Show';
      const text = banners.find(({ id }) => id === button.dataset.id).text;
      button.textContent = label;
      button.setAttribute('aria-label', `${label} banner: ${text}`);
      button.setAttribute('aria-pressed', `${shown}`);
      button.disabled = !this.enabled;
    }
  }

  paint() {
    if (this.#disposed) return;
    const { stage, enabled } = this;
    const panel = stage.host?.querySelector('.call-studio');
    if (!panel) return;
    panel.querySelector('[data-studio="enabled"]').checked = enabled;
    const join = panel.querySelector('[data-studio="join-backstage"]');
    const { isAdmin, people, joinBackstage } = stage;
    if (stage.programPanel === 'studio') {
      this.#load();
      this.#paintControls(panel, people);
      stage.streaming?.paint(panel);
    }
    join.checked = joinBackstage;
    join.closest('label').hidden = !isAdmin;
    panel.querySelector('.studio-permission').hidden = isAdmin;
    const lists = panel.querySelector('.studio-stage-lists');
    const key = JSON.stringify([
      isAdmin,
      people.map(({ endpoint, nick, stage, optOut }) => ({
        endpoint,
        nick,
        stage,
        optOut,
      })),
    ]);
    if (lists.dataset.key !== key) {
      lists.dataset.key = key;
      const row = (person) => createRow(person, isAdmin);
      lists.replaceChildren(...createStageLists(people, row));
    }
    for (const button of lists.querySelectorAll(
      '[data-studio-action="lower-third"]',
    )) {
      const selected = this.#selected('lowerThird') === button.dataset.id;
      button.setAttribute('aria-pressed', `${selected}`);
      button.disabled = !enabled;
    }
  }
}

export { createStageLists, createStudioPanel, stageMove, Studio };
