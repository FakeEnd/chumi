/** Only the two Codex destinations used by Chumi can leave the embedded page. */
function isCodexNewLink(value) {
  if (typeof value !== 'string' || !value.startsWith('codex://new?') || /[\u0000-\u001f\u007f#]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'codex:' || url.hostname !== 'new' || url.pathname || url.username || url.password || url.port) return false;
    const entries = [...url.searchParams];
    return entries.length === 2 && new Set(entries.map(([key]) => key)).size === 2
      && entries.every(([key, text]) => (key === 'path' || key === 'prompt') && text.trim().length > 0);
  } catch { return false; }
}

function isCodexThreadLink(value) {
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value)
    && /^codex:\/\/threads\/[A-Za-z0-9_-]+$/.test(value);
}

function isWebLink(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { return !!new URL(value).hostname; } catch { return false; }
}

/** The backend uses this only for authentication and opening a prefilled Codex composer. */
function isDesktopRequestUrl(value) {
  return isWebLink(value) || isCodexNewLink(value);
}

/** Existing mail links and saved Codex chat links are also supported when clicked in the UI. */
function isExternalNavigationUrl(value) {
  return isDesktopRequestUrl(value) || isCodexThreadLink(value)
    || (typeof value === 'string' && /^mailto:/i.test(value) && !/[\u0000-\u001f\u007f]/.test(value));
}

module.exports = { isCodexNewLink, isCodexThreadLink, isDesktopRequestUrl, isExternalNavigationUrl };
