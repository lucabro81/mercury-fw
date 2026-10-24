---
name: mercury-tdd
description: Load when working on a Mercury branch (feat/<N>-<slug>) after the issue has been created. Enforces TDD — write the failing test first, then implement, then refactor. Atomic commits, one changeset per issue.
user-invocable: true
---

# Mercury TDD — Fase 4: Sviluppo sul Branch

Questa skill guida il lavoro di sviluppo sul branch `feat/<N>-<slug>`, applicando
TDD (Test-Driven Development) e commit atomici.

## Prerequisiti

- Sei sul branch `feat/<N>-<slug>` (verifica con `git branch --show-current`)
- L'issue `#N` esiste e contiene il plan approvato
- Il working tree è pulito o contiene solo modifiche intenzionali

## Ciclo TDD

Per ogni unità di lavoro nel plan:

### 1. RED — Scrivi il test che fallisce

- Identifica il package impattato (es. `packages/libs/core`, `apps/cli`)
- Scrivi il test nel file di test corrispondente (co-locato con il codice:
  `src/foo.ts` → `src/foo.test.ts`)
- Il test deve:
  - Descrivere il comportamento atteso in modo specifico
  - Coprire edge case e limit case, non solo il happy path
  - Usare `bun:test` (`import { describe, it, expect } from 'bun:test'`)
- Esegui il test e **verifica che fallisca** per il motivo giusto:
  ```bash
  cd <package-dir> && bun test <test-file>
  ```
- Committa il test:
  ```bash
  git add <test-file>
  git commit -m "test(<scope>): <descrizione del test>"
  ```

### 2. GREEN — Implementa il minimo per far passare il test

- Scrivi il codice minimo necessario a far passare il test
- Non ottimizzare, non aggiungere feature non richieste
- Esegui il test: deve passare
- Esegui tutti i test del package per verificare che non abbia rotto nulla:
  ```bash
  cd <package-dir> && bun test
  ```
- Committa l'implementazione:
  ```bash
  git add <source-files>
  git commit -m "feat(<scope>): <descrizione dell'implementazione>"
  ```

### 3. REFACTOR — Migliora il codice

- Refactorizza mantenendo i test verdi
- Rimuovi duplicazioni, migliora nomi, semplifica
- Esegui test e typecheck dopo ogni modifica
- Committa il refactor (se c'è qualcosa di significativo):
  ```bash
  git commit -m "refactor(<scope>): <descrizione>"
  ```

## Regole per i commit

- **Atomici**: un commit = un cambiamento logico. Non mescolare test e
  implementazione nello stesso commit (a meno che non sia un refactor minimo).
- **Messaggio**: segue Conventional Commits: `type(scope): description`
  - `type`: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`
  - `scope`: il package o l'area (es. `core`, `cli`, `plugin-jira`)
- **No commit su main**: l'hook lo blocca, ma verifica sempre il branch corrente.

## Prima di ogni push

```bash
# Typecheck del package modificato
cd <package-dir> && bun run typecheck

# Tutti i test del package
cd <package-dir> && bun test

# Se il cambiamento tocca più package, typecheck a livello di repo
bun run typecheck
```

## Quando hai finito

- Tutti i test passano
- Typecheck pulito
- Ogni commit è atomico e ha un messaggio significativo
- Il branch è pronto per la review gate

Carica la skill `mercury-review` per procedere.

## Per i bugfix

Anche i bugfix seguono TDD:
1. Scrivi un test che riproduce il bug (fallisce)
2. Fixia il bug (test passa)
3. Verifica che non abbia regressioni
