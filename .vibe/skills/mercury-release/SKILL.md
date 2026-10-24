---
name: mercury-release
description: Load after both review-gate subagents (cold-reviewer and docs-auditor) have returned APPROVE. Creates the changeset, runs the release, pushes with tags, and prepares the PR for squash-merge.
user-invocable: true
---

# Mercury Release — Fase 6: Changeset, Release e Merge

Questa skill si usa dopo che entrambi i subagent di review hanno dato APPROVE.
Si occupa di: changeset, version bump, tag, push, PR, e le istruzioni per il merge.

## Prerequisiti

- Entrambi i subagent (cold-reviewer e docs-auditor) hanno dato APPROVE
- Sei sul branch `feat/<N>-<slug>`
- Tutti i test passano, typecheck pulito
- Il branch è pushato su origin e la PR esiste

## Passi

### 1. Crea il changeset

```bash
bun run changeset
```

Rispondi alle domande di changesets:
- **Pacchetti impattati**: seleziona i package che il diff tocca. Per una
  modifica al framework (core, cli, contracts, ecc.), seleziona tutti quelli
  nel gruppo `fixed`. Per un plugin/channel/auth, seleziona solo quello.
- **Tipo di bump**: `patch` per bugfix, `minor` per feature, `major` per
  breaking change (mai senza un'issue dedicata).
- **Descrizione**: testo pubblico, in inglese, senza riferimenti interni
  (no `D-XX`, `S-XX`, no milestone). Descrive cosa cambia per l'utente.

Verifica il changeset creato:
```bash
cat .changeset/<nome-file>.md
```

Committa il changeset e salva il suo testo per la PR:
```bash
git add .changeset/
git commit -m "chore: add changeset for #N"
CHANGESET_BODY=$(awk 'f{print} /^---$/{c++; f=(c==2)}' .changeset/<nome-file>.md | sed '/./,$!d')
```

### 2. Esegui il release

```bash
bun run release
```

Questo esegue: `changeset version`, aggiorna `bun.lock`, committa, e tagga.

Verifica:
```bash
git log --oneline -5    # deve mostrare il commit di version bump
git tag --points-at HEAD  # deve mostrare i tag creati
```

### 3. Push con tag

```bash
git push origin <branch> --tags
```

### 4. Aggiorna la PR

Assicurati che la PR abbia:
- Titolo descrittivo
- Body con `Closes #N`
- I cambiamenti descritti nel changeset

```bash
gh pr edit --body "Closes #N

$CHANGESET_BODY"
```

### 5. Istruzioni per il merge (per Luca)

La PR è pronta. Luca deve:
1. Verificare che CI sia verde (`.github/workflows/ci.yml`)
2. Fare squash-merge (l'issue si chiude automaticamente con `Closes #N`)
3. Sincronizzare `main` e cancellare il branch:
   ```bash
   git checkout main
   git pull
   git branch -d feat/<N>-<slug>
   git push origin --delete feat/<N>-<slug>
   ```

### 6. Chiudi il loop

Dopo il merge, aggiorna la memoria di progetto con ciò che vale la pena
ricordare per sessioni future, e porta il `README.md` in linea se la modifica
lo richiede.

## Regole

- **Un changeset per issue.** Mai batchare.
- **Mai `changeset publish` o `npm publish`** su una cartella workspace.
- **Il testo del changeset è pubblico**: è il changelog che gli utenti leggono.
- **Consuma il changeset subito dopo il cambiamento** che documenta.
- Il merge è **sempre** squash-merge, mai merge commit.

## Dopo il merge

L'unità di lavoro è completa. Si può iniziare una nuova unità con la skill
`mercury-plan`.
