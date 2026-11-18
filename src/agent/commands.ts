// agent/commands.ts - the slash commands the agent handles itself, for the
// panel's "/" menu. Agent.handleLocally runs them; a test keeps the two in step.

export interface SlashCommand {
  name: string;
  description: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: '/clear', description: 'Start a fresh conversation' },
  { name: '/pause', description: 'Stop check-ins and nudges' },
  { name: '/resume', description: 'Turn check-ins back on' },
  { name: '/status', description: 'Show whether Cortana is paused' },
  { name: '/graduate', description: 'Run the note pass on capture notes now' },
  { name: '/clearboard', description: 'Empty Done and Archive (asks first)' },
  { name: '/undoboard', description: 'Undo the last board repair' },
];

/**
 * Commands for what is typed so far: only while the whole input is a single
 * "/word". Prefix matches first, then commands that contain the letters.
 */
export function matchCommands(input: string): SlashCommand[] {
  const m = input.match(/^\/(\S*)$/);
  if (!m) return [];
  const q = m[1].toLowerCase();
  const name = (c: SlashCommand) => c.name.slice(1);
  const prefix = COMMANDS.filter(c => name(c).startsWith(q));
  const inside = COMMANDS.filter(c => !name(c).startsWith(q) && name(c).includes(q));
  const all = [...prefix, ...inside];
  // Typed in full: nothing left to suggest.
  return all.length === 1 && all[0].name === `/${q}` ? [] : all;
}
