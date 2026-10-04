// Configurazione del sito. Dopo aver creato il client OAuth su Google Cloud
// (vedi README, passo 3), incolla qui il suo "ID client": così telefono e PC
// lo trovano già impostato. In alternativa si può inserire dalle Impostazioni.
export const DRIVE_CLIENT_ID = '313761493052-mgohb77p74uqii0kjob4v6qe46bt79ln.apps.googleusercontent.com';

// Valori iniziali delle impostazioni (modificabili dall'app).
export const DEFAULTS = {
  apiKey: '',
  transcribeModel: 'gemini-3.5-transcribe',
  reviseModel: 'gemini-3.8-flash',
  language: 'it-IT',
  chunkMin: 20,
  revise: true,
  relisten: true,
  courses: [],
  updatedAt: 0,
};
