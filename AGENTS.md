# msg-cli

Agent-to-agent messaging for pi sessions. One maildir store on disk, one front end: the pi extension
(`src/extension.ts`: the `msg_list` and `msg_send` tools + live delivery). No CLI, no history: delivered
messages live in the session files, and `lookup` reads those.

## Commands

- `bun install` — dev deps (pi + typebox are peers supplied by pi at runtime; dev copies are for types only)
- `bun run typecheck` — `tsc --noEmit`
- `bun test` — unit tests (`test/*.test.ts`), never touch the real `~/.pi`: pass a temp root
- `bun run check` — both, run before every commit
- `bun run e2e [scenario…]` — real pi sessions on a temp store, real model calls (the list is in README.md)
- `pi -e ./src/extension.ts` — load the extension for one pi run without installing it

## Layout

- `src/core/` — the protocol. Pure functions + plain `node:` fs. No pi imports, no Bun-only APIs
  (the extension runs under Node in the pi CLI and under Bun in pi-web).
- `src/extension.ts` — pi adapter only: lifecycle, delivery, tools. No protocol logic.

## Rules

- No module-level mutable state in the extension: pi may reuse one module for several sessions
  in one process (pi-web). Per-session state lives inside the factory closure.
- Every write to the store is atomic (write to `tmp/`, then `rename`). Readers must tolerate
  missing or half-written neighbours.
- Functions take their root dir / clock / pid probe as arguments, so tests never touch real state.
- Refuse, don't guess: `to` resolves only exact matches, and every refusal is one line saying what to
  do instead.
- Presence records and messages are a contract: pi-web and relay read the store, pi-web and lookup
  render messages from session files (`kind`, `stopped`). Add optional fields, never repurpose one, and
  keep old records and messages parsing (old messages carry `byUser` and `delivery`).
- Functional style: small pure functions, early returns, no classes beyond namespaces.
- Don't add comments that restate code.

## working in a pfs fork

- write only inside your fork. reads are open: other forks and the main folder are someone else's work in progress, so read them, never write there. `pfs ls` says which fork you're in (the `*`)
- commit on your branch (`pfs/<n>-…`) when `bun run check` is clean, and `bun run e2e` too when you touched delivery, lineage or the extension's lifecycle. don't switch branches
- finish clean: everything worth keeping is committed before your final message. `pfs rm` lands commits and nothing else
- never delete a fork's folder by hand, yours or anyone's: `pfs rm` from the main folder is the only way out
- don't push: a fork has your credentials and the network, but the main folder reviews, merges and pushes
- forks are flat: `pfs new` fails in here. if the task needs more hands, say so in your final message
- you may have a parent: the session that started you. blocked on a decision → `msg_send` to `"parent"` with `wait_seconds`. never message other forks' agents, never acknowledge. your final message is your report: your parent gets it when you end
- `bun run check` and `bun run e2e` work in here: tests take a temp root and e2e runs pi with `--no-extensions -e ./src/extension.ts` on a temp `PI_MSG_DIR`, so neither touches the real store or the installed msg
- install nothing: every pi session on this machine, yours included, loads msg from the main folder. no `pi install` / `pi remove`, no edits to `~/.pi/agent/settings.json`, never write to the real store (`~/.pi/agent/msg`). the main folder installs at fan-in
- don't touch `.marbles/`, and edit README.md only where the task says: the main folder does docs and marbles at fan-in. say in your final message what README lines and e2e checks to add
