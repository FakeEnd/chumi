// The mascot plus its speech bubble, laid out in a box `size` px wide for the character. Like the rig, the bubble's
// pop-in and fade-out are functions of the time passed to draw(t), so the promo video can reuse this view.

import { PetRig } from './rig.ts';

export interface Say { text: string; action?: string; tone?: 'info' | 'warn' }

const CSS = `
.chumi-pet-view { position: relative; }
.chumi-pet-view svg.chumi-pet { position: absolute; left: 50%; bottom: 0; width: calc(var(--u) * 150); height: calc(var(--u) * 150); transform: translateX(-50%); overflow: visible; }
.chumi-bubble { position: absolute; left: 50%; bottom: calc(var(--u) * 132); width: max-content; max-width: calc(var(--u) * 216); transform-origin: 50% 100%;
  padding: calc(var(--u) * 6.5) calc(var(--u) * 12) calc(var(--u) * 7.5); border: calc(var(--u) * 2.4) solid #2E2A78; border-radius: calc(var(--u) * 16);
  background: #fff; color: #2E2A78; text-align: center; box-shadow: 0 calc(var(--u) * 3.5) 0 rgba(46, 42, 120, .16);
  font: 750 calc(var(--u) * 13.5) / 1.32 ui-rounded, "SF Pro Rounded", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif; letter-spacing: .1px;
  pointer-events: auto; cursor: default; user-select: none; -webkit-user-select: none; }
.chumi-bubble::after { content: ""; position: absolute; left: 50%; bottom: calc(var(--u) * -7.4); width: calc(var(--u) * 11); height: calc(var(--u) * 11);
  background: #fff; border: solid #2E2A78; border-width: 0 calc(var(--u) * 2.4) calc(var(--u) * 2.4) 0; transform: translateX(-50%) rotate(45deg); border-bottom-right-radius: calc(var(--u) * 3); }
.chumi-bubble .act { display: block; margin-top: calc(var(--u) * 2); font-size: .86em; font-weight: 800; color: #4F46E5; }
.chumi-bubble.warn { border-color: #9A3412; color: #7C2D12; background: #FFF7ED; }
.chumi-bubble.warn::after { border-color: #9A3412; background: #FFF7ED; }
.chumi-bubble.warn .act { color: #C2410C; }
`;

let styled = false;

export class PetView {
  readonly el: HTMLDivElement;
  readonly rig = new PetRig();
  private bubbleEl: HTMLDivElement;
  private shown: (Say & { at: number }) | null = null;
  private hideAt = -1;

  constructor(size = 150) {
    if (!styled) { const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); styled = true; }
    this.el = document.createElement('div');
    this.el.className = 'chumi-pet-view';
    this.el.style.setProperty('--u', `${size / 150}px`);
    this.el.appendChild(this.rig.el);
    this.bubbleEl = document.createElement('div');
    this.bubbleEl.className = 'chumi-bubble';
    this.bubbleEl.style.opacity = '0';
    this.el.appendChild(this.bubbleEl);
  }

  get bubble(): HTMLDivElement { return this.bubbleEl; }
  /** What the visible bubble says, or null once it is hidden or hiding. */
  get saying(): Say | null { return this.hideAt < 0 ? this.shown : null; }

  say(s: Say, t: number): void {
    this.shown = { ...s, at: t }; this.hideAt = -1;
    this.bubbleEl.className = `chumi-bubble${s.tone === 'warn' ? ' warn' : ''}`;
    this.bubbleEl.textContent = s.text;
    if (s.action) { const a = document.createElement('span'); a.className = 'act'; a.textContent = s.action; this.bubbleEl.appendChild(a); }
  }

  hush(t: number): void { if (this.shown && this.hideAt < 0) this.hideAt = t; }

  draw(t: number): void {
    this.rig.draw(t);
    let scale = 0, alpha = 0;
    if (this.shown) {
      const u = t - this.shown.at;
      if (u >= 0) { scale = 1 - Math.exp(-9 * u) * Math.cos(13 * u); alpha = Math.min(1, u * 10); }
      if (this.hideAt >= 0) {
        const v = Math.min(1, (t - this.hideAt) / 0.16);
        scale *= 1 - v * 0.6; alpha *= 1 - v;
        if (v >= 1) this.shown = null;
      }
    }
    const bob = 1.5 * Math.sin(t * 2.3);
    this.bubbleEl.style.opacity = alpha.toFixed(3);
    this.bubbleEl.style.visibility = alpha > 0.01 ? 'visible' : 'hidden';
    this.bubbleEl.style.transform = `translateX(-50%) translateY(${bob.toFixed(2)}px) scale(${Math.max(0, scale).toFixed(3)})`;
  }
}
