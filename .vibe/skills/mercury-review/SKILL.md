---
name: mercury-review
description: Load before merging a PR on Mercury. Runs the two review-gate subagents (cold-reviewer and docs-auditor) with only the issue number and branch name, collects their verdicts, fixes findings in-branch, and re-runs until both APPROVE.
user-invocable: true
---

# Mercury Review — Fase 5: Review Gate

Prima di fare merge di una PR, due subagent reviewano il branch in parallelo,
ognun con solo il numero dell'issue e il nome del branch — nessun contesto della
conversazione. I loro verdetti sono binding: non si fa merge finché entrambi non
danno APPROVE.

## Prerequisiti

- Sei sul branch `feat/<N>-<slug>`
- Tutti i test passano, typecheck pulito
- Il branch è pushato su origin: `git push -u origin <branch>`
- La PR esiste (o la crei ora con `gh pr create --fill --body "Closes #N"`)
- I profili dei due subagent sono in `.vibe/agents/cold-reviewer.toml` e
  `.vibe/agents/docs-auditor.toml` (la cartella del progetto deve essere
  trusted: al primo avvio Vibe lo chiede)

## I due subagent

### cold-reviewer
Giudica il codice contro l'issue. Cerca bug, dead code, test inadeguati,
edge case mancanti. Il suo verdetto è APPROVE o CHANGES REQUESTED.
Il suo system prompt è in `.vibe/agents/cold-reviewer.toml` — la definizione
canonica è `.claude/agents/cold-reviewer.md` (quella usata da Claude Code):
tienili in sync quando la definizione cambia.

### docs-auditor
Verifica bidirezionalmente che la documentazione sia allineata al codice.
Cerca doc mancanti, doc stantie, contraddizioni, deferral non tracciati.
Il suo verdetto è APPROVE o CHANGES REQUESTED.
Il suo system prompt è in `.vibe/agents/docs-auditor.toml` — la definizione
canonica è `.claude/agents/docs-auditor.md`: tienili in sync.

## Procedura

### 1. Prepara il contesto per i subagent

Raccogli:
- Numero dell'issue: `N`
- Nome del branch: `feat/N-slug`

### 2. Lancia cold-reviewer

Spawna il subagent `cold-reviewer` con il tool `task`:

- `agent`: `cold-reviewer`
- `task`: solo il contesto minimo, nient'altro:

```
Issue: #N
Branch: feat/N-slug
```

### 3. Lancia docs-auditor

Spawna il subagent `docs-auditor` con il tool `task`, stesso formato:

- `agent`: `docs-auditor`
- `task`: lo stesso contesto minimo di cold-reviewer (issue number, branch, repo)

### 4. Raccogli i verdetti

Attendi che entrambi i subagent completino. Leggi i loro report:
- Se entrambi APPROVE: procedi al passo 6
- Se uno o entrambi CHANGES REQUESTED: procedi al passo 5

### 5. Fix dei findings

Per ogni finding nei report:

- **Finding di cold-reviewer (codice)**: fixalo tu stesso nel branch, a meno
  che non sia severo o nasconda una decisione che spetta a Luca. In quel caso,
  porta il finding a Luca e aspetta la sua decisione.
- **Finding di docs-auditor (documentazione)**: fixalo direttamente. Se il
  finding indica che il **codice** è sbagliato (direzione A: doc claim non
  supportato dal codice), applica le stesse regole di cold-reviewer.
- **Finding "undecided"**: decidi in base all'intento dell'issue se è chiaro,
  altrimenti chiedi a Luca.

Dopo aver fixato tutti i finding:
1. Committa le fix: `git add -A && git commit -m "fix(review): address review findings"`
2. Pusha: `git push`
3. **Rilancia entrambi i subagent** (torna al passo 2)
4. Ripeti finché entrambi danno APPROVE

### 6. Report finale

Quando entrambi danno APPROVE, comunica all'utente:
- I verdetti dei due subagent
- La lista dei findings fixati (se ce ne sono stati)
- Che la PR è pronta per il merge (ma il merge aspetta Luca)

## Regole

- **Mai fare merge senza APPROVE di entrambi.**
- **Mai dare contesto ai subagent oltre a issue number e branch name.**
  Il loro valore è negli occhi freschi.
- **Non saltare la review gate**, nemmeno per "piccole modifiche".
- Se un subagent trova un problema architetturale grave, escala a Luca prima
  di fixare.

## Dopo la review

Carica la skill `mercury-release` per changeset, release e merge.
