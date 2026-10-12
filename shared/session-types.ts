/** The built-in prompt and summary templates a session type can use. */
export const SESSION_STYLES = ['lab_meeting', 'advisor', 'lecture', 'wip', 'other'] as const;
export type SessionStyle = typeof SESSION_STYLES[number];

export interface SessionTypeOption {
  id: string;
  name: string;
  /** Which built-in template the AI uses. Defaults to the id for built-in types and to 'other' for added ones. */
  style?: SessionStyle;
  /** Removed choices keep their names so existing meetings remain readable. */
  archived?: boolean;
}

export const DEFAULT_SESSION_TYPES: SessionTypeOption[] = [
  { id: 'lab_meeting', name: 'Lab meeting' },
  { id: 'advisor', name: 'Advisor 1:1' },
  { id: 'lecture', name: 'Lecture' },
  { id: 'wip', name: 'WIP / seminar' },
  { id: 'other', name: 'Other' },
];

const isStyle = (v: unknown): v is SessionStyle => (SESSION_STYLES as readonly unknown[]).includes(v);
export const MAX_ACTIVE_SESSION_TYPES = 50;

export function validateSessionTypes(value: unknown, previous: SessionTypeOption[] = DEFAULT_SESSION_TYPES): SessionTypeOption[] {
  // Archived entries accumulate as types are removed, so only active ones count toward the limit.
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid session types.');
  const ids = new Set<string>();
  const names = new Set<string>();
  const options = value.map((raw): SessionTypeOption => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(raw.id) || ids.has(raw.id)) throw new Error('Invalid or duplicate session type ID.');
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(raw.name)) throw new Error('Session type names must contain 1–60 characters.');
    if (raw.archived !== undefined && typeof raw.archived !== 'boolean') throw new Error('Invalid session type status.');
    if (raw.style !== undefined && !isStyle(raw.style)) throw new Error('Invalid session type style.');
    const name = raw.name.trim();
    if (!raw.archived && names.has(name.toLowerCase())) throw new Error('Session type names must be unique.');
    ids.add(raw.id);
    if (!raw.archived) names.add(name.toLowerCase());
    return { id: raw.id, name, ...(raw.style && raw.style !== defaultStyle(raw.id) ? { style: raw.style } : {}), ...(raw.archived ? { archived: true } : {}) };
  });
  const active = options.filter((o) => !o.archived).length;
  if (!active) throw new Error('Keep at least one session type.');
  if (active > MAX_ACTIVE_SESSION_TYPES) throw new Error('Use at most 50 session types.');
  return [...options, ...previous.filter((o) => !ids.has(o.id)).map((o) => ({ ...o, archived: true }))];
}

export function availableSessionTypes(options: SessionTypeOption[], current?: string): SessionTypeOption[] {
  const visible = options.filter((o) => !o.archived || o.id === current);
  return current && !visible.some((o) => o.id === current) ? [...visible, { id: current, name: current, archived: true }] : visible;
}

function defaultStyle(id: string): SessionStyle { return isStyle(id) ? id : 'other'; }

/** The template a meeting of this type uses: the type's chosen style, else the built-in one with the same id. */
export function sessionStyle(options: SessionTypeOption[], id: string | null | undefined): SessionStyle {
  const option = options.find((o) => o.id === id);
  return option?.style ?? defaultStyle(id ?? 'other');
}

/** The user's name for a type (built-in types keep their English default name). */
export function sessionTypeName(options: SessionTypeOption[], id: string | null | undefined): string {
  return options.find((o) => o.id === id)?.name ?? id ?? '';
}
