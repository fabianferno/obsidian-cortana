// Speech recognition often spells numbers out ("two hours").
const NUMBER_WORDS: [RegExp, string][] = [
  [/\bforty[- ]five\b/g, '45'],
  ...Object.entries({
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
  }).map(([w, n]): [RegExp, string] => [new RegExp(`\\b${w}\\b`, 'g'), String(n)]),
];

export function parseTimeEstimate(input: string, timezone: string, now: Date = new Date()): number | null {
  let text = input.trim().toLowerCase();
  if (!text) return null;
  for (const [re, n] of NUMBER_WORDS) text = text.replace(re, n);

  // "half an hour"
  if (/half\s+an?\s+hour/.test(text)) return 30;

  // "2 and a half hours"
  const andHalf = text.match(/(\d+)\s+and\s+a\s+half\s+(?:hours?|hrs?)\b/);
  if (andHalf) return parseInt(andHalf[1], 10) * 60 + 30;

  // "before lunch" -> until 12:00
  if (/before\s+lunch/.test(text)) {
    return minutesUntilHour(12, timezone, now);
  }

  // "till/until/by Xpm/Xam" -> minutes until that hour
  const tillMatch = text.match(/(?:till|until|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (tillMatch) {
    let hour = parseInt(tillMatch[1], 10);
    const minute = tillMatch[2] ? parseInt(tillMatch[2], 10) : 0;
    const ampm = tillMatch[3];
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return minutesUntilTime(hour, minute, timezone, now);
  }

  // "couple (of) hours"
  if (/couple\s+(?:of\s+)?hours/.test(text)) return 120;

  // "an hour and a half"
  if (/an?\s+hour\s+and\s+a\s+half/.test(text)) return 90;

  // "about an hour" / "an hour" / "one hour"
  if (/(?:about\s+)?(?:an?|one)\s+hour/.test(text)) return 60;

  // "N.N hours/h" or "Nh" or "N hours"
  const hourMatch = text.match(/~?(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/);
  if (hourMatch) return Math.round(parseFloat(hourMatch[1]) * 60);

  // "N min/m/minutes"
  const minMatch = text.match(/~?(\d+)\s*(?:minutes?|mins?|m)\b/);
  if (minMatch) return parseInt(minMatch[1], 10);

  return null;
}

function minutesUntilHour(targetHour: number, timezone: string, now: Date): number | null {
  return minutesUntilTime(targetHour, 0, timezone, now);
}

function minutesUntilTime(targetHour: number, targetMinute: number, timezone: string, now: Date): number | null {
  const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const currentMinutes = nowInTz.getHours() * 60 + nowInTz.getMinutes();
  const targetMinutes = targetHour * 60 + targetMinute;
  const diff = targetMinutes - currentMinutes;
  return diff > 0 ? diff : null;
}
