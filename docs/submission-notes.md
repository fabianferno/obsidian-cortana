# Notes for the community directory submission

Answers to what reviewers usually ask, ready to paste. Keep in step with the README
sections "Network use", "Files outside your vault" and "Programs it runs".

## What it does

A voice assistant for the vault. It uses a coding-agent CLI the user already has installed
and signed in (Claude Code, Codex or Antigravity) as its brain, local Whisper for speech
recognition and the operating system's voice for speech. Desktop only (`isDesktopOnly`).

## Programs it runs

It spawns the engine CLI the user picked, with the vault as its working directory, the same
as running it in a terminal there. Nothing is installed or updated by the plugin. The binary
is found on the user's PATH (a login shell is read once to fix PATH when Obsidian starts from
the Dock) or at a path the user sets.

## Network use

No telemetry, no analytics, no accounts of its own.

- **ONNX runtime, one download.** On first use of local speech recognition the plugin
  downloads the ONNX Runtime WASM binary for transformers.js 3.8.1 from
  `cdn.jsdelivr.net` (21 MB). It is not executable JavaScript: the bytes are checked
  against a SHA-256 baked into `main.js` at build time and refused on mismatch, then cached
  in `~/.obsidian-cortana/runtime/`. It is downloaded rather than bundled because it would
  make `main.js` 21 MB larger for users who never use local speech.
- **Whisper model.** Downloaded once from `huggingface.co` by transformers.js and kept in
  the browser cache.
- **Optional cloud voices** (Sarvam, Soniox, ElevenLabs) only when the user picks one and
  adds a key. Keys live in `app.secretStorage`. All HTTP goes through `requestUrl`.
- **Optional local MCP server.** Off by default. When the user turns on "Let other AIs use
  your vault", the plugin listens on `127.0.0.1` (default port 27150) so AI apps on the same
  computer can read the vault and file notes. It never binds to other interfaces, needs a
  bearer token kept in `app.secretStorage`, and refuses requests whose Host or Origin is not
  local (DNS rebinding). The tools cannot read daily notes or the plugin's agent folder, and
  writes go through `vault.process`.

## Files outside the vault

`~/.obsidian-cortana/` holds the agent's working state per vault (focus sessions, recent
messages, check-in times) and the downloaded ONNX runtime. It is outside the vault so sync
and git plugins do not commit it. Deleting it resets the agent.

## Vault writes

Every write inside the vault goes through `app.vault.process`, `vault.create` or
`fileManager` (renames keep links; deletions go to Obsidian's trash, and only after the
user says yes). The engine CLI edits files itself under its own permission rules; with
Claude Code the daily notes folder is blocked by `--disallowedTools` rules.

## Other APIs

- `@electron/remote` `globalShortcut` for the optional "Talk from anywhere" key. It fails
  soft when unavailable.
- Microphone through `getUserMedia`, only while the user is talking to it.
