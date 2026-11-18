---
title: Cookbook
description: Recipes for what most agents end up needing, whatever their task, each tried on a running app.
sidebar:
  order: 0
---

Recipes for the things most agents end up needing, whatever they're for. Each one starts from a task ("send a digest
once a day"), shows the code that does it, and links the concept pages for the why. The code on each page is the code
that ran: every recipe was tried on an app made with `mfw create`, with the HTTP channel and a real model.

- [After every turn, and when a conversation closes](after-every-turn/): hooks that tell a webhook what happened.
- [Every day at a set time](every-day/): the same digests, sent once a day.
- [Something the model reads in every conversation](context-layer/): a context layer, with a setting an admin
  changes while the agent runs.
- [A turn that returns an object](controller/): an agent another application drives, getting data back instead of text.
- [Who may use which plugin](roles/): roles from the directory, and a plugin offered only to some people.
- [Your company's sign-in](company-sign-in/): the people your login service knows, talking to the agent.
- [Comparing context strategies](context-strategies/): what each one costs, measured from the traces.

A recipe that writes a plugin starts from `mfw plugin create` ([Writing a plugin](../concepts/writing-plugins/)): the
kind it uses is named at the top.
