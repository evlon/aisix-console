import { createI18n } from 'vue-i18n';
import zhCN from './locales/zh-CN.js';
import en from './locales/en.js';

const saved = localStorage.getItem('aisix_console_lang');

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: saved === 'en' ? 'en' : 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN, en },
});

export function setLanguage(locale) {
  i18n.global.locale.value = locale;
  localStorage.setItem('aisix_console_lang', locale);
}
