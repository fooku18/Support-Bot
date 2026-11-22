// Shell command parsing used by the deployment guard. A heuristic, not a shell: it finds the simple commands
// an agent typed, so text inside heredocs or quoted strings does not count.

/**
 * The simple commands of a Bash command line: cut at the first heredoc, split
 * at `;`, `&`, `|`, newlines, `(` and `$(`, and drop a leading `sudo`, `env`
 * or `time` and leading `NAME=value` assignments.
 */
export function simpleCommands(cmd) {
  return cmd
    .split(/<<-?\s*['"]?\w+/)[0]
    .split(/(?:^|[;&|\n(]|\$\()\s*/)
    .map((c) => {
      let rest = c.trim();
      for (;;) {
        const next = rest.replace(/^(?:sudo|env|time)\s+/, '').replace(/^\w+=\S*\s+/, '');
        if (next === rest) return rest;
        rest = next;
      }
    })
    .filter(Boolean);
}

/** Commands for the live-test instance (never production). */
export function isTestStack(text) {
  return /\.env\.testing|test:stack|support-agent-test/.test(text);
}

/** Splits one simple command into words, honouring single and double quotes. */
export function shellWords(command) {
  const words = [];
  let word = null;
  let quote = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= '';
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (word !== null) words.push(word);
  return words;
}
