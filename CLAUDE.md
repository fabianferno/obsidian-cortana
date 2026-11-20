# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repository.

## What This Is

**Cortana**, an Obsidian desktop plugin you talk to. It uses a coding-agent CLI on the
user's computer (Claude Code by default, Codex or Antigravity) as its brain, listens and
listens with local Whisper and speaks with the OS's own voice (or ElevenLabs / Sarvam /
Soniox), and adds accountability features:
editable personality files, morning/midday/evening check-ins, adaptive nudges, focus tracking
on the kanban Doing column, filing what you mention into notes, and a daily pass that moves
ready capture notes to the notes folder or asks a question inside them. Everything runs
inside Obsidian; there is no hosted server. An optional local MCP server (`src/mcp/`, off by
default, 127.0.0.1 only) lets other AI apps on the same computer use the vault.

Agent state and the local voice runtime live in `~/.obsidian-cortana/` (moved from `~/.obsidian-voice-agent/` on first run), outside the
vault, so sync and git plugins never pick them up.

## Commands

```bash
pnpm install
pnpm test                 # vitest, all tests
pnpm test -- tests/agent.test.ts
pnpm lint                 # eslint with eslint-plugin-obsidianmd (the community review rules)
pnpm typecheck            # tsc --noEmit
pnpm build                # typecheck + production main.js
OBSIDIAN_PLUGIN_DIR=... pnpm dev   # watch, copy main.js/manifest/styles into a vault plugin folder
```

Release: bump `version` in `manifest.json`, `package.json` and `versions.json`, then push a
tag equal to the version (no "v"). `.github/workflows/release.yml` builds and attaches
`main.js`, `manifest.json` and `styles.css`.

## Architecture

- `src/plugin/` - Obsidian side. `main.ts` wires everything; `settings.ts` (settings + tab,
  API keys via `app.secretStorage`); `view.ts` (side panel); `transcript.ts` (panel model,
  implements `VoiceUi`);
  `workspace-watcher.ts` (feeds `src/workspace/trail.ts`: the open note, cursor heading,
  selection and recent notes, sent as an "On screen" section on reply turns only; daily notes
  and the board are filtered out, and the prompt says to use it only when the user points at it.
  The trail also counts minutes typed per note; `src/focus/drift.ts` uses that for gentler
  "time's up" nudges when the user is in the card's note, and one `focus_drift` check-in per
  session (the engine may answer SKIP) when they type 10+ minutes in unrelated notes);
  `global-shortcut.ts` (system-wide "Talk from anywhere" key through Electron's globalShortcut via
  @electron/remote; fails soft; the plugin runs it as one question, then the mic closes).
- `src/agent/agent.ts` - the agent, UI-independent. One engine conversation, turns run one at
  a time (`exclusive`). Local commands (/pause, /clear, /graduate, estimates) short-circuit before
  the engine. Proactive messages (checkpoints, pulses, focus) go out through `deliver`.
- `src/engines/` - CLI adapters. Claude Code stays running between turns (stream-json on
  stdin, `--resume` after an interrupt); Codex and Antigravity run one process per turn and
  resume by id. Codex gets the system prompt as `developer_instructions` on the first turn;
  Antigravity gets it at the top of the first message. `shell-env.ts` fixes PATH for Obsidian
  launched from the Dock. Claude Code gets `--disallowedTools` rules that block the daily folder
  and direct edits to the board and agent folder.
- `src/brain/` - `prompt-builder.ts` (system prompt = personality + rules + actions protocol;
  per-turn [Context] block), `actions.ts` (the `<actions>[...]</actions>` protocol: parse,
  validate, stream filter), `signals.ts`, `priority.ts`.
- `src/agent/graduation.ts` - the daily note pass. A read-only engine session (EngineOptions
  `readOnly`) decides per capture note: `graduate_note`, `ask_note` or `trash_note`; the plugin
  writes. `missingUserLines` refuses any rewrite that drops a line the user wrote. Moves go
  through the injected `VaultOps` (Obsidian's fileManager, so links follow). State lives in the
  store under `graduation`; actions are logged to `<agentFolder>/log.md`.
- `src/vault/ops.ts` - `VaultOps`: every write inside the vault (`process`, an atomic
  read-modify-write, plus `move` and `trash`). The plugin backs it with `app.vault.process` /
  `fileManager`; `fsVaultOps` is the fs version for tests. Writers are async and take `ops`.
- `src/vault/notes.ts` - note shape helpers: find by name or alias, `## Timeline` append, the
  `> [!question] Cortana` callout (old `Voice Agent` callouts still recognized). `src/journal/capture.ts` - the `note` action writer.
- `src/vault/repair.ts` - the `repair_board` action: the engine sends the whole corrected board,
  `checkBoardRepair` refuses it if any card, id, column, frontmatter or settings would be lost or
  known damage (line-number prefixes, doubled checkboxes, double ids) is left. `/undoboard` reverts.
- `src/mcp/` - the local MCP server for other AIs. `server.ts` speaks Streamable HTTP with JSON
  responses, both protocol eras (2025 `initialize` sessions and stateless 2026-07-28 with
  `server/discover` and per-request `_meta`), bearer token, Host/Origin checks. `tools.ts`:
  reads use `findNote` / search (so daily notes and the agent folder stay out), writes are
  agent actions run through `executeVaultActions`; personality edits are not exposed.
  `setup.ts`: the per-app config snippets. Outside writes show in the panel and `log.md`.
- `src/agent/execute-actions.ts` - runs actions through the tested writers. Config edits are
  gated: propose stages (30 min TTL), apply writes, discard drops.
- `src/voice/` - `session.ts` (utterance -> STT -> agent -> sentence chunks -> TTS -> player,
  with interrupts), `vad.ts` (energy VAD), `mic.ts`, `player.ts`, `cloud.ts` (Sarvam, Soniox,
  ElevenLabs), `system.ts` (OS voice via speechSynthesis; the player speaks it in the same
  ordered, stoppable queue), `local/` (Whisper in a Web Worker; worker bundled separately and inlined as text;
  the ONNX WASM binary is downloaded once from jsDelivr and checked against a SHA-256 baked in
  at build time). `../speech/cues.ts` - inline voice cues ("[warm]"): the prompt lists them only
  when the TTS sets `cues` (Soniox v2, ElevenLabs eleven_v3); the panel never shows them and other
  voices get them stripped.
- `src/checkins/scheduler.ts` - daily checkpoints at local HH:MM, missed-checkpoint catch-up,
  adaptive pulse.
- `src/store/store.ts` - small JSON state, persisted by the plugin.
- `src/vault/`, `src/journal/`, `src/config/` - board parser/writer, people/literature notes,
  personality loader/editor, vault layout (`paths.ts`, all folders configurable).
- `src/utils/json.ts` - helpers for reading untrusted JSON without `any`.

### Rules

- The agent NEVER reads or writes the daily notes folder. Search skips it, the prompt forbids
  it, and Claude Code permission rules block it.
- Edits to soul.md, identity.md, user.md, goals.md need the user's yes. memory.md is ungated.
- The user's own lines in a note are never rewritten. Agent additions go to `## Timeline` with a
  source; only the summary under the title is rewritten. Notes are trashed only after a yes.
- `editor.ts` is the only write path for the personality files.
- Files inside the vault are written only through `VaultOps` (`ops.process`), never `fs`, so an
  open note keeps its keystrokes. Reads may use `fs`; `~/.obsidian-cortana` state stays on `fs`.
- Use `window.setTimeout` / `window.setInterval` (popout-safe); tests alias `window` to the
  global object in `tests/setup.ts`.
- HTTP goes through the injected `Http` function (Obsidian's `requestUrl` in the plugin, a
  fake in tests), never `fetch`.
- No telemetry, no self-updating code. Any new network call must be added to the README's
  "Network use" section.
- The MCP server binds 127.0.0.1 only and every tool goes through the rules above. Never
  expose gated config edits, `repair_board` or daily-note reads to outside AIs.

## Testing

Tests in `tests/` (vitest, globals). No live services: engines are faked
(`tests/fixtures/fake-claude.mjs`, `FakeEngine` in `agent.test.ts`), HTTP is injected.
Real-engine end-to-end checks are manual.

## Conventions

- Read the relevant files before editing. Test after writing; never leave failures.
- Simplest working solution. Prefer editing over rewriting whole files.
- ASCII only in code and docs (no em dashes or smart quotes).
