# Backlog

Open threads to pick up later. Newest first.

## Project site, like gbrain.io/personal (added 2026-11-20)

The user wants a public site for Cortana in the style of https://gbrain.io/personal: one
page that says what it is, who it is for and how to get it. Open questions: where it is
hosted, what domain, and whether it waits on the name decision (launch checklist) and the
direction picked in the gbrain thread below, since both change what the page says.

## Declarative settings (getSettingDefinitions)

Done in code (2026-11-20), not yet released: `src/plugin/settings.ts` builds one list of
rows. Obsidian 1.13+ draws it from `getSettingDefinitions()` (so settings show in settings
search), older versions draw the same rows through `display()`. Rows that depend on another
setting use `visible`; changes that add, hide or reword rows call `update()`.
Still to check by hand in Obsidian 1.15: rows show their name and description, switching
engine / listen / speak redraws, voice pickers load, the shortcut recorder works, and
searching "Whisper" or "Soniox" in settings finds the rows.

## More like gbrain Personal: an assistant that works with any AI

**Decided and built 2026-11-20 (not yet released): every AI can reach the vault.** A local
MCP server in the plugin (`src/mcp/`), off by default, 127.0.0.1 only, bearer token. Tools:
get_context, search_notes, read_note, capture_note, remember, add_task, move_task, all
through the existing readers and writers. Checked with the official MCP SDK client
(1.32.2, protocol 2025-11-25) and unit tests for the stateless 2026-07-28 protocol.

Why this over "Cortana drives more engines": the user spends the day in Claude Code, Codex,
Grok and Claude web. Driving more engines only helps inside Obsidian; serving MCP makes the
vault the one memory every app reads and writes, which is what gbrain Personal does. Local
apps work today with no new accounts and nothing sent out.

Next steps, in order:

- Manual check in Obsidian 1.15: turn it on, connect Claude Code with Copy setup, ask it
  "what am I working on" and "note that Maria is moving to Lisbon".
- Web apps (claude.ai, ChatGPT, grok.com, Claude Desktop connectors) call MCP from their
  cloud: they need a public HTTPS URL, and claude.ai / ChatGPT expect OAuth. Options: a
  guide for the user's own tunnel (cloudflared, Tailscale Funnel), or a hosted relay. Both
  break "nothing leaves the computer" and need a Network use entry. Decide before building.
- If Cortana's own engine (Claude Code) is set up with the server at user scope, it sees
  the same tools. Harmless (same rules), but check it does not slow its start.
- Packaged prompts on top (MCP prompts): a brief on a person before a call, a weekly review.

Original notes from 2026-11-18:

Goal from the user: Cortana as a personal assistant that can use any engine as its brain,
closer to https://gbrain.io/personal.

Where we stopped: this question was still open.

> On a normal day, when you are in Grok or Claude web rather than Obsidian, what do you
> wish it already knew or could do?

What the user runs day to day:

- Grok bots, heavily.
- Claude Code for most dev.
- Claude web for research and daily AI needs.
- ChatGPT and Gemini for general questions.
- Gemini and Antigravity for UI work and image generation.
- Others in the audience run OpenClaw and similar agent setups.

What gbrain Personal is (read 2026-11-18):

- One memory at one MCP address. Claude, ChatGPT, Claude Code, Codex, Cursor, OpenClaw,
  Hermes and Grok bots all read and write the same notes (people, projects, decisions).
- Plain markdown files the user can read, correct and export.
- Connectors signed in once: Gmail, calendar, meeting notes, GitHub, Notion.
- Ready-made skills: Learn How I Talk (reads mail, files every person and company, learns
  the user's writing voice), Deep Person Brief (a brief before a call), Inbox Cleanup.
- Repeating skills run on the AI's own scheduled tasks. The AI the user already pays for
  does the thinking.

How Cortana compares today:

- Already there: markdown memory, people notes, personality files, check-ins, filing what
  the user mentions, the daily note pass.
- Opposite direction: Cortana calls an engine (Claude Code, Codex, Antigravity). gbrain is
  called by the AIs.
- Missing: connectors (mail, calendar) and packaged skills.

"Any engine as brain" can mean two builds. Decide which, or the order:

- **Cortana drives more engines.** Only works for things with a CLI or API on the user's
  machine. Candidates: Gemini CLI, Grok through an API key, OpenClaw, a plain API-key
  engine (this is also the "Wider" option in the brainstorm below).
- **Every AI can reach the vault.** The gbrain model: Cortana exposes the vault memory and
  its tested writers (note, people, board, timeline) over MCP. This is the only way Grok,
  Claude web, ChatGPT and Gemini chat can take part, since Cortana cannot drive those apps.
  - Local agents (Claude Code, Codex, Cursor, OpenClaw) can connect on the same machine.
  - Web apps need a public address (a tunnel or a hosted relay). That runs against the
    current "no server" rule and needs a new entry under the README's "Network use".
  - The rules must hold for outside AIs too: never the daily folder, personality edits
    need a yes, the user's lines are never rewritten, vault writes go through `VaultOps`.

Other ideas to weigh once the direction is picked:

- Connectors: calendar and mail read into people notes and the per-turn context.
- Packaged skills on top of the memory: a brief on a person before a call, learn how the
  user writes, a weekly review.
- Importing chats from other AIs (exports from ChatGPT, Claude, Grok) into capture notes.

## Product brainstorm: what to offer before the directory launch

**Decided 2026-11-20: deeper, not wider.** From market research (official plugin stats,
2026-11-20):

- Month-one installers: Obsidian users who already run Claude Code or Codex in their vault.
  It is the dominant AI pattern now: Claudian 2.77M downloads (since 2025-12), Copilot V4
  pivoted to using the Claude Code / Codex login, Agent Client 341k, obsidianmd/obsidian-skills
  53k stars. So there is no need for an API-key engine before launch, and Copilot already
  serves API-key users.
- "No API key, uses your subscription" is no longer a differentiator. Conversational voice
  plus accountability is open: direct "talk to your vault" plugins are all under 2k
  downloads. Pitch: the voice and accountability layer for your Claude Code vault, next to
  Claudian, not against it.
- What keeps them a month later: the daily rhythm (briefing, focus nudges), which needs a
  board. Many in this crowd have none, and the Kanban plugin has not released since
  2024-05-31 (now under community-archive). Built 2026-11-20: Cortana makes a board on
  request (create_board action, "Create a board" command, settings button), does not nag
  when there is none, and the README says the Kanban plugin is optional.
- MCP overlaps with Local REST API (865k, has an MCP server since 2026). Cortana's angle:
  curated memory, people and project filing, guarded writes, not raw file access.
- Launch channels: forum Share & showcase (Plugins), r/ObsidianMD, "Claude Code + Obsidian"
  YouTube creators, obsidianstats weekly round-ups.

Original notes from 2026-11-16:

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

- **Name decision.** Decided 2026-11-20: keep "Cortana" as the product name and id,
  knowing the trademark risk below. Mitigations done: users can rename the assistant
  ("Its name" setting), "Chief" is gone by default ("What it calls you" setting), and the
  README says Cortana is a Microsoft trademark and the project is not affiliated.
  Research 2026-11-20 (not legal advice):
  - Microsoft's CORTANA registrations are live: US 2841558 renewed 2024, US 5176726
    registered 2017. Cortana is still a lead character in Halo: Campaign Evolved (2026).
    So the mark is not abandoned, even though the Windows assistant was retired in 2023.
  - Being open source and free is no defence. Free distribution counts as "use in
    commerce" (Planetary Motion v. Techsplosion), and Neo4j v. PureThink found
    infringement by an open source fork.
  - Microsoft's brand guidelines bar using its marks in the name of a product or app,
    "irrespective of whether ... non-profit".
  - Cortana is a voice assistant, the same kind of product Microsoft's Cortana was, and
    "Chief" plus "Hi Chief, I'm Cortana" copy Halo. Both make confusion more likely.
  - No sign that Microsoft has gone after hobby GitHub projects called Cortana. For
    example, brandonvers/Cortana carries a "not affiliated, Microsoft trademark"
    disclaimer. Microsoft does police its marks: Xbox (pet goods), Age of Empires
    (opposition), Lindows (lawsuits).
  - Obsidian's policy only protects the "Obsidian" mark, so the review will not stop it.
    A complaint would go to GitHub or Obsidian.
  - The plugin id can't change after listing. Renaming later means a new listing, and
    every user has to reinstall.
  - Middle path: a neutral product name and id, and the user can name their own
    assistant (a "What should I call it" setting), with no "Chief" by default.
  - User picked the middle path (2026-11-20). Built: settings "Its name" and "What it
    calls you" (empty = product name / the name in user.md), "Chief" removed, identity.md
    template no longer has a Name section. The product name stays Cortana (see above).
    If it ever has to change: the id, `~/.obsidian-cortana`, the CSS prefix and the
    commands need a migration like 0.3.0's, and existing users keep "Cortana" as their
    assistant name.
  - Candidates checked 2026-11-20 against the Obsidian directory (10,619 plugins) and a
    web search for AI apps. Clash: Hark (Brett Adcock's AI assistant), Keel (Keel Labs,
    local-first markdown AI), Vesper (Vesper AI, check-in coach), Wren (WrenAI), Lumen,
    Echo, Nudge, Tempo, Muse (taken in the directory). Clean so far: Coxswain, Orla
    (only a Shopify marketing tool), Brio (interview coach, business phone line). A
    USPTO search is still worth doing on the final pick.
- **README.**
  - Add a GIF or screenshot of the panel near the top. The directory listing shows
    the README, so this matters most for discovery.
  - Done 2026-11-20: Credits section (transformers.js Apache-2.0, ONNX Runtime MIT, Whisper MIT).
  - Update the install section once the plugin is listed.
- **Manifest:** done 2026-11-20, `authorUrl` added. Add `fundingUrl` only if taking donations.
- **Submission notes:** done 2026-11-20, `docs/submission-notes.md` (ONNX download, local
  MCP server, CLI, files outside the vault). Paste from it when submitting.
- **Settings search:** done in code, waiting on the manual check (see Declarative
  settings above).
- **Internal spec:** decided 2026-11-20, keep it public. It has no personal details, and it
  documents the second-brain design for contributors.
- **Search:** decided 2026-11-20, keep `fs`. Reads through `fs` are allowed (CLAUDE.md), and it
  keeps search testable without Obsidian.

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
