// Prova la sincronizzazione delle impostazioni tra due dispositivi (PC e telefono) con un finto Drive.
// Uso (dalla cartella test): node sync-test.mjs
import 'fake-indexeddb/auto';
const APP = new URL('../js/', import.meta.url).href;
const mkLS = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; };
const dev = { PC: mkLS(), TEL: mkLS() };
globalThis.localStorage = dev.PC;
globalThis.window = globalThis;
const store = await import(APP + 'store.js');
const { Sync } = await import(APP + 'sync.js');
let driveFile = null; let writes = 0;
const drive = { readAppFile: async () => (driveFile ? { id: 'x', data: JSON.parse(driveFile) } : null), writeAppFile: async (id, n, data) => { writes++; driveFile = JSON.stringify(data); } };
const sync = new Sync(drive);
let clock = Date.now(); Date.now = () => (clock += 1000);
const on = d => { globalThis.localStorage = dev[d]; };
const syncOn = async d => { on(d); await sync.syncSettings(); };
const courses = d => { on(d); return store.loadSettings().courses.map(c => c.name).join(', ') || '(nessuno)'; };
const field = (d, k) => { on(d); return store.loadSettings()[k]; };
let ok = true; const check = (cond, msg) => { console.log(`${cond ? 'OK ' : 'ERR'} ${msg}`); ok &&= cond; };

// 1. Il PC crea Social Data e Statistica, sincronizza; il telefono riceve.
on('PC'); store.saveSettings({ courses: [{ name: 'Social Data', glossary: 'NLP, sentiment' }, { name: 'Statistica', glossary: '' }] });
await syncOn('PC'); await syncOn('TEL');
check(courses('TEL') === 'Social Data, Statistica', `il telefono riceve i corsi: ${courses('TEL')}`);

// 2. Il caso del bug: il PC crea "Data Mining" ma NON sincronizza; il telefono intanto salva la chiave di riserva.
on('PC'); store.saveSettings({ courses: [...store.loadSettings().courses, { name: 'Data Mining', glossary: 'alberi' }] });
on('TEL'); store.saveSettings({ apiKey2: 'RISERVA' });
await syncOn('TEL'); await syncOn('PC'); await syncOn('TEL');
check(courses('PC') === 'Data Mining, Social Data, Statistica', `PC non perde corsi: ${courses('PC')}`);
check(courses('TEL') === 'Data Mining, Social Data, Statistica', `telefono riceve Data Mining: ${courses('TEL')}`);
check(field('PC', 'apiKey2') === 'RISERVA', 'il PC riceve la chiave di riserva salvata sul telefono');

// 3. Modifiche diverse allo stesso tempo su campi diversi: si tengono entrambe.
on('PC'); store.saveSettings({ chunkMin: 30 });
on('TEL'); store.saveSettings({ reviseModel: 'gemini-3.7-flash' });
await syncOn('PC'); await syncOn('TEL'); await syncOn('PC');
check(field('PC', 'chunkMin') === 30 && field('TEL', 'chunkMin') === 30, 'chunkMin dal PC arriva ovunque');
check(field('PC', 'reviseModel') === 'gemini-3.7-flash' && field('TEL', 'reviseModel') === 'gemini-3.7-flash', 'reviseModel dal telefono arriva ovunque');

// 4. Stesso campo cambiato su entrambi: vince il più recente.
on('PC'); store.saveSettings({ chunkMin: 20 });
on('TEL'); store.saveSettings({ chunkMin: 50 });
await syncOn('PC'); await syncOn('TEL'); await syncOn('PC');
check(field('PC', 'chunkMin') === 50 && field('TEL', 'chunkMin') === 50, 'stesso campo: vince la modifica più recente (50)');

// 5. Eliminazione: il telefono elimina Statistica, il PC modifica Social Data. Statistica non deve ricomparire.
on('TEL'); store.saveSettings({ courses: store.loadSettings().courses.filter(c => c.name !== 'Statistica') });
on('PC'); store.saveSettings({ courses: store.loadSettings().courses.map(c => (c.name === 'Social Data' ? { ...c, glossary: 'NLP, sentiment, topic model' } : c)) });
await syncOn('TEL'); await syncOn('PC'); await syncOn('TEL');
check(courses('PC') === 'Data Mining, Social Data' && courses('TEL') === 'Data Mining, Social Data', `eliminazione rispettata: PC=${courses('PC')} / TEL=${courses('TEL')}`);
on('TEL'); check(store.loadSettings().courses.find(c => c.name === 'Social Data').glossary === 'NLP, sentiment, topic model', 'la modifica alle parole chiave fatta sul PC arriva al telefono');

// 6. Un corso eliminato e poi ricreato torna.
on('PC'); store.saveSettings({ courses: [...store.loadSettings().courses, { name: 'Statistica', glossary: 'nuovo' }] });
await syncOn('PC'); await syncOn('TEL');
check(courses('TEL').includes('Statistica'), 'un corso ricreato dopo l\'eliminazione ricompare');

// 7. Stabilità: sincronizzazioni ripetute senza modifiche non riscrivono il file su Drive.
const w = writes; for (let i = 0; i < 4; i++) { await syncOn('PC'); await syncOn('TEL'); }
check(writes === w, `nessuna riscrittura inutile su Drive (${writes - w} scritture in 8 sincronizzazioni)`);

// 8. Migrazione: file su Drive di una versione precedente (senza date per campo) + telefono aggiornato.
driveFile = JSON.stringify({ apiKey: 'VECCHIA', courses: [{ name: 'Social Data', glossary: 'x' }, { name: 'Econometria', glossary: '' }], updatedAt: clock + 10_000, chunkMin: 45 });
dev.NUOVO = mkLS(); on('NUOVO'); store.saveSettings({ apiKey2: 'R2' });
await syncOn('NUOVO');
check(courses('NUOVO') === 'Econometria, Social Data' && field('NUOVO', 'apiKey') === 'VECCHIA' && field('NUOVO', 'apiKey2') === 'R2', `migrazione da versione vecchia: corsi=${courses('NUOVO')}, chiavi ok`);
console.log(ok ? '\nTUTTO OK' : '\nCI SONO ERRORI');
process.exit(0);
