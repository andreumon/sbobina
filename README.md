# Sbobina

Trascrizione letterale delle lezioni universitarie: condividi l'audio dal Registratore del telefono e Sbobina lo trascrive, lo rivede (punteggiatura, paragrafi, correzioni dal contesto) e lo sincronizza su Google Drive. Puoi riascoltare la lezione da telefono o PC toccando il tempo di ogni paragrafo.

Tutto gratuito: usa il piano gratuito della Gemini API e il tuo Google Drive.

## Come funziona

1. **Condividi** il file `.aac` dal Registratore e scegli *Sbobina*.
2. L'app taglia la lezione in **blocchi di circa 20 minuti**. Intorno a ogni punto di taglio cerca la pausa più silenziosa, così una parola non viene spezzata a metà. L'AAC del registratore è fatto di frame indipendenti: il taglio avviene senza ricodificare nulla. Le lezioni lunghe vanno bene, anche 3 o 4 ore.
3. Ogni blocco viene trascritto parola per parola. Se hai inserito una chiave Groq lo fa **Whisper large-v3** su Groq, che restituisce anche il tempo preciso di ogni frase; altrimenti (o se Groq non risponde) `gemini-3.5-transcribe`, il modello di Google dedicato alla trascrizione. A entrambi passiamo la lingua del corso e i suoi termini tecnici.
   Prima dell'invio il blocco viene convertito in **Opus mono a 16 kHz** (*invii leggeri*): 45 minuti passano da circa 65 MB a circa 8 MB, con la stessa resa per il riconoscimento del parlato (i modelli lavorano comunque a 16 kHz mono).
4. `gemini-3.8-flash` **rivede** il testo riascoltando l'audio. Aggiunge punteggiatura e paragrafi e corregge le parole storpiate in base al contesto. Mette `[?]` sulle correzioni incerte e `[incomprensibile]` dove non si capisce. Aggiunge il tempo d'inizio di ogni paragrafo e scrive le formule in LaTeX.
5. **Controllo di completezza**: Sbobina confronta il numero di parole della revisione con la trascrizione grezza. Se la revisione ne ha molte meno, il modello potrebbe aver riassunto invece di trascrivere, e l'app te lo segnala. La versione grezza resta sempre disponibile nella scheda *Grezza*.
6. Su Drive, nella cartella **Sbobina**, c'è una sottocartella per ogni corso con l'audio originale e il `.md` di ogni lezione. I dati interni (testo grezzo, tempi, impostazioni) stanno nella cartella nascosta dell'app. Telefono e PC vedono le stesse lezioni.

**Nota sul registratore Nothing**: i suoi file `.aac` iniziano con un "frame" finto da 9 byte, che contiene la configurazione del codec invece di audio. Google e il browser si bloccano su quel frame. Sbobina lo riconosce e lo esclude prima dell'invio; il file originale su Drive resta intatto.

Se chiudi l'app o cade la rete, l'elaborazione riparte dal blocco in cui si era fermata.

## Installazione (una volta sola, circa 20 minuti)

Ti servono un account Google e un account GitHub (gratuito).

### 1. Chiave Gemini (2 minuti)

1. Vai su [aistudio.google.com/apikey](https://aistudio.google.com/apikey) con il tuo account Google.
2. Premi **Create API key** e copia la chiave. Dal 28 maggio 2026 le chiavi nuove iniziano con `AQ.`: sono le nuove "chiavi di autenticazione" di Google, e vanno benissimo. Le vecchie chiavi iniziavano con `AIza`.
   *Facoltativo:* crea una seconda chiave in un **altro progetto** Google e incollala in *Impostazioni → Chiave di riserva*. Sbobina la usa da sola quando la principale ha finito la quota, non risponde o viene rifiutata (le quote gratuite sono per progetto: una seconda chiave dello stesso progetto non aggiunge quota).
3. La inserirai nell'app al primo avvio, in *Impostazioni → Gemini*. Basta farlo su un dispositivo: poi viaggia via Drive.

### 1b. Chiave Groq (facoltativa, 2 minuti, consigliata dalle 2 lezioni al giorno in su)

1. Vai su [console.groq.com/keys](https://console.groq.com/keys) e accedi (anche con Google). Non serve la carta.
2. Premi **Create API Key**, copia la chiave (inizia con `gsk_`) e incollala in *Impostazioni → Groq*, poi premi *Verifica*.

Con la chiave Groq la trascrizione letterale la fa Whisper e Gemini si occupa solo della revisione: una lezione da 90 minuti costa a Gemini 2 richieste invece di circa 4.

### 2. Pubblica il sito su GitHub Pages (5 minuti)

1. Su [github.com/new](https://github.com/new) crea un repository **pubblico** chiamato `sbobina`.
2. Nella pagina del repository premi **Add file → Upload files**. Trascina **il contenuto** della cartella `sbobina`: `index.html`, `sw.js`, `manifest.webmanifest` e le cartelle `css`, `js` e `icons`. Poi premi **Commit changes**.
3. Vai su **Settings → Pages**. In *Build and deployment* scegli *Deploy from a branch*, branch `main`, cartella `/ (root)`, e premi **Save**.
4. Dopo un minuto il sito è su `https://TUONOME.github.io/sbobina/`.

> Il repository pubblico non contiene segreti. La chiave Gemini resta nel tuo browser e nella cartella nascosta di Sbobina sul tuo Drive. L'ID client del passo 3 è pubblico per natura.

### 3. Permesso di accesso a Google Drive (10–15 minuti)

Serve perché il tuo sito possa leggere e scrivere i file di Sbobina nel tuo Drive.

1. Apri [console.cloud.google.com](https://console.cloud.google.com/) e crea un nuovo progetto chiamato `Sbobina`.
2. **Attiva Drive**: cerca nella barra in alto "Google Drive API", aprila e premi **Abilita**.
3. **Schermata di consenso**: vai su *Google Auth Platform* (o *API e servizi → Schermata consenso OAuth*) e premi **Inizia**.
   - Nome app: `Sbobina`. Email di assistenza: la tua.
   - Pubblico: **Esterno**.
   - Email di contatto: la tua. Accetta le norme e premi **Crea**.
4. **Ambiti** (*Accesso ai dati → Aggiungi o rimuovi ambiti*): aggiungi questi due e salva.
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/drive.appdata`

   Google li classifica **non sensibili**. Il primo dà accesso solo ai file creati da Sbobina, non al resto del tuo Drive.
5. **Pubblico**: hai due strade.
   - *Rapida*: lascia lo stato su **Test** e, in *Utenti di test*, premi **Add users** e aggiungi la tua email. Funziona subito. Google ti chiederà di riconfermare l'accesso ogni tanto: un tocco nel popup.
   - *Definitiva*: in **Branding** compila *Home page dell'applicazione* con `https://TUONOME.github.io/sbobina/` e *Norme sulla privacy* con `https://TUONOME.github.io/sbobina/privacy.html` (la pagina è già inclusa). In *Domini autorizzati* aggiungi `TUONOME.github.io`, salva, poi torna su **Pubblico → Pubblica app**.
6. **Client**: premi **Crea client**.
   - Tipo: **Applicazione web**.
   - In *Origini JavaScript autorizzate* aggiungi `https://TUONOME.github.io`: niente barra finale e niente `/sbobina`.
   - Premi **Crea** e copia l'**ID client** (finisce con `.apps.googleusercontent.com`).
7. Incollalo in `js/config.js`, dentro `DRIVE_CLIENT_ID = '...'`, e ricarica quel file su GitHub (*Add file → Upload files*). Così telefono e PC lo trovano già. In alternativa, incollalo in *Impostazioni → Google Drive* su ogni dispositivo.

### 4. Installa l'app

**Telefono (Chrome per Android)**
1. Apri `https://TUONOME.github.io/sbobina/`.
2. Dal menu ⋮ scegli **Aggiungi a schermata Home → Installa**.
3. Apri Sbobina dall'icona, inserisci la chiave Gemini e collega Drive.
4. Da ora, nel Registratore: **Condividi → Sbobina**. Se Sbobina non compare subito tra le app di condivisione, aprila una volta dall'icona e riprova.

**PC (Chrome o Edge)**
1. Apri lo stesso indirizzo.
2. Premi l'icona *Installa* nella barra degli indirizzi.
3. Premi la nuvoletta in alto per collegare Drive: impostazioni e lezioni arrivano da sole.
4. In *Impostazioni → Cartella generale sul PC* scegli dove salvare i `.md` (solo Chrome ed Edge). Ogni corso può avere una cartella propria: pagina del corso → *Cartella sul PC*. Le lezioni di un corso senza cartella propria vanno in quella generale.
5. In alternativa, con **Google Drive per desktop** la cartella `Sbobina` diventa una cartella vera del PC, sempre aggiornata. Dall'app, *Apri su Drive* apre il `.md` di una lezione o la cartella di un corso.

## Uso quotidiano

- **Ascolto**: tocca il tempo di un paragrafo per sentire quel punto. Il paragrafo in ascolto resta evidenziato. Le tacche gialle sulla barra segnano i punti da verificare.
- **Scorciatoie su PC**:
  - `spazio`: pausa e riproduzione.
  - `←` / `→`: 5 secondi indietro o avanti (con `Maiusc`, 30 secondi).
  - `[` / `]`: velocità.
  - `N` / `Maiusc+N`: punto da verificare successivo o precedente; `Esc` chiude il fumetto.
- **Sul telefono** il lettore si controlla anche dalla schermata di blocco.
- **Menu della lezione**: sul telefono tieni premuta una lezione nell'elenco; sul PC tasto destro, oppure il pulsante ⋯ che compare passandoci sopra. Trovi Apri, Rinomina, Sposta, Modifica, Copia, Salva .md, Condividi, Elimina e, se serve, Riprendi.
- **Google sovraccarico**: se il modello di revisione è sovraccarico, Sbobina passa da solo al successivo in ordine di priorità: gemini-3.8-flash → 3.7-flash → 3.6-flash → 3.5-flash. I modelli migliori hanno sempre la precedenza; 3.6 e 3.5 si usano solo quando gli altri non sono disponibili, e *Dettagli* dice quale modello ha rivisto ogni blocco. I modelli "lite" non toccano mai il testo: servono solo per l'indice. Se sono tutti sovraccarichi o senza quota, la lezione va *in attesa* e riprova da sola.
- **Punti da verificare**: la nuvoletta *N punti da verificare* accanto alle schede ti segue quando scorri (resta sopra il lettore). Ogni tocco apre il punto successivo:
  - il testo incerto è evidenziato e sotto compare un **fumetto**;
  - l'audio riparte da 3 secondi prima del punto e **ripete** circa 15 secondi finché non hai finito (il tratto è segnato sulla barra; −5/+5 lo spostano, perché il momento esatto è stimato dal tempo del paragrafo);
  - *Correggi* (o `Invio`) sostituisce le parole evidenziate con quello che scrivi, *Va bene così* toglie il `[?]` lasciando il testo, *Modifica paragrafo* apre tutto il paragrafo;
  - dopo ogni scelta si passa da soli al punto seguente; alla fine compare *Tutto verificato ✓*.

  Puoi anche toccare direttamente un `[?]` o un `[incomprensibile]` nel testo.
- **Correggere un paragrafo qualsiasi**: doppio tocco (doppio clic su PC) sul paragrafo. Si apre un riquadro con il testo e i comandi audio; una riga vuota lo divide in due. Su PC `Ctrl+Invio` salva ed `Esc` annulla. Le correzioni si sincronizzano su tutti i dispositivi; il `.md` su Drive si aggiorna da solo, e anche quello nella cartella del PC se l'avevi già salvato lì.
- **Correggere tutto il testo**: *Modifica* nel menu apre l'intero testo con i tempi. La versione automatica resta recuperabile.
- **Rivedere di nuovo tutto il testo**: *Rivedi tutto* tra le azioni della lezione rifà la revisione di ogni blocco, riascoltando l'audio e partendo dal grezzo, con la stessa scelta di modelli. Con *solo 3.8 e 3.7* la lezione aspetta che uno dei due sia libero; se dopo 30 minuti non lo è, si ferma e il testo resta quello di prima. Il testo che c'era prima, con le tue correzioni a mano, resta salvato: in *Dettagli → Versioni precedenti* lo ripristini con un tocco (si tengono le ultime due).
- **Far rivedere un paragrafo a Gemini**: nell'editor del paragrafo, *Fai rivedere a Gemini questo paragrafo* manda solo il tratto di audio di quel paragrafo, il suo grezzo e i paragrafi vicini come contesto. Accanto scegli i modelli: *migliori disponibili* (3.8 → 3.5) oppure *solo 3.8 e 3.7*, che se sono occupati aspetta e riprova per al massimo 30 minuti (*Annulla* per smettere). L'app ricorda l'ultima scelta. La nuova versione compare sotto, con le parole aggiunte evidenziate e quelle tolte barrate: *Accetta*, *Modifica* o *Tieni la vecchia*.
- **Cercare**: la lente accanto alle schede cerca nella lezione aperta, senza distinguere maiuscole e accenti; ‹ › (o `Invio` / `Maiusc+Invio`) passano da un risultato all'altro, su PC `/` apre la ricerca. *Cerca in tutto il corso* elenca le altre lezioni del corso con i minuti in cui compare il termine; un tocco apre la lezione in quel punto. Lo stesso campo di ricerca c'è in cima alla pagina del corso.
- **Indice**: *Indice* tra le azioni della lezione crea, su richiesta, l'elenco degli argomenti con i minuti di inizio (con gemini-flash-lite, che ha quote proprie e non consuma quelle delle revisioni). Toccando una voce si salta a quel punto, e la nuvoletta *↑ Indice* riporta su. *Rigenera* lo rifà.
- **Dettagli**: *Dettagli* tra le azioni della lezione mostra, anche a lavoro finito, quali modelli hanno trascritto e rivisto ogni blocco, quanto è durata l'elaborazione e il registro completo.
- **Corsi**: nell'elenco le lezioni sono raggruppate in cartelle, una per corso. *Nuovo corso* crea un corso con le sue parole chiave. *Parole chiave*, accanto al nome di un corso, apre la sua pagina: lì modifichi nome e parole chiave, aggiungi una registrazione già assegnata al corso o elimini il corso (le lezioni restano, in *Senza corso*). Dalla pagina di una lezione, *Sposta* la assegna a un altro corso; su Drive i file la seguono.
- **Parole chiave**: aggiungi quelle che il modello sbaglia. Valgono anche per le lezioni del corso non ancora trascritte.
- **Spazio**: una lezione da 90 minuti pesa circa 85 MB. Dalle impostazioni puoi togliere l'audio dal telefono: resta su Drive e torna quando premi play.

## Limiti da sapere

- **Quote gratuite** (ottobre 2026, per progetto Google, azzerate alle 9:00 italiane):

  | Modello | Richieste/min | Token/min | Richieste/giorno |
  | --- | --- | --- | --- |
  | gemini-3.5-transcribe | 3 | 10.000 | 25 |
  | gemini-3.8-flash | 5 | 250.000 | 20 |
  | gemini-3.7-flash | 5 | 250.000 | 20 |

  | Whisper large-v3 (Groq) | 20 | — | 2.000 (e 8 ore di audio al giorno, 2 all'ora) |

  Sbobina tiene il conto, aspetta il tempo giusto tra una richiesta e l'altra e, se un modello va atteso a lungo o ha finito la quota del giorno, passa al successivo (3.8 → 3.7 → 3.6 → 3.5) senza ritentarlo nei blocchi seguenti. Con blocchi da 45 minuti una lezione costa circa 4 richieste. Se finiscono tutte le quote, la lezione va *in attesa* e riparte da sola alle 9:00, con l'app aperta. In *Impostazioni → Quote gratuite di oggi* vedi il conteggio.
- **Lingua**: si imposta per corso (italiano, inglese, inglese con parti in italiano…). Il modello non traduce mai: ogni frase resta nella lingua in cui è detta.
- **Controllo dei buchi**: se tra due paragrafi passa molto più tempo di quanto serva a pronunciarli, Sbobina lo segnala sopra il testo con i tempi cliccabili. Spesso sono pause o silenzi, a volte testo saltato: un tocco e ascolti.
- **Groq**: se Groq rifiuta la chiave, non risponde o ha finito la quota del giorno, quel blocco e i successivi si trascrivono con Gemini, senza aspettare. Whisper a volte "inventa" frasi nei silenzi lunghi (tipo *Sottotitoli creati dalla comunità Amara.org*, o un *Grazie.* isolato in mezzo a una pausa): Sbobina scarta quelle riconoscibili e le elenca nel registro; alla revisione di Gemini, che riascolta l'audio, è chiesto di togliere quelle rimaste.
- **Invii leggeri**: servono Chrome, Edge o Firefox recenti (il codificatore Opus del browser). Se Google rifiutasse l'audio Opus, Sbobina torna da sola all'originale e lo ricorda.
- **Privacy**: nel piano gratuito Google può usare i contenuti inviati per migliorare i suoi modelli. Per le lezioni di solito non è un problema. Non usarlo per registrazioni riservate.
- **Tempi dei paragrafi**: li stima il modello mentre riascolta, con una precisione di qualche secondo. Con Groq la revisione parte dai tempi di Whisper, misurati frase per frase, e sono più precisi. I tagli tra i blocchi invece sono esatti.
- **Formati**: l'AAC del registratore viene tagliato senza perdite. Altri formati (`.m4a`, `.mp3`, `.ogg`…) funzionano: sotto i 55 minuti vanno in un blocco unico, oltre vengono trascritti a tratti di tempo.
- L'app è stata collaudata con Gemini e Drive simulati. Se al primo uso reale qualcosa non va, apri *Dettagli* sotto la barra di avanzamento: il registro dice dove si è fermata.

## Struttura

| File | Cosa fa |
| --- | --- |
| `index.html`, `css/app.css` | Interfaccia: tema chiaro e scuro ardesia |
| `js/app.js` | Schermate, lettore, impostazioni, coda di elaborazione |
| `js/aac.js` | Analisi dei frame AAC e taglio nelle pause |
| `js/pipeline.js` | Blocchi → caricamento → trascrizione → revisione, con ripresa |
| `js/prompts.js` | Istruzioni ai modelli (modificabili) |
| `js/gemini.js` | Gemini API: Files API e Interactions API |
| `js/groq.js` | Whisper su Groq: trascrizione, filtro delle frasi inventate, testo grezzo con i tempi |
| `js/light.js` | Audio leggero: AAC → Opus mono 16 kHz in un file Ogg, nel browser |
| `js/assist.js` | Su richiesta: indice, nuova revisione di un paragrafo, confronto tra versioni, ricerca |
| `js/quota.js` | Conteggio e dosatura delle quote gratuite, scelta del modello |
| `js/config.js` | ID client di Google Drive (il tuo: non sovrascriverlo negli aggiornamenti) |
| `js/drive.js`, `js/sync.js` | Login Google e sincronizzazione con Drive |
| `js/text.js` | Tempi, paragrafi, controllo di completezza, Markdown |
| `sw.js`, `manifest.webmanifest` | App installabile, ricezione dei file condivisi, uso offline |
