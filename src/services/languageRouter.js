const LANGUAGE_NAMES = {
  auto: 'Auto',
  en: 'English',
  zh: 'Chinese',
  ja: 'Japanese'
};

function normalizeLanguage(value, fallback = 'auto') {
  const key = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, key) ? key : fallback;
}

function whisperLanguage(inputLanguage) {
  const language = normalizeLanguage(inputLanguage, 'auto');
  return language === 'auto' ? 'auto' : language;
}

function outputLanguageName(outputLanguage, inputLanguage = 'auto') {
  const output = String(outputLanguage || 'same').toLowerCase();
  if (output === 'same') {
    const input = normalizeLanguage(inputLanguage, 'auto');
    return input === 'auto' ? 'Auto' : LANGUAGE_NAMES[input];
  }
  const normalized = normalizeLanguage(output, 'en');
  return LANGUAGE_NAMES[normalized];
}

function shouldTranslate(inputLanguage, outputLanguage) {
  const input = normalizeLanguage(inputLanguage, 'auto');
  const output = String(outputLanguage || 'same').toLowerCase();
  if (output === 'same') return false;
  const normalizedOutput = normalizeLanguage(output, 'en');
  if (input === 'auto') return true;
  return input !== normalizedOutput;
}

function translationRequest(text, inputLanguage, outputLanguage) {
  const input = normalizeLanguage(inputLanguage, 'auto');
  const output = normalizeLanguage(outputLanguage, 'en');
  return {
    text,
    source: input === 'auto' ? 'Auto' : LANGUAGE_NAMES[input],
    target: LANGUAGE_NAMES[output]
  };
}

module.exports = {
  LANGUAGE_NAMES,
  normalizeLanguage,
  whisperLanguage,
  outputLanguageName,
  shouldTranslate,
  translationRequest
};
