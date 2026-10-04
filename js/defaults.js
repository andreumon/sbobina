// Valori iniziali delle impostazioni (modificabili dall'app).
export const DEFAULTS = {
  apiKey: '',
  transcribeModel: 'gemini-3.5-transcribe',
  reviseModel: 'gemini-3.8-flash',
  language: 'it-IT',      // (vecchia impostazione, sostituita da defaultLang e dalla lingua del corso)
  defaultLang: 'it',      // lingua delle lezioni senza corso: it, en, en+it, it+en, auto
  chunkMin: 45,
  revise: true,
  relisten: true,
  courses: [],
  updatedAt: 0,
};
