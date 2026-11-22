/** Extract ordinary inline HTTP(S) links, including balanced parentheses in URLs. */
export function markdownCitationLinks(text: string) {
  const links: Array<{ markdown: string; label: string; href: string; index: number }> = [];
  const opener = /(?<![!\\])\[((?:\\.|[^\\[\]\r\n])+)\]\((?=https?:\/\/)/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    const from = opener.lastIndex;
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      const character = text[i]!;
      if (/\s/.test(character)) break;
      if (character === '(') depth++;
      if (character !== ')') continue;
      if (depth > 0) {
        depth--;
        continue;
      }
      links.push({
        markdown: text.slice(match.index, i + 1),
        label: match[1]!,
        href: text.slice(from, i),
        index: match.index,
      });
      opener.lastIndex = i + 1;
      break;
    }
  }
  return links;
}
