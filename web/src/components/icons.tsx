// Small inline icons (stroke = currentColor) so the UI needs no icon font or extra requests.
import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...p });

export const IconMic = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
export const IconMonitor = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
export const IconBoth = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="2" y="5" width="13" height="9" rx="1.5" /><path d="M6 18h5M8.5 14v4" /><rect x="17" y="6" width="4" height="8" rx="2" /><path d="M15.5 12a3.5 3.5 0 0 0 7 0M19 15.5V18" /></svg>;
export const IconBolt = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>;
export const IconUser = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
export const IconClock = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
export const IconGear = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
export const IconSpark = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 3c0 5 2 7 7 7-5 0-7 2-7 7 0-5-2-7-7-7 5 0 7-2 7-7z" /></svg>;
export const IconWindow = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></svg>;
export const IconText = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 6h16M4 12h10M4 18h13" /></svg>;
export const IconShield = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" /><path d="m9 12 2 2 4-4" /></svg>;
export const IconArrow = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
export const IconGlobe = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" /></svg>;
export const IconWave = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" /></svg>;
export const IconBulb = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" /></svg>;
export const IconFolder = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
export const IconTerminal = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M12 15h5" /></svg>;
export const IconPlay = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M7 4.5v15l12-7.5z" fill="currentColor" /></svg>;
export const IconPause = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M8 5v14M16 5v14" strokeWidth={3} /></svg>;
export const IconPet = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><ellipse cx="8.4" cy="6.2" rx="2.1" ry="3.6" transform="rotate(-14 8.4 6.2)" /><ellipse cx="15.6" cy="6.2" rx="2.1" ry="3.6" transform="rotate(14 15.6 6.2)" /><path d="M12 8.5c4 0 6.5 2.6 6.5 6s-2.6 5.5-6.5 5.5-6.5-2.1-6.5-5.5 2.5-6 6.5-6z" /><path d="M9.8 14.2h.01M14.2 14.2h.01" strokeWidth={2.6} /></svg>;
export const IconLink = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>;
export const IconCompact = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" /></svg>;
export const IconExpand = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>;
