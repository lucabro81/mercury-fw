---
name: mercury-plan
description: Load when starting a new unit of work on the Mercury framework — a feature, a bugfix, or a decision. Guides drafting a plan for Luca's approval in plan mode. Use at the very beginning, before any code or issue.
user-invocable: true
---

# Mercury Plan — Fase 1: Stesura del Plan

Ogni unità di lavoro su Mercury inizia con un plan scritto, proposto a Luca in plan
mode, e approvato da lui prima che si apra qualsiasi issue o si tocchi codice.

## Il tuo ruolo

Aiuta l'utente a strutturare un plan chiaro, atomico e verificabile. Non scrivere
codice. Non creare issue. Non fare commit. Il tuo output è un documento di plan.

## Struttura del plan

Il plan deve contenere queste sezioni, in questo ordine:

### 1. Titolo
Una riga, massimo 80 caratteri. Descrive il risultato, non l'implementazione.

### 2. Contesto
Perché questo lavoro serve. Qual è il problema o l'opportunità? Collega a issue
esistenti se pertinenti (`#N`).

### 3. Cosa cambia
Elenco puntato di cosa verrà modificato, aggiunto o rimosso. Sii specifico sui
file e le aree del repo (es. `packages/libs/core/src/session/`, `apps/cli/src/`).

### 4. Approccio tecnico
Come verrà implementato. Quali pattern esistenti seguire. Quali decisioni di
design sono già state prese e quali restano aperte.

### 5. Test
Come si verifica che funzioni. Per TDD: quali test verranno scritti prima del
codice. Quali edge case coprire. Come si runnano (`bun test` nel package
specifico, `bun run typecheck`, ecc.).

### 6. Documentazione
Cosa va aggiornato: README del package, root README, `AGENTS.md`,
`--help` del CLI, docs site, changeset. Elenca ogni file di doc impattato.

### 7. Rischi e note
Cosa potrebbe andare storto. Dipendenze esterne. Compatibilità. Aspetti che
Luca deve sapere prima di approvare.

## Regole

- **Atomico**: un plan = un changeset. Se il lavoro si spezza in più unità
  indipendenti, dilla a Luca e dividilo.
- **Verificabile**: ogni punto del test deve essere eseguibile e dare un
  risultato binario (passa/fail).
- **Nessun codice nel plan**: pseudo-codice al massimo, ma preferisci descrizioni.
- **Linguaggio**: il plan è in italiano se l'utente scrive in italiano, in inglese
  se scrive in inglese. Il corpo dell'issue sarà in inglese (è la lingua del repo).

## Output

Alla fine, presenta il plan all'utente e chiedi:
> "Questo è il plan. Vuoi che lo modifichi, o lo proponi a Luca per l'approvazione?"

Non procedere oltre finché Luca non approva. Un accordo in chat non è un plan
approvato.
