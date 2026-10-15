# msg-cli

Agent-to-agent messaging for pi sessions. One maildir store on disk, two front ends:
the pi extension (`src/extension.ts`, tools + live delivery) and the `msg` CLI (`src/cli.ts`).

## Commands

- `bun install` — dev deps (pi + typebox are peers supplied by pi at runtime; dev copies are for types only)
- `bun run typecheck` — `tsc --noEmit`
- `bun test` — unit tests (`test/*.test.ts`), never touch the real `~/.pi`: pass a temp root
- `bun run check` — both, run before every commit
- `bun src/cli.ts <cmd>` — the CLI from source
- `pi -e ./src/extension.ts` — load the extension for one pi run without installing it

## Layout

- `src/core/` — the protocol. Pure functions + plain `node:` fs. No pi imports, no Bun-only APIs
  (the extension runs under Node in the pi CLI and under Bun in pi-web).
- `src/extension.ts` — pi adapter only: lifecycle, delivery, tools. No protocol logic.
- `src/cli.ts` — CLI adapter only.

## Rules

- No module-level mutable state in the extension: pi may reuse one module for several sessions
  in one process (pi-web). Per-session state lives inside the factory closure.
- Every write to the store is atomic (write to `tmp/`, then `rename`). Readers must tolerate
  missing or half-written neighbours.
- Functions take their root dir / clock / pid probe as arguments, so tests never touch real state.
- Functional style: small pure functions, early returns, no classes beyond namespaces.
- Don't add comments that restate code.
