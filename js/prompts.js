// Istruzioni inviate ai modelli. Sono qui separate per poterle ritoccare facilmente.
import { fmtMMSS } from './text.js';

/** Trascrizione con un modello multimodale (ripiego, o file non tagliabili). */
export function transcriptionPrompt({ course, glossary, range }) {
  return [
    `Trascrivi parola per parola, in italiano, tutto il parlato di questa registrazione di una lezione universitaria${course ? ` del corso "${course}"` : ''}${range ? `, SOLO nel tratto da ${fmtMMSS(range[0])} a ${fmtMMSS(range[1])}` : ''}.`,
    '',
    'Regole:',
    '- Trascrizione letterale e completa: non riassumere, non saltare frasi, non aggiungere nulla.',
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
export function revisionPrompt({ raw, course, glossary, index, total, start, end, prevTail, withAudio, range }) {
  const lenLabel = fmtMMSS(end - start);
  const lines = [
    `Sei un revisore di trascrizioni di lezioni universitarie in italiano${course ? ` (corso: "${course}")` : ''}.`,
    withAudio
      ? (range
        ? `Ricevi la registrazione completa della lezione e la trascrizione automatica grezza del segmento ${index + 1} di ${total}, che va da ${fmtMMSS(range[0])} a ${fmtMMSS(range[1])} della registrazione.`
        : `Ricevi l'audio del segmento ${index + 1} di ${total} della lezione (dura ${lenLabel}) e la sua trascrizione automatica grezza.`)
      : `Ricevi la trascrizione automatica grezza del segmento ${index + 1} di ${total} della lezione (dura ${lenLabel}).`,
    'Restituisci la trascrizione rivista rispettando RIGOROSAMENTE queste regole.',
    '',
    '1. Trascrizione LETTERALE: non riassumere, non parafrasare, non riordinare, non aggiungere contenuti. Ogni frase pronunciata deve comparire, nello stesso ordine e con le parole del docente.',
    '2. Aggiungi la punteggiatura e dividi in paragrafi di senso compiuto (indicativamente 3-8 frasi), andando a capo quando cambia il passaggio del ragionamento. Separa i paragrafi con una riga vuota.',
    `3. Correggi gli errori di trascrizione evidenti (parole storpiate, omofoni, termini tecnici sbagliati) in base al contesto${withAudio ? ' e riascoltando l\'audio' : ''}. Recupera, se le senti, parole che la trascrizione grezza ha saltato.`,
    '4. Se una correzione non è certa, scrivi la tua ipotesi seguita da [?].',
    '5. Se un passaggio resta incomprensibile, scrivi [incomprensibile].',
    '6. Elimina solo gli intercalari vuoti (ehm, eh, uhm) e le ripetizioni dovute a esitazione. Non correggere lo stile o la grammatica del parlato del docente: correggi solo gli errori della trascrizione.',
    '7. Se interviene uno studente, inizia quel paragrafo con "Studente:" e il paragrafo della risposta con "Docente:".',
    '8. Rendi formule e simboli matematici dettati a voce in LaTeX tra dollari, per esempio $\\hat{\\beta}$ o $\\sum_{i=1}^n x_i$.',
  ];
  if (withAudio) {
    lines.push(range
      ? `9. Inizia OGNI paragrafo con il tempo in cui comincia, tra parentesi quadre in formato [MM:SS], misurato dall'inizio della registrazione completa (quindi tra ${fmtMMSS(range[0])} e ${fmtMMSS(range[1])}). I tempi devono essere crescenti.`
      : `9. Inizia OGNI paragrafo con il tempo in cui comincia nell'audio di questo segmento, tra parentesi quadre in formato [MM:SS], misurato dall'inizio del segmento (quindi tra [00:00] e [${lenLabel}]). I tempi devono essere crescenti.`);
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
