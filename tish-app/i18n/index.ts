import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from '../locales/en.json';
import zhHant from '../locales/zh-Hant.json';

export const SUPPORTED_LANGUAGES = ['en', 'zh-Hant'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  'zh-Hant': '繁體中文',
};

const LANGUAGE_STORAGE_KEY = 'user-language';

function isSupportedLanguage(value: string | null): value is SupportedLanguage {
  return value === 'en' || value === 'zh-Hant';
}

function detectDeviceLanguage(): SupportedLanguage {
  const languageCode = Localization.getLocales()[0]?.languageCode;
  return languageCode === 'zh' ? 'zh-Hant' : 'en';
}

export async function initI18n() {
  const stored = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
  const lng = isSupportedLanguage(stored) ? stored : detectDeviceLanguage();

  await i18next.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      'zh-Hant': { translation: zhHant },
    },
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
}

export async function changeLanguage(lang: SupportedLanguage) {
  await i18next.changeLanguage(lang);
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
}

export default i18next;
