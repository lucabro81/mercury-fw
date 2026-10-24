---
name: mercury-issue
description: Load after Luca has approved a plan in plan mode. Creates the GitHub issue with the approved plan in its body, then creates the working branch from the issue. Use only after explicit approval.
user-invocable: true
---

# Mercury Issue — Fase 2: Issue e Branch

Questa skill si usa **solo dopo** che Luca ha approvato il plan in plan mode.
Un accordo in chat non è un'approvazione — deve essere esplicito.

## Prerequisiti

Prima di procedere, verifica che:
1. Il plan è stato approvato da Luca (l'utente deve confermarlo esplicitamente)
2. Sei sul branch `main` e il working tree è pulito: `git status --porcelain`
3. `main` è aggiornato: `git fetch origin && git status`

## Passi

### 1. Crea l'issue

```bash
gh issue create \
  --title "<titolo del plan>" \
  --body "<corpo del plan approvato>" \
  --repo lucabro81/mercury-fw
```

Il corpo dell'issue deve contenere il plan completo, formattato in Markdown.
Aggiungi una riga in cima: `> Plan approved by @lucabro81 in plan mode.`

### 2. Crea il branch dall'issue

```bash
gh issue develop <N> --base main --name feat/<N>-<slug> --repo lucabro81/mercury-fw
```

Dove `<N>` è il numero dell'issue appena creata e `<slug>` è una versione
kebab-case del titolo (max 40 caratteri).

### 3. Verifica

```bash
git branch --show-current   # deve mostrare feat/<N>-<slug>
git log --oneline -1        # deve puntare a main
```

### 4. Report

Comunica all'utente:
- Numero dell'issue: `#N`
- URL dell'issue
- Nome del branch: `feat/<N>-<slug>`
- Prossimo passo: caricare la skill `mercury-tdd` per iniziare il lavoro TDD

## Regole

- Non fare commit su `main` mai. Il branch è l'unico posto dove si committa.
- Il branch name segue sempre `feat/<N>-<slug>`.
- Se l'issue esiste già (es. l'utente la ha creata a mano), salta il passo 1 e
  vai diretto al passo 2 con il numero issue esistente.
