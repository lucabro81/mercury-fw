# __PACKAGE__

The __TITLE__ plugin: a memory that keeps what each person asked about and reads the latest back to the model at the start of their next session. `mfw plugin create` wrote it as a starting point for a memory of its own.

## Contents

- [Declaring it](#declaring-it)
- [How it works](#how-it-works)
- [Testing](#testing)

## Declaring it

`mfw plugin create` put it in `plugins`. The model reads what it remembers only when a context profile lists it among its `layers`, in `mercury.config.ts`:

```ts
context: { profiles: { default: { layers: [__CAMEL__], budget: { maxChars: 4000 }, conversation } } },
```

with `const __CAMEL__ = __EXPORT__();` declared once and used in both places.

## How it works

- `afterTurn` keeps the topic of each turn the person wrote, as background work (`ctx.job`); the operator's turns on the terminal are never kept.
- `onSessionClose` trims the person's topics to the newest `keep` (20 unless given).
- `context` is a session layer: the person's latest topics, as many as its `topics` knob says (5 unless the profile sets it).
- The topics live in the plugin's data folder, a file per person, written to a temporary file renamed over the old one.
- A plugin keeping the conversation itself, as `@mercury-fw/archive` does, uses `onTurnRecord` instead: every turn's whole record, confirmations included.

## Testing

`bun test` in this folder, or `bun run test` in the app's.
