import { timeInputOf } from './recording-edit-logic.js';

const MAX_ZOOM = 128;
const MIN_TICK_WIDTH = 72;
const SCROLL_EDGE = 32;
const PAN_STEPS = 1000;
const DRAG_DISTANCE = 4;
const TICK_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000,
  60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 18000000,
];

const scaleStep = (duration, width) => {
  const minimum = (duration * MIN_TICK_WIDTH) / width;
  return (
    TICK_STEPS.find((step) => step >= minimum) ??
    Math.ceil(minimum / 3600000) * 3600000
  );
};

const centered = (x, left, width) => Math.max(left, Math.min(left + width, x));

const timeAt = (x, { left, width }, duration) =>
  Math.round(((centered(x, left, width) - left) / width) * duration);

const tickText = (time, step) => {
  const text = timeInputOf(time);
  if (step < 1000) return text;
  if (text.startsWith('00:')) return text.slice(3, -4);
  return text.slice(0, -4);
};

class RecordingTimeline {
  constructor(nodes, hooks, signal) {
    this.nodes = nodes;
    this.hooks = hooks;
    this.duration = 0;
    this.zoom = 1;
    this.time = 0;
    this.tickFrame = null;
    const { viewport, ruler, track, pan } = nodes;
    nodes['zoom-in'].onclick = () => this.setZoom(this.zoom * 2);
    nodes['zoom-out'].onclick = () => this.setZoom(this.zoom / 2);
    nodes['zoom-fit'].onclick = () => this.setZoom(1);
    viewport.addEventListener('scroll', () => this.update(), { signal });
    viewport.addEventListener('wheel', (event) => this.wheel(event), {
      passive: false,
      signal,
    });
    pan.oninput = () => {
      viewport.scrollLeft = (this.scrollRange * Number(pan.value)) / PAN_STEPS;
    };
    window.addEventListener('resize', () => this.update(), { signal });
    signal.addEventListener(
      'abort',
      () => {
        if (this.tickFrame !== null) {
          globalThis.cancelAnimationFrame(this.tickFrame);
        }
      },
      { once: true },
    );
    this.signal = signal;
    this.bindDrag(ruler, (time) => {
      this.hooks.seek(time);
      return { move: this.hooks.seek };
    });
    this.bindDrag(track, (start, event) => {
      if (event.target.closest('button')) return null;
      const x = event.clientX;
      const canDraw = this.hooks.canDraw();
      let range = null;
      const move = (end, point) => {
        if (!canDraw) {
          this.hooks.seek(end);
          return;
        }
        if (Math.abs(point - x) < DRAG_DISTANCE && !range) return;
        range = {
          start: Math.min(start, end),
          end: Math.max(start, end),
        };
        this.hooks.range(range, false);
      };
      const end = (time, commit, point) => {
        if (range) {
          if (commit) move(time, point);
          this.hooks.range(commit ? range : null, commit);
        } else if (commit) {
          this.hooks.seek(time);
        }
      };
      return { move, end };
    });
  }

  get scrollRange() {
    const viewport = this.nodes.viewport;
    return viewport.scrollWidth - viewport.clientWidth;
  }

  setDuration(duration) {
    this.duration = duration;
    this.updateControls();
    this.update();
  }

  pointTime(x) {
    return timeAt(x, this.nodes.track.getBoundingClientRect(), this.duration);
  }

  screenPoint(time) {
    const { left, width } = this.nodes.track.getBoundingClientRect();
    return left + (time / this.duration) * width;
  }

  setTime(time, follow = false) {
    this.time = time;
    if (!this.duration) return;
    this.nodes.playhead.style.left = `${(100 * time) / this.duration}%`;
    if (follow) this.reveal(time);
  }

  reveal(time) {
    if (this.zoom === 1) return;
    const viewport = this.nodes.viewport;
    const box = viewport.getBoundingClientRect();
    const x = this.screenPoint(time);
    if (x < box.left + 10 || x > box.right - 10) {
      viewport.scrollLeft += x - box.left - box.width / 2;
    }
  }

  setZoom(value, x = null) {
    const { viewport, strip } = this.nodes;
    const zoom = Math.max(1, Math.min(MAX_ZOOM, value));
    if (!this.duration || zoom === this.zoom) return;
    const box = viewport.getBoundingClientRect();
    const playhead = this.screenPoint(this.time);
    const anchor =
      x ??
      (playhead >= box.left && playhead <= box.right
        ? playhead
        : box.left + box.width / 2);
    const time = this.pointTime(anchor);
    this.zoom = zoom;
    strip.style.width = `${zoom * 100}%`;
    viewport.scrollLeft += this.screenPoint(time) - anchor;
    this.updateControls();
    this.update();
  }

  updateControls() {
    const nodes = this.nodes;
    nodes['zoom-in'].disabled = this.zoom === MAX_ZOOM;
    nodes['zoom-fit'].disabled = this.zoom === 1;
    nodes['zoom-out'].disabled = this.zoom === 1;
    nodes['zoom-level'].textContent = `${this.zoom}×`;
    nodes['pan-row'].hidden = this.zoom === 1;
  }

  wheel(event) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      this.setZoom(this.zoom * (event.deltaY < 0 ? 2 : 0.5), event.clientX);
    } else if (event.shiftKey && this.scrollRange && event.deltaY) {
      event.preventDefault();
      this.nodes.viewport.scrollLeft += event.deltaY;
    }
  }

  update() {
    if (this.tickFrame !== null || this.signal.aborted) return;
    this.tickFrame = requestAnimationFrame(() => {
      this.tickFrame = null;
      this.paintTicks();
    });
  }

  paintTicks() {
    const { ruler, viewport, pan } = this.nodes;
    const width = ruler.clientWidth;
    if (!width || !this.duration) return;
    const step = scaleStep(this.duration, width);
    const { left, right } = viewport.getBoundingClientRect();
    const first = Math.floor(this.pointTime(left) / step) * step;
    const last = Math.min(this.duration, this.pointTime(right) + step);
    const ticks = [];
    for (let time = first; time <= last; time += step) {
      const tick = document.createElement('span');
      tick.style.left = `${(time * 100) / this.duration}%`;
      tick.textContent = tickText(time, step);
      ticks.push(tick);
    }
    ruler.replaceChildren(...ticks);
    pan.value = this.scrollRange
      ? (viewport.scrollLeft / this.scrollRange) * PAN_STEPS
      : 0;
  }

  bindDrag(target, begin) {
    let pointer = null;
    let action = null;
    let frame = null;
    let point = 0;
    const move = () => action.move(this.pointTime(point), point);
    const scroll = () => {
      frame = null;
      const viewport = this.nodes.viewport;
      const box = viewport.getBoundingClientRect();
      const left = point - box.left;
      const right = box.right - point;
      let delta = 0;
      if (left < SCROLL_EDGE) {
        delta = -Math.min(18, (SCROLL_EDGE - left) / 2);
      } else if (right < SCROLL_EDGE) {
        delta = Math.min(18, (SCROLL_EDGE - right) / 2);
      }
      const before = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (before === viewport.scrollLeft) return;
      move();
      frame = requestAnimationFrame(scroll);
    };
    const stopScroll = () => {
      if (frame !== null) globalThis.cancelAnimationFrame(frame);
      frame = null;
    };
    const finish = (event, commit) => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      stopScroll();
      action.end?.(this.pointTime(event.clientX), commit, event.clientX);
      action = null;
    };
    const options = { signal: this.signal };
    target.addEventListener(
      'pointerdown',
      (event) => {
        if (
          pointer !== null ||
          event.button !== 0 ||
          target.closest('fieldset:disabled')
        ) {
          return;
        }
        action = begin(this.pointTime(event.clientX), event);
        if (!action) return;
        event.preventDefault();
        pointer = event.pointerId;
        target.setPointerCapture(pointer);
      },
      options,
    );
    target.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerId !== pointer) return;
        point = event.clientX;
        move();
        if (frame === null) frame = requestAnimationFrame(scroll);
      },
      options,
    );
    target.addEventListener(
      'pointerup',
      (event) => finish(event, true),
      options,
    );
    target.addEventListener(
      'lostpointercapture',
      (event) => {
        finish(event, false);
      },
      options,
    );
    this.signal.addEventListener('abort', stopScroll, { once: true });
  }
}

export { RecordingTimeline };
