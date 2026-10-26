// Windows host for the shared pet.html page. The page owns meeting controls and animation;
// this window owns placement, click-through, keyboard focus and screen-capture exclusion.
const { BrowserWindow, Menu, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

class PetPanel {
  constructor({ baseUrl, dataDir, onOpen, onEnabled }) {
    this.url = baseUrl + '/pet.html';
    this.file = path.join(dataDir, 'pet-window.json');
    this.onOpen = onOpen;
    this.onEnabled = onEnabled;
    this.enabled = true;
    this.zoom = 1;
    this.height = 300;
    this.petRects = [];
    this.uiRects = [];
    this.ignore = true;
    this.shareable = false;
    try { this.anchor = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* First launch. */ }
    if (!Number.isFinite(this.anchor?.x) || !Number.isFinite(this.anchor?.y)) this.anchor = this.corner();
    this.window = new BrowserWindow({
      title: 'Chumi pet', width: 380, height: 300, show: false,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, focusable: false,
      webPreferences: { preload: path.join(__dirname, 'pet-preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true, zoomMode: 'isolated' },
    });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setContentProtection(true);
    this.window.setAlwaysOnTop(true, 'floating');
    this.receive = (event, message) => {
      if (event.sender === this.window.webContents && event.senderFrame === event.sender.mainFrame
          && event.senderFrame.url === this.url) this.message(message);
    };
    ipcMain.on('chumi-pet', this.receive);
    this.displayChanged = () => this.place();
    screen.on('display-removed', this.displayChanged);
    screen.on('display-metrics-changed', this.displayChanged);
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, url) => { if (url !== this.url) event.preventDefault(); });
    this.window.webContents.on('render-process-gone', () => { this.suspend(); void this.load(); });
    this.window.on('close', (event) => { event.preventDefault(); this.call('setEnabled', false); });
    this.place();
  }

  load() {
    this.ready = false; this.room = undefined; this.pointer = undefined;
    return this.window.loadURL(this.url);
  }
  call(method, ...args) { this.window.webContents.send('chumi-pet-event', { method, args }); }
  toggle() { this.call('setEnabled', !this.enabled); }

  corner() {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - 380 * this.zoom - 8, y: area.y + Math.max(0, area.height - 470 * this.zoom) };
  }

  resetPosition() {
    this.anchor = this.corner();
    this.savePosition();
    this.place();
  }

  savePosition() { fs.writeFileSync(this.file, JSON.stringify(this.anchor)); }

  place() {
    const pet = { x: this.anchor.x + 190 * this.zoom, y: this.anchor.y + 150 * this.zoom };
    const display = screen.getAllDisplays().find(({ workArea: a }) => pet.x >= a.x && pet.x < a.x + a.width && pet.y >= a.y && pet.y < a.y + a.height);
    if (!display) this.anchor = this.corner();
    const area = (display || screen.getPrimaryDisplay()).workArea;
    const width = Math.round(380 * this.zoom), height = Math.min(area.height, Math.ceil(this.height * this.zoom));
    const x = Math.round(Math.max(area.x - 60, Math.min(this.anchor.x, area.x + area.width - width + 60)));
    const y = Math.round(Math.max(area.y, Math.min(this.anchor.y, area.y + area.height - height)));
    this.window.setBounds({ x, y, width, height });
    if (this.ready) {
      const room = Math.floor((area.y + area.height - this.anchor.y) / this.zoom);
      if (room !== this.room) { this.room = room; this.call('room', room); }
    }
  }

  message(message) {
    switch (message?.type) {
      case 'layout': {
        this.petRects = message.pet;
        this.uiRects = message.ui;
        if (Number.isFinite(message.zoom) && message.zoom >= 0.5 && message.zoom <= 2 && message.zoom !== this.zoom) {
          this.zoom = message.zoom;
          this.window.webContents.setZoomFactor(this.zoom);
        }
        if (Number.isFinite(message.height) && message.height > 50) this.height = Math.min(message.height, 1400);
        if (message.shareable !== this.shareable) {
          this.shareable = message.shareable;
          this.window.setContentProtection(!this.shareable);
        }
        this.ready = true;
        if (this.enabled !== message.enabled) { this.enabled = message.enabled; this.onEnabled(this.enabled); }
        if (!this.down?.moved) this.place();
        if (this.enabled) {
          if (!this.window.isVisible()) this.window.showInactive();
          if (!this.timer) this.timer = setInterval(() => this.tick(), 1000 / 30);
        } else this.suspend();
        break;
      }
      case 'open': this.onOpen(message); break;
      case 'keyboard': this.keyboard(message.on); break;
      case 'drag': this.drag(message.phase); break;
      case 'menu': void this.menu(); break;
    }
  }

  keyboard(on) {
    this.window.setFocusable(on);
    if (on) this.window.focus();
    else if (this.window.isFocused()) this.window.blur();
  }

  point(cursor) {
    const bounds = this.window.getBounds();
    return { x: (cursor.x - bounds.x) / this.zoom, y: (cursor.y - bounds.y) / this.zoom };
  }

  tick() {
    const p = this.point(screen.getCursorScreenPoint());
    if (!this.down) {
      const over = [...this.petRects, ...this.uiRects].some(([x, y, w, h]) => p.x >= x && p.x < x + w && p.y >= y && p.y < y + h);
      if (this.ignore === over) {
        this.ignore = !over;
        this.window.setIgnoreMouseEvents(this.ignore, { forward: true });
      }
    }
    if (p.x !== this.pointer?.x || p.y !== this.pointer?.y) { this.pointer = p; this.call('pointer', p.x, p.y); }
  }

  drag(phase) {
    const cursor = screen.getCursorScreenPoint();
    if (phase === 'start') {
      this.down = { cursor, bounds: this.window.getBounds(), moved: false, x: cursor.x, at: Date.now() };
    } else if (this.down) {
      const down = this.down;
      if (phase === 'move') {
        const dx = cursor.x - down.cursor.x, dy = cursor.y - down.cursor.y;
        if (!down.moved && Math.hypot(dx, dy) < 4) return;
        if (!down.moved) { down.moved = true; this.call('drag', 'start'); }
        this.window.setPosition(down.bounds.x + dx, down.bounds.y + dy);
        const now = Date.now(), vx = (cursor.x - down.x) * 1000 / Math.max(1, now - down.at);
        down.x = cursor.x; down.at = now;
        this.call('drag', 'move', vx);
      } else if (phase === 'end') {
        this.down = null;
        if (down.moved) {
          const { x, y } = this.window.getBounds();
          this.anchor = { x, y };
          this.place();
          this.savePosition();
          this.call('drag', 'end');
        }
      }
    }
  }

  async menu() {
    const items = JSON.parse(await this.window.webContents.executeJavaScript('window.chumiPet.menu()'));
    Menu.buildFromTemplate(items.map(({ id, label, enabled }) => id === '-' ? { type: 'separator' }
      : { label, enabled, click: () => this.call('run', id) })).popup({ window: this.window });
  }

  suspend() {
    clearInterval(this.timer); this.timer = null;
    this.down = null;
    this.keyboard(false);
    this.window.hide();
  }

  destroy() {
    clearInterval(this.timer);
    ipcMain.removeListener('chumi-pet', this.receive);
    screen.removeListener('display-removed', this.displayChanged);
    screen.removeListener('display-metrics-changed', this.displayChanged);
    this.window.destroy();
  }
}

module.exports = { PetPanel };
