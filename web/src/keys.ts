import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * True while an input method (pinyin, kana, Hangul) is composing, when Enter picks a candidate and Escape
 * cancels it. WebKit (Safari, the macOS app) fires compositionend before that keydown, so isComposing is
 * already false there; keyCode 229 still marks it.
 */
export const composing = (e: KeyboardEvent): boolean => e.isComposing || e.keyCode === 229;

/** onKeyDown for fields that submit on Enter. Shift+Enter and Enter that confirms an IME candidate are left alone. */
export const onEnter = (submit: (e: ReactKeyboardEvent) => void) => (e: ReactKeyboardEvent) => {
  if (e.key !== 'Enter' || e.shiftKey || composing(e.nativeEvent)) return;
  e.preventDefault();
  submit(e);
};
