---
"@mercury-fw/plugin-web-search": minor
---

The model is told when to search by what the question shows, instead of "what is current or outside what you know", which asked it to know what it doesn't.

- It searches for what changes over time (news, versions, prices, schedules, who holds a role), for something recent compared with the date on the message, for a precise detail it would otherwise guess, for a name it doesn't recognize, and when asked to look something up or check it.
- Lasting facts, reasoning, calculations and writing need no search.
- The plugin's description is now "Searches the web and reads web pages.": when to search is the prompt fragment's.

"Recent" works best with the framework at 0.56 or later, where every message reaches the model with its date.
