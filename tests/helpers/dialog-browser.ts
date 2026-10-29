export function dialogBrowser() {
  const events: Record<string, (e: any) => void> = {};
  let active: any;
  const control = (name: string) => ({ name, tabIndex: 0, isConnected: true, closest: (_selector: string): any => null, contains(el: any) { return el === this; }, matches: () => false, getClientRects: () => [1], focus() { active = this; } });
  const first = control('first'), summary = control('summary'), last = control('last'), notice = control('notice'), opener = control('opener'), guide = control('closed-guide');
  const details = { querySelector: () => summary, parentElement: null };
  summary.closest = guide.closest = () => details;
  guide.focus = () => {}; // Chromium reports rects for this closed-details link but cannot focus it.
  active = opener;
  const root = { querySelectorAll: (selector: string) => [first, ...(selector.includes('summary') ? [summary] : []), last, guide], contains: (el: any) => [first, summary, last, guide].includes(el), focus: () => first.focus() };
  const doc = { get activeElement() { return active; }, querySelector: () => ({ querySelectorAll: () => [notice], contains: (el: any) => el === notice }),
    addEventListener: (name: string, fn: any) => { events[name] = fn; }, removeEventListener: (name: string) => { delete events[name]; } };
  return {
    adapters: { document: doc, window: { addEventListener: doc.addEventListener, removeEventListener: doc.removeEventListener }, mount: (tree: any) => { tree.children[0].props.ref.current = root; } },
    active: () => active.name,
    key: (key: string, options: any = {}) => {
      let prevented = false;
      events.keydown({ key, preventDefault: () => { prevented = true; }, ...options });
      if (key === 'Tab' && !prevented) {
        const nativeOrder = [opener, notice, first, summary, last], index = nativeOrder.indexOf(active);
        nativeOrder[(index + (options.shiftKey ? -1 : 1) + nativeOrder.length) % nativeOrder.length].focus();
      }
      return prevented;
    },
    focusOutside: () => { active = opener; events.focusin({ target: opener }); },
  };
}
