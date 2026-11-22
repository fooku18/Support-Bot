import { markdownCitationLinks } from '../../contracts/markdown-citation.js';

interface Citation {
  source: { sourceType: string; url?: string };
  startIndex?: number;
  endIndex?: number;
}

function linkDestination(url: URL) {
  return url.href.replace(/[()]/g, (character) => (character === '(' ? '%28' : '%29'));
}

/** Use only provider URL annotations with valid, non-overlapping text ranges. */
export function renderInlineCitations(
  text: string,
  citations: Citation[],
  onCitation?: (markdown: string) => void,
) {
  const characters = Array.from(text);
  const rendered: string[] = [];
  // Responses can already emit Markdown links. Never nest another link
  // around or within an existing one, even if the span covers parentheses.
  const links = markdownCitationLinks(text).map(({ markdown, href, index }) => {
    const start = Array.from(text.slice(0, index)).length;
    return { markdown, href, start, end: start + Array.from(markdown).length };
  });
  let offset = 0;
  for (const { source, startIndex, endIndex } of [...citations].sort(
    (a, b) => (a.startIndex ?? -1) - (b.startIndex ?? -1),
  )) {
    if (
      source.sourceType !== 'url' ||
      !source.url ||
      startIndex === undefined ||
      endIndex === undefined ||
      !Number.isSafeInteger(startIndex) ||
      !Number.isSafeInteger(endIndex) ||
      startIndex < offset ||
      endIndex <= startIndex ||
      endIndex > characters.length
    )
      continue;
    const url = URL.parse(source.url);
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      continue;
    const overlapping = links.filter((link) => link.start < endIndex && link.end > startIndex);
    if (overlapping.length) {
      for (const link of overlapping) {
        const destination = link.href && URL.parse(link.href);
        if (destination && linkDestination(destination) === linkDestination(url))
          onCitation?.(link.markdown);
      }
      continue;
    }
    const excerpt = characters.slice(startIndex, endIndex).join('');
    if (!excerpt.trim() || /[\r\n]/.test(excerpt) || excerpt.includes('](')) continue;
    const label = excerpt.replace(/[\\[\]]/g, '\\$&');
    const href = linkDestination(url);
    const markdown = `[${label}](${href})`;
    rendered.push(characters.slice(offset, startIndex).join(''), markdown);
    onCitation?.(markdown);
    offset = endIndex;
  }
  rendered.push(characters.slice(offset).join(''));
  return rendered.join('');
}
