const { BrowserWindow, desktopCapturer } = require('electron');
const path = require('node:path');

// A private renderer keeps a low-rate stream of only the selected window.
class ScreenCapture {
  failures = 0;
  retryAt = 0;
  enqueue(task) {
    this.pending = (this.pending || Promise.resolve()).catch(() => {}).then(task);
    return this.pending;
  }
  capture(id, force = false) { return this.enqueue(() => this.take(id, force)); }
  async take(id, force) {
    if (this.closed) return { error: 'capture_stopped' };
    if (this.id !== id) { this.reset(); this.id = id; }
    if (Date.now() < this.retryAt) return { error: 'capture_backoff' };
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      if (this.closed) return { error: 'capture_stopped' };
      const source = sources.find((s) => Number(s.id.split(':')[1]) === id);
      if (!source) { this.reset(); return { error: 'window_not_found' }; }
      if (!this.window) {
        const file = path.join(__dirname, 'screen-capture.html');
        this.window = new BrowserWindow({ show: false, skipTaskbar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, partition: 'chumi-screen-capture' } });
        this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        this.window.webContents.on('will-navigate', (event) => event.preventDefault());
        this.window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
          callback(this.window && request.frame === this.window.webContents.mainFrame && request.videoRequested && !request.audioRequested ? { video: source } : {});
        });
        await this.window.loadFile(file);
      }
      const window = this.window;
      let timer;
      try {
        const result = await Promise.race([
          window.webContents.executeJavaScript(`window.chumiCapture.capture(${Boolean(force)})`, true),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Window capture timed out.')), 15000); }),
        ]);
        this.failures = 0; this.retryAt = 0;
        return { title: source.name, ...result };
      } finally { clearTimeout(timer); }
    } catch (error) {
      this.releaseWindow();
      if (this.closed) return { error: 'capture_stopped' };
      this.failures++;
      this.retryAt = Date.now() + Math.min(3000 * 2 ** Math.min(this.failures - 1, 4), 30000);
      return { error: 'capture_failed', message: error.message, failures: this.failures };
    }
  }
  stop(id) { return this.enqueue(() => { if (this.id === id) this.reset(); }); }
  releaseWindow() { const window = this.window; this.window = null; window?.destroy(); }
  reset() { this.releaseWindow(); this.id = null; this.failures = 0; this.retryAt = 0; }
  destroy() { this.closed = true; this.reset(); }
}
module.exports = { ScreenCapture };
