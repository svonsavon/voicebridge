const BRACKETED = /([\[(])([^\]\)]+)([\]\)])/g;

const NON_SPEECH_PATTERNS = [
  /^(?:mouse\s+)?click(?:ing|s)?$/i,
  /^keyboard(?:\s+(?:clicking|clacking|typing|tapping))?$/i,
  /^(?:keyboard\s+)?typ(?:e|ing)$/i,
  /^(?:keyboard\s+)?(?:clack|clacking|tap|tapping)$/i,
  /^scissors?\s+(?:snipping|cutting)$/i,
  /^(?:laughter|laughing|laughs?)$/i,
  /^(?:applause|clapping)$/i,
  /^(?:cough|coughing|coughs)$/i,
  /^(?:sigh|sighing|sighs)$/i,
  /^(?:sniff|sniffing|sniffs)$/i,
  /^(?:breathing|heavy breathing)$/i,
  /^(?:clears? throat|throat clearing)$/i,
  /^(?:footsteps?|steps?)$/i,
  /^(?:knock|knocking|knocks)$/i,
  /^(?:door (?:opens?|closes?|slams?))$/i,
  /^(?:ringing|phone ringing|bell ringing)$/i,
  /^(?:beep|beeping|beeps|tone)$/i,
  /^(?:static|buzzing|humming)$/i,
  /^(?:background noise|ambient noise|room noise|noise)$/i,
  /^(?:music|musical interlude)$/i,
  /^(?:silence|blank audio|blank_audio)$/i,
];

function normalizeCaption(text) {
  return String(text || '')
    .trim()
    .replace(/[.!?…]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function isNonSpeechCaption(text) {
  const normalized = normalizeCaption(text);
  if (!normalized) return true;
  return NON_SPEECH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function cleanTranscript(input) {
  const original = String(input || '').trim();
  if (!original) return { text: '', removed: [], dropped: true };

  const removed = [];
  let cleaned = original.replace(BRACKETED, (whole, open, inner) => {
    if (!isNonSpeechCaption(inner)) return whole;
    removed.push(inner.trim());
    return ' ';
  });

  cleaned = cleaned
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([,;:])\s*([,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Whisper sometimes emits sound captions without brackets. Only drop them
  // when the entire transcript is a known non-speech caption.
  if (isNonSpeechCaption(cleaned)) {
    if (cleaned) removed.push(cleaned);
    return { text: '', removed, dropped: true };
  }

  return {
    text: cleaned,
    removed,
    dropped: !cleaned,
  };
}

module.exports = { cleanTranscript, isNonSpeechCaption };
