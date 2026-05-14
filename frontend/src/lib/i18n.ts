import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'pt-BR',
    supportedLngs: ['pt-BR', 'en', 'es', 'pl', 'de'],
    defaultNS: 'common',
    ns: ['common', 'app-builder', 'flow-builder', 'backend', 'content'],

    backend: {
      loadPath: '/locales/{{lng}}/{{ns}}.json',
    },

    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
      convertDetectedLanguage: (lng: string) => {
        if (!lng) return 'pt-BR';
        if (lng === 'pt' || lng.startsWith('pt-')) return 'pt-BR';
        if (lng === 'en' || lng.startsWith('en-')) return 'en';
        if (lng === 'es' || lng.startsWith('es-')) return 'es';
        if (lng === 'pl' || lng.startsWith('pl-')) return 'pl';
        if (lng === 'de' || lng.startsWith('de-')) return 'de';
        return lng;
      },
    },

    interpolation: {
      escapeValue: false,
    },

    react: {
      useSuspense: true,
    },
  });

export default i18n;
