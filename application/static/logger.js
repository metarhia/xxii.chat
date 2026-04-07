class Logger {
  #output;

  constructor(outputId) {
    this.#output = document.getElementById(outputId);
  }

  log(...args) {
    if (!this.#output) return;
    const lines = args.map(Logger.#serialize);
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${lines.join(' ')}\n`;
    this.#output.textContent += logEntry;
    this.#output.scrollTop = this.#output.scrollHeight;
  }

  clear() {
    if (this.#output) this.#output.textContent = '';
  }

  static #serialize(x) {
    return typeof x === 'object' ? JSON.stringify(x, null, 2) : String(x);
  }
}

export { Logger };
