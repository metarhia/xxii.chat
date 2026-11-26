import { MediaCapture } from './media.js';

const PERCENT = 100;

class DevicePreview {
  #media = null;
  #track = null;

  constructor({ meter, video, noise, report }) {
    this.meter = meter;
    this.bar = meter.querySelector('.level-bar');
    this.video = video;
    this.noise = noise;
    this.report = report;
  }

  get isOn() {
    return this.#media !== null;
  }

  start() {
    if (this.#media) return;
    const media = new MediaCapture();
    this.#media = media;
    media.noise = this.noise();
    media.onLevel = (level) => this.paintLevel(level);
    media.onChange = () => this.paintVideo();
    this.#open(media).catch((error) => this.report(error.message));
  }

  async #open(media) {
    await media.start();
    if (this.#media !== media) return;
    media.micOn = true;
    media.cameraOn = true;
    await media.openMic();
    if (this.#media !== media) return;
    await media.openCamera();
    if (this.#media === media) this.paintVideo();
  }

  stop() {
    const media = this.#media;
    if (!media) return;
    this.#media = null;
    media.stop();
    this.#track = null;
    this.video.srcObject = null;
    this.paintLevel(0);
  }

  restart() {
    if (!this.#media) return;
    this.stop();
    this.start();
  }

  mirror(isOn) {
    this.video.classList.toggle('mirrored', isOn);
  }

  paintLevel(level) {
    const percent = Math.round(level * PERCENT);
    this.bar.style.width = `${percent}%`;
    this.meter.setAttribute('aria-valuenow', String(percent));
  }

  paintVideo() {
    const media = this.#media;
    const track = media?.cameraOn ? media.cameraTrack : null;
    const live = track?.readyState === 'live' ? track : null;
    if (live === this.#track) return;
    this.#track = live;
    this.video.srcObject = live ? new MediaStream([live]) : null;
    if (live) this.video.play().catch(() => undefined);
  }
}

export { DevicePreview };
