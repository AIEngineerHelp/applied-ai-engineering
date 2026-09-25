import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { CopyButton } from './CopyButton';

/*
 * A deliberately tiny Markdown renderer that builds React elements directly.
 * No HTML is ever injected: raw text becomes text nodes, so untrusted report
 * content cannot execute. Supported: headings, paragraphs, bold, italic,
 * inline code, fenced code, ordered/unordered lists, blockquotes, rules,
 * simple tables and http(s)/mailto links.
 */

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: { text: string; depth: number }[] }
  | { type: 'quote'; text: string }
  | { type: 'hr' }
  | { type: 'table'; header: string[]; rows: string[][] };

const RE = {
  fence: /^\s*```(.*)$/,
  heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s*>\s?(.*)$/,
  ul: /^(\s*)[-*+]\s+(.*)$/,
  ol: /^(\s*)\d+[.)]\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function isBlockStart(line: string, next: string | undefined): boolean {
  return (
    RE.fence.test(line) ||
    RE.heading.test(line) ||
    RE.hr.test(line) ||
    RE.quote.test(line) ||
    RE.ul.test(line) ||
    RE.ol.test(line) ||
    (line.includes('|') && next !== undefined && RE.tableSep.test(next))
  );
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(RE.fence);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !RE.fence.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      blocks.push({ type: 'code', lang: fence[1].trim(), text: body.join('\n') });
      continue;
    }

    const heading = line.match(RE.heading);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (RE.hr.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (line.includes('|') && lines[i + 1] !== undefined && RE.tableSep.test(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    if (RE.quote.test(line)) {
      const body: string[] = [];
      let m: RegExpMatchArray | null;
      while (i < lines.length && (m = lines[i].match(RE.quote))) {
        body.push(m[1]);
        i++;
      }
      blocks.push({ type: 'quote', text: body.join(' ') });
      continue;
    }

    const ordered = RE.ol.test(line);
    if (ordered || RE.ul.test(line)) {
      const re = ordered ? RE.ol : RE.ul;
      const items: { text: string; depth: number }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(re) ?? lines[i].match(ordered ? RE.ul : RE.ol);
        if (m) {
          items.push({ text: m[2], depth: Math.min(Math.floor(m[1].replace(/\t/g, '  ').length / 2), 3) });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // continuation line of the previous item
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i++;
        } else break;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    blocks.push({ type: 'paragraph', text: para.join(' ') });
  }

  return blocks;
}

const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*(?=[A-Za-z0-9])([^*]*?[A-Za-z0-9.!?)])\*(?![A-Za-z0-9])|\b_([^_\s][^_]*?)_\b|\[([^\]]+)\]\(([^)\s]+)\)/g;

function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${n++}`;
    if (m[2] !== undefined) {
      out.push(
        <code key={key} className="rounded border border-border bg-subtle px-1 py-px font-mono text-[0.85em] text-fg">
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(
        <strong key={key} className="font-semibold text-fg">
          {renderInline(m[3] ?? m[4] ?? '', key)}
        </strong>,
      );
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push(<em key={key}>{renderInline(m[5] ?? m[6] ?? '', key)}</em>);
    } else if (m[7] !== undefined && m[8] !== undefined) {
      const href = safeHref(m[8]);
      out.push(
        href ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
          >
            {renderInline(m[7], key)}
          </a>
        ) : (
          <span key={key}>{m[7]}</span>
        ),
      );
    }
    last = start + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const headingClass: Record<number, string> = {
  1: 'text-[18px] font-semibold mt-8 first:mt-0 mb-3',
  2: 'text-[15px] font-semibold mt-7 first:mt-0 mb-2',
  3: 'text-sm font-semibold mt-6 first:mt-0 mb-2',
  4: 'text-[13px] font-semibold mt-5 first:mt-0 mb-1.5',
  5: 'text-[13px] font-medium mt-4 first:mt-0 mb-1',
  6: 'text-[13px] font-medium text-fg-muted mt-4 first:mt-0 mb-1',
};

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag key={key} className={cn('text-fg', headingClass[block.level])}>
          {renderInline(block.text, `h${key}`)}
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p key={key} className="my-3 first:mt-0">
          {renderInline(block.text, `p${key}`)}
        </p>
      );
    case 'code':
      return (
        <div key={key} className="group relative my-4">
          <pre className="overflow-x-auto rounded-md border border-border bg-subtle py-3 pr-12 pl-3.5 font-mono text-[12px] leading-relaxed text-fg">
            <code>{block.text}</code>
          </pre>
          <CopyButton value={block.text} label="Copy code" className="absolute top-1.5 right-1.5 bg-subtle" />
        </div>
      );
    case 'quote':
      return (
        <blockquote key={key} className="my-4 border-l-2 border-border-strong pl-3.5 text-fg-muted">
          {renderInline(block.text, `q${key}`)}
        </blockquote>
      );
    case 'hr':
      return <hr key={key} className="my-6 border-border" />;
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag
          key={key}
          className={cn('my-3 space-y-1 pl-5', block.ordered ? 'list-decimal' : 'list-disc', 'marker:text-fg-subtle')}
        >
          {block.items.map((item, j) => (
            <li key={j} style={item.depth ? { marginLeft: `${item.depth * 1.25}rem` } : undefined} className="pl-1">
              {renderInline(item.text, `l${key}-${j}`)}
            </li>
          ))}
        </ListTag>
      );
    }
    case 'table':
      return (
        <div key={key} className="my-4 overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="bg-subtle">
              <tr>
                {block.header.map((h, j) => (
                  <th key={j} className="border-b border-border px-3 py-2 font-medium text-fg">
                    {renderInline(h, `th${key}-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b border-border last:border-0">
                  {row.map((cell, c) => (
                    <td key={c} className="px-3 py-2 align-top">
                      {renderInline(cell, `td${key}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return <div className={cn('text-[14px] leading-relaxed text-fg-muted', className)}>{blocks.map(renderBlock)}</div>;
}
