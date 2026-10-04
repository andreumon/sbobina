// Istruzioni inviate ai modelli. Sono qui separate per poterle ritoccare facilmente.
import { fmtMMSS } from './text.js';

/** Lingue delle lezioni: codici per il modello di trascrizione e descrizione per i prompt. */
export const LANGS = {
  it: { label: 'Italiano', codes: ['it-IT'], prompt: 'in italiano' },
  en: { label: 'English', codes: ['en-US'], prompt: 'in inglese' },
  'en+it': { label: 'Inglese, con parti in italiano', codes: ['en-US', 'it-IT'], prompt: 'in inglese, con alcune parti in italiano' },
  'it+en': { label: 'Italiano, con parti in inglese', codes: ['it-IT', 'en-US'], prompt: 'in italiano, con alcune parti in inglese' },
  auto: { label: 'Riconosci da solo', codes: [], prompt: null },
};
export const langOf = key => LANGS[key] || LANGS.it;

const languageRule = lang => (lang.prompt
  ? `La lezione è ${lang.prompt}. NON tradurre mai: ogni frase va scritta nella lingua in cui è pronunciata, anche quando il docente passa da una lingua all'altra.`
  : 'NON tradurre mai: ogni frase va scritta nella lingua in cui è pronunciata, anche quando chi parla passa da una lingua all\'altra.');

/** Trascrizione con un modello multimodale (ripiego, o file non tagliabili). */
export function transcriptionPrompt({ course, glossary, range, lang = LANGS.it }) {
  return [
    `Trascrivi parola per parola tutto il parlato di questa registrazione di una lezione universitaria${course ? ` del corso "${course}"` : ''}${range ? `, SOLO nel tratto da ${fmtMMSS(range[0])} a ${fmtMMSS(range[1])}` : ''}.`,
    languageRule(lang),
    '',
    'Regole:',
    '- Trascrizione letterale e COMPLETA dall\'inizio alla fine dell\'audio: non riassumere, non saltare frasi (anche annunci, istruzioni pratiche, link, domande degli studenti), non aggiungere nulla.',
    '- Punteggiatura essenziale; vai a capo quando cambia argomento.',
    '- Niente titoli, timestamp, commenti o premesse.',
    '- Un passaggio incomprensibile si scrive [incomprensibile].',
    glossary ? `- Termini tecnici che possono comparire: ${glossary}.` : '',
    range ? '- Se una frase è tagliata a inizio o fine tratto, trascrivi solo la parte che cade nel tratto.' : '',
    '',
    'Rispondi solo con la trascrizione.',
  ].filter(l => l !== '').join('\n');
}

/** Revisione: punteggiatura, paragrafi, correzioni dal contesto, timestamp per paragrafo. */
export function revisionPrompt({ raw, course, glossary, index, total, start, end, prevTail, withAudio, range, lang = LANGS.it }) {
  const lenLabel = fmtMMSS(end - start);
  const lines = [
    `Sei un revisore di trascrizioni di lezioni universitarie${course ? ` (corso: "${course}")` : ''}.`,
    withAudio
      ? (range
        ? `Ricevi la registrazione completa della lezione e la trascrizione automatica grezza del segmento ${index + 1} di ${total}, che va da ${fmtMMSS(range[0])} a ${fmtMMSS(range[1])} della registrazione.`
        : `Ricevi l'audio del segmento ${index + 1} di ${total} della lezione (dura ${lenLabel}) e la sua trascrizione automatica grezza.`)
      : `Ricevi la trascrizione automatica grezza del segmento ${index + 1} di ${total} della lezione (dura ${lenLabel}).`,
    'Restituisci la trascrizione rivista rispettando RIGOROSAMENTE queste regole.',
    '',
    `0. ${languageRule(lang)}`,
    `1. Trascrizione LETTERALE e COMPLETA: non riassumere, non parafrasare, non riordinare, non aggiungere contenuti. Ogni frase pronunciata deve comparire, nello stesso ordine e con le parole di chi parla${withAudio ? ', dall\'inizio alla fine dell\'audio' : ''}. Non saltare nessun passaggio: anche annunci, istruzioni pratiche, link, indirizzi e domande degli studenti vanno trascritti.`,
    '2. Aggiungi la punteggiatura e dividi in paragrafi di senso compiuto (indicativamente 3-8 frasi), andando a capo quando cambia il passaggio del ragionamento. Separa i paragrafi con una riga vuota.',
    `3. Correggi gli errori di trascrizione (parole storpiate, omofoni, termini tecnici sbagliati) in base al contesto${withAudio ? ' e riascoltando l\'audio' : ''}. Recupera, se le senti, parole che la trascrizione grezza ha saltato.`,
    '4. Ogni volta che non sei sicuro di una parola o di una correzione, scrivi la tua ipotesi seguita da [?]. In una lezione lunga è normale che ce ne siano diversi: non evitarli. Scrivere [?] è sempre meglio che indovinare in silenzio.',
    '5. Se un passaggio resta incomprensibile, scrivi [incomprensibile].',
    '6. Elimina gli intercalari vuoti (ehm, eh, uhm, cioè di riempimento) e TUTTE le ripetizioni dovute a esitazione (per esempio "il il", "dovete dovete", "the the", "we we will"). Non correggere lo stile o la grammatica di chi parla: correggi solo gli errori della trascrizione.',
    '7. Se interviene uno studente, inizia quel paragrafo con "Studente:" e il paragrafo della risposta con "Docente:". Se un\'altra persona viene presentata per nome e parla, usa il suo nome.',
    '8. Formule e simboli matematici dettati a voce vanno in LaTeX: dentro la frase tra singoli dollari, per esempio $\\hat{\\beta}$; le formule lunghe su una riga a sé tra doppi dollari, per esempio $$\\hat{\\beta} = (X^T X)^{-1} X^T y$$.',
  ];
  if (withAudio) {
    lines.push(range
      ? `9. Inizia OGNI paragrafo con il tempo in cui comincia, tra parentesi quadre in formato [MM:SS], misurato dall'inizio della registrazione completa (quindi tra ${fmtMMSS(range[0])} e ${fmtMMSS(range[1])}). I tempi devono essere crescenti.`
      : `9. Inizia OGNI paragrafo con il tempo in cui comincia nell'audio di questo segmento, tra parentesi quadre in formato [MM:SS], misurato dall'inizio del segmento (quindi tra [00:00] e [${lenLabel}]; oltre l'ora i minuti continuano: [61:30]). I tempi devono essere crescenti.`);
  }
  if (glossary) lines.push('', `Termini tecnici del corso che possono comparire: ${glossary}.`);
  if (prevTail) {
    lines.push('', 'Il segmento precedente terminava così (NON ripeterlo, serve solo come contesto):', `«${prevTail}»`,
      'Se questo segmento inizia a metà frase, prosegui senza ripetere le parole già trascritte.');
  }
  lines.push('', 'Rispondi SOLO con il testo rivisto: niente titoli, commenti, premesse o blocchi di codice.',
    '', 'TRASCRIZIONE GREZZA:', '<<<', raw, '>>>');
  return lines.join('\n');
}

/** Prosecuzione di una trascrizione che si è interrotta (risposta troncata). */
export function continuationPrompt({ course, glossary, tail, lang = LANGS.it }) {
  return [
    `Questa è la registrazione di una lezione universitaria${course ? ` del corso "${course}"` : ''}.`,
    languageRule(lang),
    'Una trascrizione letterale si è interrotta. Le ultime parole trascritte sono:',
    `«${tail}»`,
    '',
    'Continua la trascrizione parola per parola dal punto immediatamente successivo a queste parole, fino alla fine dell\'audio.',
    'Non ripetere le parole già trascritte, non riassumere, non aggiungere commenti. Punteggiatura essenziale; a capo quando cambia argomento.',
    glossary ? `Termini tecnici che possono comparire: ${glossary}.` : '',
    'Rispondi solo con il seguito della trascrizione.',
  ].filter(Boolean).join('\n');
}
