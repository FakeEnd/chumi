import { preferredLanguage } from './platform.ts';
import { NATIVE_ZH } from '../shared/native-messages.ts';
import { translateMessage, type MessageVars } from '../shared/messages.ts';

let system: 'en' | 'zh' | undefined;
const EN = {};
export function systemLanguage(): 'en' | 'zh' {
  return system ??= (preferredLanguage() || process.env.LANG || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
export const uiLanguage = (preference: string): 'en' | 'zh' => preference === 'en' || preference === 'zh' ? preference : systemLanguage();
export const localize = (preference: string, key: string, vars?: MessageVars): string => translateMessage(key, uiLanguage(preference) === 'zh' ? NATIVE_ZH : EN, vars);
export function sessionTitle(preference: string, quick = false, date = new Date()): string {
  const when = date.toLocaleString(uiLanguage(preference) === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return localize(preference, quick ? 'Quick session · {date}' : 'Session · {date}', { date: when });
}
