/** Draw only when needed. A frame returns seconds until the next draw, or Infinity to stop. */
export class PetLoop {
  private frame = 0;
  private timer = 0;
  private nextAt = 0;

  constructor(private draw: (t: number) => number) {}

  private tick = (): void => {
    const t = performance.now() / 1000;
    if (t + 0.001 >= this.nextAt) {
      // Keep the frame registered while drawing so a reaction's wake call coalesces with it.
      const delay = this.draw(t);
      this.frame = 0;
      this.nextAt = t + delay;
      if (!Number.isFinite(delay)) return;
      // Only still poses use timers for deadlines. Animations stay on the display's frame clock.
      if (delay > 0.1) {
        this.timer = window.setTimeout(() => { this.timer = 0; this.wake(); }, delay * 1000);
        return;
      }
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  wake(): void {
    if (this.frame) return;
    clearTimeout(this.timer); this.timer = 0;
    this.nextAt = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame); clearTimeout(this.timer);
    this.frame = 0; this.timer = 0;
  }
}
