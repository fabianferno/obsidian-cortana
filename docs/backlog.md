# Backlog

Open threads to pick up later. Newest first.

## Declarative settings (getSettingDefinitions)

From the community review of 0.3.6 (2026-11-19): the settings tab uses `display()`, which
is deprecated since Obsidian 1.13.0, so our settings do not show up in Obsidian's settings
search. Moving to `getSettingDefinitions()` needs either `minAppVersion` 1.13.0 or keeping
`display()` as a fallback, and the tab redraws itself when the engine or voice changes, so
check the declarative API handles fields that depend on other fields. Not urgent: `display()`
still works.

## Product brainstorm: what to offer before the directory launch (paused 2026-11-16)

Where we stopped: the first question was still open.

> Who do you picture installing Cortana in its first month, and what would make them
> still use it a month later?

Context for picking it back up:

- Today Cortana fits people who already have Claude Code, Codex or Antigravity installed
  and signed in, and who run their day from a kanban board in the vault. That is a small
  slice of Obsidian users.
- So the biggest pre-launch choice is direction:
  - **Wider:** make setup easier for people without a coding-agent CLI, for example an
    engine that works with just an API key, a guided first run, and working without a
    board or daily folder.
  - **Deeper:** go further for people who have a CLI, with more of what they already
    use (check-ins, focus, filing notes, the daily note pass).
- Answer the audience question first, then lay out approaches.

## Launch checklist (from the 2026-11-16 readiness review)

Done in 0.3.0:

- Renamed to Cortana: plugin id, repo and home folder (old folder and question
  callouts migrate).
- Setup warnings show once per path.
- The daily note pass is off by default.
- Vault writes go through Obsidian (`VaultOps.process`).
- Fixed a crash when the panel is a background tab, and an agent that could still
  start after the plugin was disabled.

Still open:

- **Name decision.** "Cortana" (and calling the user "Chief") is Microsoft / Halo IP.
  The review bot probably will not reject it, but a takedown after listing is the
  realistic risk. Decide before submitting at community.obsidian.md.
- **README.**
  - Add a GIF or screenshot of the panel near the top. The directory listing shows
    the README, so this matters most for discovery.
  - Credit transformers.js and ONNX Runtime (Apache-2.0, bundled in main.js).
  - Update the install section once the plugin is listed.
- **Manifest:** add `authorUrl`. Add `fundingUrl` only if taking donations.
- **Submission notes:** explain the one-time ONNX WASM download. It is pinned by
  SHA-256 and listed under Network use; reviewers may ask about it.
- **Settings search:** implement `getSettingDefinitions()` so settings show in
  Obsidian's settings search (1.13+). It is currently a lint warning.
- **Internal spec:** `docs/superpowers/specs/` is public in the repo. Keep it or
  move it out.
- **Search:** `src/vault/search.ts` still walks the vault with `fs`. Reads are allowed,
  but `vault.getMarkdownFiles()` would be the idiomatic way.

## Cortana visual

- Currently shipping the classic circle: a thick, darker outer ring with a bright inner
  ring. It is big with a "Hi Chief, I'm Cortana." greeting on the empty panel, and
  small in the top bar once chatting. It uses the theme accent colour.
- The user is looking for a reference for the final look. Tried and rejected:
  - an equalizer whose bars form a woman's head in profile
  - a plain bar spectrum
  - ring options: twin rings, glowing orb, sweeping arc, ring of dots, sonar
- Swapping it means changing the circle's CSS block in `styles.css` and
  `createOrb` in `src/plugin/view.ts`.
- Idea for later: drive the motion from real audio levels. Mic levels are available
  through the VAD while hearing; cloud TTS audio could be analysed while speaking.
  The system voice (speechSynthesis) exposes no levels.
