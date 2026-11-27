/**
 * Server-rendered HTML (D4). Every interpolated value goes through `html`
 * tagged templates, which escape by default; `raw` marks trusted fragments.
 * Names and IDs from Slack are never rendered unescaped.
 */

import type { Installation } from '../store.js';

const RAW = Symbol('raw');

export interface Raw {
  [RAW]: string;
}

export function raw(value: string): Raw {
  return { [RAW]: value };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

type Value = string | number | boolean | null | undefined | Raw | Value[];

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'object') return value[RAW];
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Raw {
  let out = '';
  strings.forEach((part, index) => {
    out += part;
    if (index < values.length) out += render(values[index] as Value);
  });
  return raw(out);
}

export function toString(fragment: Raw): string {
  return fragment[RAW];
}

export function time(ms: number | null): string {
  return ms === null ? '—' : `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/** Thousands with separators, large counts shortened (18.4M). */
export function count(value: number): string {
  const hundredths = Math.round(value / 10_000);
  if (hundredths >= 1_000) return `${(Math.round(value / 100_000) / 10).toFixed(1)}M`;
  if (Math.round(value / 1_000) >= 1_000) return `${(hundredths / 100).toFixed(2)}M`;
  if (value >= 100_000) return `${Math.round(value / 1_000)}k`;
  return value.toLocaleString('en-US');
}

/*
 * Calm Workspace: quiet neutral greys, one indigo accent, hairline borders,
 * 8px radii and tabular numbers. Mobile first: the base targets a 360px
 * phone (top bar, bottom tab bar, "More" sheet); 768px adds the sidebar,
 * 1100px the wide layouts. Light and dark follow the system unless the
 * toggle (admin.js) sets data-theme. State is always a word next to its
 * colour. System fonts and inline SVG only: the CSP allows no external
 * assets. Motion is short and stops under prefers-reduced-motion.
 */
const LIGHT = `color-scheme:light;
--bg:#fbfbfc;--bg-side:#f6f6f8;--surface:#fff;--surface-2:#f4f4f6;--hover:#f1f1f4;--active:#ebebf0;
--border:#e7e7ec;--border-strong:#d5d5dd;--text:#1b1b20;--text-2:#5b5b66;--text-3:#7a7a85;
--accent:#5b57e0;--accent-hover:#4c48d0;--accent-soft:rgb(91 87 224/.1);--accent-text:#4a46c8;--on-accent:#fff;
--ok:#1a8f4e;--warn:#a86400;--err:#d0393b;--idle:#8a8a94;
--shadow-sm:0 1px 2px rgb(16 16 24/.06);--shadow-lg:0 12px 40px rgb(16 16 24/.16),0 2px 6px rgb(16 16 24/.06);
--backdrop:rgb(18 18 26/.32);`;
const DARK = `color-scheme:dark;
--bg:#0e0e11;--bg-side:#111115;--surface:#16161b;--surface-2:#1b1b21;--hover:#1f1f26;--active:#26262e;
--border:#25252d;--border-strong:#33333d;--text:#ececf1;--text-2:#a3a3ae;--text-3:#7c7c87;
--accent:#7d79f2;--accent-hover:#8f8bf7;--accent-soft:rgb(125 121 242/.15);--accent-text:#aaa7ff;--on-accent:#fff;
--ok:#3fbf75;--warn:#e3a33b;--err:#f06464;--idle:#7c7c86;
--shadow-sm:0 1px 2px rgb(0 0 0/.4);--shadow-lg:0 16px 48px rgb(0 0 0/.55),0 2px 8px rgb(0 0 0/.4);
--backdrop:rgb(0 0 0/.55);`;

const STYLE = `
:root{${LIGHT}
--font:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{${DARK}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font:15px/1.5 var(--font);
font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;overflow-x:hidden}
[hidden]{display:none!important}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.01em}
h1{font-size:21px;line-height:1.25}h2{font-size:15px;display:flex;align-items:center;gap:8px}h3{font-size:14px}
h2 .icon{color:var(--text-3)}
p{margin:0 0 12px;max-width:75ch}
a{color:var(--accent-text);text-underline-offset:2px}
code,pre,.id{font-family:var(--mono)}
code{font-size:.86em;background:var(--surface-2);border:1px solid var(--border);border-radius:5px;padding:0 4px;overflow-wrap:anywhere}
.id{font-size:12px;color:var(--text-3);overflow-wrap:anywhere}
:focus{outline:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
::selection{background:var(--accent-soft)}
.icon{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;
stroke-linejoin:round;vertical-align:-.2em}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted{color:var(--text-2)}.faint{color:var(--text-3)}.small{font-size:13px}
.sub{display:block;font-size:12px;color:var(--text-3);font-weight:400;margin-top:2px}
.when{white-space:nowrap}
.skip{position:absolute;left:8px;top:8px;z-index:100;padding:8px 12px;border-radius:8px;background:var(--surface);
box-shadow:var(--shadow-lg)}
.skip:not(:focus){width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);box-shadow:none}
kbd{display:inline-flex;align-items:center;font:11px/1 var(--font);color:var(--text-3);border:1px solid var(--border-strong);
border-radius:4px;padding:3px 5px;background:var(--surface)}

/* buttons: primary by default; quiet, ghost and danger variants */
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 14px;
border-radius:8px;border:1px solid transparent;background:var(--accent);color:var(--on-accent);font:inherit;font-size:14px;
font-weight:500;line-height:1.2;cursor:pointer;text-decoration:none;white-space:nowrap;box-shadow:var(--shadow-sm);
transition:background-color .12s,border-color .12s,color .12s}
button:hover,.button:hover{background:var(--accent-hover);color:var(--on-accent)}
button.quiet,.button.quiet{background:var(--surface);border-color:var(--border-strong);color:var(--text)}
button.quiet:hover,.button.quiet:hover{background:var(--hover)}
button.ghost,.button.ghost{background:transparent;box-shadow:none;color:var(--text-2)}
button.ghost:hover,.button.ghost:hover{background:var(--hover);color:var(--text)}
button.danger{background:var(--err);color:#fff}
button.danger:hover{background:color-mix(in srgb,var(--err) 88%,#000);color:#fff}
.icon-btn,button.icon-btn,details.confirm>summary{position:relative;display:inline-grid;place-items:center;width:44px;
height:44px;min-height:0;padding:0;border-radius:8px;border:1px solid transparent;background:transparent;box-shadow:none;
color:var(--text-2);cursor:pointer;list-style:none;text-decoration:none}
.icon-btn:hover,button.icon-btn:hover,details.confirm>summary:hover{background:var(--hover);color:var(--text)}
.icon-btn.go:hover{color:var(--ok)}.icon-btn.stop:hover{color:var(--warn)}
details.confirm>summary:hover,details.confirm[open]>summary{color:var(--err)}
.icon-btn .count{position:absolute;top:4px;right:2px;min-width:16px;height:16px;padding:0 4px;border-radius:999px;
font-size:10px;font-weight:600;line-height:16px;text-align:center;color:var(--on-accent);background:var(--accent)}
.icon-btn .count.zero{color:var(--text-2);background:var(--active)}
[data-tip]::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 4px);left:50%;z-index:5;padding:4px 8px;
border-radius:6px;font:500 12px/1.2 var(--font);white-space:nowrap;color:var(--text);background:var(--surface);
border:1px solid var(--border);box-shadow:var(--shadow-lg);pointer-events:none;opacity:0;transform:translateX(-50%);
transition:opacity .12s}
[data-tip]:hover::after,[data-tip]:focus-visible::after{opacity:1}
details[open]>summary[data-tip]::after{display:none}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
form.inline{display:inline-flex;gap:8px;align-items:center;margin:0}
details.confirm{position:relative}
details.confirm>summary::-webkit-details-marker{display:none}
.pop{position:absolute;right:0;top:100%;z-index:15;width:min(19rem,calc(100vw - 32px));margin-top:4px;padding:12px;
border-radius:10px;background:var(--surface);border:1px solid var(--border);box-shadow:var(--shadow-lg);white-space:normal;
animation:pop .14s ease-out}
.pop p{font-size:13px;color:var(--text-2);margin:0 0 10px}

/* forms */
input,select,textarea{width:100%;min-height:44px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:8px;
background:var(--surface);color:var(--text);font:16px/1.4 var(--font);min-width:0}
input::placeholder,textarea::placeholder{color:var(--text-3)}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:0;
border-color:transparent;border-radius:8px}
textarea{min-height:140px;resize:vertical;font-family:var(--mono);font-size:13px;line-height:1.55}
input[type=checkbox]{width:18px;height:18px;min-height:0;padding:0;accent-color:var(--accent);vertical-align:-.2em}
input[type=hidden]{display:none}
.field{display:grid;gap:6px;font-size:13px;font-weight:500;color:var(--text);min-width:0}
.field input,.field select,.field textarea{font-weight:400}
fieldset.field{border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:0}
fieldset.field legend{padding:0 4px}
fieldset.field label{display:flex;align-items:center;gap:8px;min-height:32px;font-weight:400;font-family:var(--mono);font-size:13px}
.fields{display:grid;gap:12px}
.fields>button{justify-self:start}
.stack{display:grid;gap:14px}
.stack>div:last-child>button,.stack>button{justify-self:start}

/* status: a dot and a word, never colour alone */
.state{display:inline-flex;flex-direction:column;align-items:flex-start;min-width:0}
.lamp{--c:var(--idle);display:inline-flex;align-items:center;gap:6px;padding:2px 9px 2px 7px;border:1px solid var(--border);
border-radius:999px;background:var(--surface);font-size:12px;font-weight:500;line-height:1.5;color:var(--text-2);white-space:nowrap}
.lamp::before{content:'';width:7px;height:7px;border-radius:50%;flex:none;background:var(--c)}
.lamp.live{--c:var(--ok)}.lamp.wait{--c:var(--warn)}.lamp.off{--c:var(--err)}
.lamp.off{border-color:color-mix(in srgb,var(--err) 35%,var(--border));color:var(--text)}
.lamp.idle::before{background:transparent;border:1.5px dashed var(--c)}
.state .sub{max-width:22rem}
.tag{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:6px;background:var(--surface-2);
border:1px solid var(--border);font:12px/1.6 var(--mono);color:var(--text-2);white-space:nowrap}
.tag.set,.tag.accent{background:var(--accent-soft);border-color:transparent;color:var(--accent-text)}
.badge{font-size:11px;font-weight:500;padding:1px 6px;border-radius:5px;background:var(--surface-2);color:var(--text-3);
border:1px solid var(--border)}
.av{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;background:var(--surface-2);
border:1px solid var(--border);font-size:11px;font-weight:600;color:var(--text-2);flex:none;text-transform:uppercase}
.av.accent{background:var(--accent);border-color:transparent;color:var(--on-accent)}
.av.round{border-radius:50%}

/* app shell: phone first */
.sidebar{display:none}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:4px;height:56px;padding:0 6px 0 12px;
background:color-mix(in srgb,var(--bg) 86%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:10px;min-width:0;flex:1;color:var(--text);text-decoration:none;font-weight:600;font-size:14px}
.brand .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mark{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--accent);color:var(--on-accent);flex:none}
.mark .icon{width:17px;height:17px;stroke-width:2}
.main{padding:16px 16px calc(96px + env(safe-area-inset-bottom));max-width:1180px;margin:0 auto}
/* the blur sits on a pseudo-element: a filtered .tabbar would contain the fixed sheet */
.tabbar{position:fixed;left:0;right:0;bottom:0;z-index:20;display:grid;grid-template-columns:repeat(5,1fr);
padding:4px 4px env(safe-area-inset-bottom)}
.tabbar::before{content:'';position:absolute;inset:0;z-index:-1;background:color-mix(in srgb,var(--surface) 92%,transparent);
-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border-top:1px solid var(--border)}
.tabbar>a,.tabbar>details>summary{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
min-height:52px;color:var(--text-3);font-size:11px;font-weight:500;text-decoration:none;border-radius:8px;cursor:pointer;
list-style:none}
.tabbar summary::-webkit-details-marker{display:none}
.tabbar .icon{width:20px;height:20px}
.tabbar [aria-current=page],.tabbar details[open]>summary{color:var(--accent-text)}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:40;max-height:85vh;overflow:auto;padding:8px 8px
calc(12px + env(safe-area-inset-bottom));border-radius:14px 14px 0 0;background:var(--surface);box-shadow:var(--shadow-lg);
animation:sheetUp .2s ease-out}
.tabbar details[open]::before{content:'';position:fixed;inset:0;z-index:30;background:var(--backdrop)}
.grabber{width:36px;height:4px;border-radius:2px;background:var(--border-strong);margin:2px auto 8px}
.menu-h{padding:8px 10px 4px;font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.03em;text-transform:uppercase}
.menu-item{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%;min-height:44px;padding:6px 10px;border:0;border-radius:7px;
background:none;box-shadow:none;text-align:left;cursor:pointer;font-size:14px;font-weight:400;color:var(--text);text-decoration:none}
.menu-item:hover,.menu-item:focus-visible{background:var(--hover);color:var(--text)}
.menu-item .icon{color:var(--text-3)}
.menu-item .meta{min-width:0;flex:1}
.menu-item .meta .sub{margin:0}
.menu-item .check{margin-left:auto;color:var(--accent-text)}
.menu-item[aria-current=page]{background:var(--active)}
.menu-sep{height:1px;background:var(--border);margin:6px 0}
.menu-item form,.sheet form{display:block}

/* page header */
.crumbs{display:none}
.back{display:inline-flex;align-items:center;gap:4px;min-height:36px;margin:-6px 0 2px -4px;padding:0 4px;color:var(--text-2);
text-decoration:none;font-size:13px;font-weight:500;border-radius:6px}
.back .icon{transform:rotate(180deg)}
.ph{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;margin:4px 0 16px}
.ph-title{flex:1 1 220px;min-width:0}
.ph-title h1{display:flex;align-items:center;gap:10px;flex-wrap:wrap;overflow-wrap:anywhere}
.ph-sub{margin-top:4px;color:var(--text-2);font-size:13px;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}
.ph-actions{display:flex;gap:8px;flex-wrap:wrap}
.lead{color:var(--text-2);font-size:14px;margin:0 0 16px}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin:0 0 16px;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs a{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 10px;margin-bottom:-1px;
border-bottom:2px solid transparent;color:var(--text-2);font-size:14px;font-weight:500;text-decoration:none;white-space:nowrap}
.tabs a:hover{color:var(--text)}
.tabs a[aria-current=page]{color:var(--text);border-bottom-color:var(--accent)}
.seg{display:inline-flex;max-width:100%;overflow-x:auto;padding:2px;gap:2px;border:1px solid var(--border);border-radius:9px;
background:var(--surface-2);scrollbar-width:none}
.seg::-webkit-scrollbar{display:none}
.seg a{display:inline-flex;align-items:center;min-height:40px;padding:0 11px;border-radius:7px;color:var(--text-2);font-size:13px;
font-weight:500;white-space:nowrap;text-decoration:none}
.seg a:hover{color:var(--text)}
.seg a[aria-current=page]{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm)}
.toolbar{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin:0 0 16px}
.toolbar p{margin:0}
.section-h{display:flex;align-items:center;gap:8px;margin:28px 0 10px}
.section-h h2{flex:1}

/* lists */
.list{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin:0 0 16px}
.list>.row:first-child{border-top-left-radius:8px;border-top-right-radius:8px}
.list>.row:last-child{border-bottom-left-radius:8px;border-bottom-right-radius:8px}
.row{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-height:60px;padding:10px 12px;
border-top:1px solid var(--border)}
.row:first-child{border-top:0}
.row:hover{background:var(--hover)}
.row-ic{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:var(--surface-2);
border:1px solid var(--border);color:var(--text-2);flex:none;font-size:11px;font-weight:600;text-transform:uppercase}
.row-ic.ok{color:var(--ok)}.row-ic.wait{color:var(--warn)}.row-ic.off{color:var(--err)}
.row-main{flex:1 1 0;min-width:0}
.row-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-weight:500;font-size:14px;min-width:0;overflow-wrap:anywhere}
.row-title a{color:var(--text);text-decoration:none}
.row-title a:hover{text-decoration:underline}
.row-meta{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;margin-top:2px;font-size:12px;color:var(--text-3)}
.row-meta .id{font-size:11px}
.row-side{display:flex;align-items:center;gap:6px;flex:none}
.row-side:has(.state){flex:1 0 100%;padding-left:44px}
.row-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:2px;flex:1 0 100%;
margin:-4px -6px -6px 0}
.row .row-actions:empty{display:none}
.empty{padding:28px 16px;text-align:center;color:var(--text-3);font-size:13px;margin:0;max-width:none}
a.row-go{color:inherit;text-decoration:none}
.row-details{border-top:1px solid var(--border)}
.row-details:first-child{border-top:0}
.row-details>summary{border-top:0;cursor:pointer;list-style:none}
.row-details>summary::-webkit-details-marker{display:none}
.row-details[open]>summary{background:var(--hover)}
.row-details>pre{margin:0 12px 12px}

/* cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin:0 0 16px;min-width:0}
.card-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border)}
.card-h h2{flex:1}
.card-h p{flex:1 0 100%;max-width:none;margin:0;font-size:13px;color:var(--text-2)}
.card-b{padding:14px}
.card-b>:last-child{margin-bottom:0}
.card-f{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding:12px 14px;border-top:1px solid var(--border)}
.card-f .hint{flex:1 1 200px;font-size:12px;color:var(--text-3);margin:0}
.card>.list{border:0;margin:0;border-radius:0 0 8px 8px}
.card>.table{border:0;margin:0;border-radius:0 0 8px 8px}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0 0 16px}
.stat{display:block;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px;min-width:0;
color:inherit;text-decoration:none}
a.stat:hover{border-color:var(--border-strong)}
.stat-l{font-size:12px;color:var(--text-2);display:flex;align-items:center;gap:6px}
.stat-v{font-size:22px;font-weight:600;letter-spacing:-.02em;margin-top:2px}
.stat-v small{font-size:14px;font-weight:500;color:var(--text-3)}
.stat-s{font-size:12px;color:var(--text-3);margin-top:2px}
.split{display:grid;grid-template-columns:minmax(0,1fr);gap:0 16px}
.kv{display:grid;grid-template-columns:minmax(90px,auto) minmax(0,1fr);gap:8px 16px;font-size:13px;margin:0}
.kv dt{color:var(--text-3)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.spark{display:block;width:100%;height:28px;margin-top:6px}
.spark path{fill:none;stroke:var(--accent);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.spark .area{fill:var(--accent-soft);stroke:none}
.mini-bar{display:flex;height:6px;border-radius:3px;overflow:hidden;gap:2px;margin-top:8px;background:var(--surface-2)}
.mini-bar i{display:block}
.adders{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;margin:0 0 16px}
.adders>details{background:var(--surface);border:1px solid var(--border);border-radius:8px}
.adders>details[open]{grid-column:1/-1}
.adders>details>summary{display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 12px;cursor:pointer;list-style:none;
font-weight:500;font-size:14px}
.adders>details>summary::-webkit-details-marker{display:none}
.adders>details>summary .icon{color:var(--text-3)}
.adders>details>form{padding:4px 12px 14px}

/* tables: label/value rows on phones, a table from 768px */
.table{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin:0 0 16px}
.table table{width:100%;border-collapse:collapse;font-size:13px}
.table thead{display:none}
.table tbody tr{display:block;padding:10px 12px;border-top:1px solid var(--border)}
.table tbody tr:first-child{border-top:0}
.table td{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:3px 0;min-width:0;overflow-wrap:anywhere}
.table td[data-label]::before{content:attr(data-label);color:var(--text-3);flex:none}
.table td:first-child{font-weight:500;font-size:14px}
.table td.empty{display:block;text-align:center}
.table td select{max-width:65%}
.num{text-align:right;font-variant-numeric:tabular-nums}

/* notices */
.notice{--c:var(--accent-text);display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid
color-mix(in srgb,var(--c) 35%,var(--border));border-radius:8px;background:color-mix(in srgb,var(--c) 7%,var(--surface));
font-size:13px;margin:0 0 16px;max-width:none}
.notice::before{content:'';width:8px;height:8px;margin-top:6px;border-radius:50%;flex:none;background:var(--c)}
.notice.ok{--c:var(--ok)}.notice.err{--c:var(--err)}.notice.wait{--c:var(--warn)}
.notice>div{min-width:0;flex:1}
.live-status{font-size:12px;color:var(--text-3);margin:-8px 0 12px}
.secret{display:block;margin-top:6px;padding:10px 12px;border-radius:8px;background:var(--surface);border:1px dashed
var(--border-strong);font:13px var(--mono);overflow-wrap:anywhere;user-select:all}

/* disclosure */
details.disclose>summary{display:flex;align-items:center;gap:6px;min-height:44px;cursor:pointer;list-style:none;font-size:13px;
font-weight:500;color:var(--text-2)}
details.disclose>summary::-webkit-details-marker{display:none}
details.disclose>summary .icon{transition:transform .15s}
details.disclose[open]>summary .icon{transform:rotate(90deg)}
pre{margin:0;padding:12px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border);
font:12px/1.6 var(--mono);overflow:auto;white-space:pre;color:var(--text)}

/* readiness steps */
.circuit{list-style:none;margin:0;padding:0}
.step{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);gap:12px;padding-bottom:18px}
.step::before{content:'';position:absolute;left:13px;top:30px;bottom:2px;width:2px;border-radius:1px;background:var(--border)}
.step:last-child{padding-bottom:0}.step:last-child::before{display:none}
.step.yes::before{background:color-mix(in srgb,var(--ok) 55%,var(--border))}
.jack{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;border:1.5px solid var(--border-strong);
background:var(--surface);color:var(--text-3)}
.jack .icon{width:14px;height:14px;stroke-width:2.2}
.step.yes .jack{border-color:var(--ok);color:var(--ok)}
.step.broken .jack{border-color:var(--err);color:var(--err)}
.step strong{display:flex;align-items:center;min-height:28px;font-weight:500}
.step .sub{font-size:13px;color:var(--text-2);margin-top:0}
.step.broken .sub{margin-top:6px;padding:10px 12px;border-radius:8px;border:1px solid
color-mix(in srgb,var(--err) 30%,var(--border));background:color-mix(in srgb,var(--err) 7%,var(--surface))}
.verdict{margin:0 0 14px}

/* charts */
.chart-plot{position:relative;height:180px;margin-left:36px}
.chart-plot svg{display:block;width:100%;height:100%;overflow:visible}
.chart .grid{stroke:var(--border);stroke-width:1;vector-effect:non-scaling-stroke}
.chart-y{position:absolute;left:-36px;width:30px;transform:translateY(-50%);text-align:right;font-size:11px;color:var(--text-3)}
.chart-x{display:flex;margin:6px 0 0 36px;font-size:11px;color:var(--text-3)}
.chart-x span{flex:1 1 0;min-width:0;text-align:center;white-space:nowrap}
.chart .s-completed{fill:var(--accent)}.chart .s-failed{fill:var(--err)}.chart .s-interrupted{fill:var(--warn)}
.chart g.day:hover rect{opacity:.8}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--text-2);margin-top:10px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:10px;height:10px;border-radius:3px;flex:none}
.sw-completed{background:var(--accent)}.sw-failed{background:var(--err)}.sw-interrupted{background:var(--warn)}
.bar{position:relative;display:inline-block;width:64px;height:6px;border-radius:3px;background:var(--surface-2);overflow:hidden;
vertical-align:middle;margin-left:8px}
.bar>i{position:absolute;inset:0 auto 0 0;border-radius:3px;background:var(--accent)}

/* dialogs: CSS only (:target), so no script is needed */
.modal{position:fixed;inset:0;z-index:50;display:none;align-items:flex-end;justify-content:center}
.modal:target{display:flex}
.modal-bg{position:fixed;inset:0;background:var(--backdrop)}
.modal-card{position:relative;width:100%;max-height:92vh;overflow:auto;padding:16px 16px calc(16px + env(safe-area-inset-bottom));
border-radius:14px 14px 0 0;background:var(--surface);box-shadow:var(--shadow-lg);text-align:left;white-space:normal;
font-weight:400;animation:sheetUp .2s ease-out}
.modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px}

/* command palette (admin.js) */
dialog{color:var(--text);padding:0;border:0}
dialog::backdrop{background:var(--backdrop)}
dialog.palette{position:fixed;margin:8px auto auto;width:calc(100% - 16px);max-width:640px;border-radius:12px;
background:var(--surface);box-shadow:var(--shadow-lg);overflow:hidden;border:1px solid var(--border)}
dialog.palette[open]{animation:pop .14s ease-out}
.pal-in{display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--border)}
.pal-in .icon{color:var(--text-3)}
.pal-in input{flex:1;min-height:52px;border:0;padding:0;background:none;outline:none}
.pal-in input:focus-visible{outline:none}
.pal-list{max-height:min(60vh,440px);overflow:auto;padding:6px;margin:0;list-style:none}
.pal-g{padding:8px 10px 4px;font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.02em}
.pal-o{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 10px;border-radius:7px;cursor:pointer;font-size:14px}
.pal-o .icon{color:var(--text-3)}
.pal-o .t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pal-o .sub{margin:0 0 0 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}
.pal-o[aria-selected=true]{background:var(--accent-soft)}
.pal-o[aria-selected=true] .icon{color:var(--accent-text)}
.pal-foot{display:none;gap:14px;padding:8px 14px;border-top:1px solid var(--border);font-size:12px;color:var(--text-3)}

/* sign-in */
.narrow{max-width:400px;margin:0 auto;padding:12vh 16px 48px}
.narrow .brand{justify-content:center;margin:0 0 24px;font-size:16px}
.narrow h1{text-align:center;margin:0 0 16px}

@keyframes sheetUp{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
@keyframes pop{from{transform:scale(.98);opacity:0}to{transform:none;opacity:1}}

/* tablet: the sidebar replaces the top and tab bars */
@media (min-width:768px){
body{font-size:14px}
.app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}
:root[data-sidebar=collapsed] .app{grid-template-columns:60px minmax(0,1fr)}
.sidebar{display:flex;flex-direction:column;position:sticky;top:0;height:100vh;background:var(--bg-side);
border-right:1px solid var(--border);min-width:0}
.topbar,.tabbar{display:none}
.main{padding:28px 32px 56px;width:100%}
.sb-top{position:relative;padding:10px 10px 6px}
.ws-switch>summary{display:flex;align-items:center;gap:8px;min-height:44px;padding:4px 8px;border-radius:8px;cursor:pointer;list-style:none}
.ws-switch>summary::-webkit-details-marker{display:none}
.ws-switch>summary:hover{background:var(--hover)}
.ws-switch .meta{min-width:0;flex:1}
.ws-switch .nm{display:block;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ws-switch .meta .sub{margin:0;font-size:11px}
.ws-menu{position:absolute;left:10px;right:10px;top:56px;z-index:30;background:var(--surface);border:1px solid var(--border);
border-radius:10px;box-shadow:var(--shadow-lg);padding:6px;min-width:240px;max-height:70vh;overflow:auto}
.sb-search{display:flex;align-items:center;gap:8px;margin:2px 10px 8px;min-height:34px;padding:0 10px;border:1px solid
var(--border);border-radius:8px;background:var(--surface);box-shadow:none;color:var(--text-3);cursor:pointer;font-size:13px;
font-weight:400;justify-content:flex-start;width:calc(100% - 20px)}
.sb-search:hover{background:var(--surface);border-color:var(--border-strong);color:var(--text-2)}
.sb-search kbd{margin-left:auto}
.sb-nav{flex:1;overflow:auto;padding:0 10px 12px}
.sb-group{margin-top:14px}
.sb-h{padding:0 8px 4px;font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.02em;white-space:nowrap;overflow:hidden;
text-overflow:ellipsis}
.sb-link{display:flex;align-items:center;gap:10px;min-height:32px;padding:0 8px;border-radius:7px;color:var(--text-2);
text-decoration:none;font-size:13px;font-weight:500;white-space:nowrap}
.sb-link:hover{background:var(--hover);color:var(--text)}
.sb-link[aria-current=page]{background:var(--active);color:var(--text)}
.sb-link[aria-current=page] .icon{color:var(--accent-text)}
.sb-link .sb-label{overflow:hidden;text-overflow:ellipsis}
.sb-foot{display:flex;align-items:center;gap:2px;padding:10px;border-top:1px solid var(--border)}
.sb-foot .who{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.sb-foot .nm{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-foot .icon-btn{width:32px;height:32px}
:root[data-sidebar=collapsed] :is(.sb-label,.sb-h,.ws-switch .meta,.ws-switch>summary>.icon,.sb-search kbd,.sb-foot .nm){display:none}
:root[data-sidebar=collapsed] .sb-group{margin-top:10px;padding-top:10px;border-top:1px solid var(--border)}
:root[data-sidebar=collapsed] :is(.sb-link,.sb-search,.ws-switch>summary){justify-content:center;padding:0}
:root[data-sidebar=collapsed] .sb-foot{flex-direction:column}
:root[data-sidebar=collapsed] .ws-menu{left:56px;top:8px;right:auto}
.crumbs{display:flex;align-items:center;gap:6px;margin:0 0 6px;font-size:13px;color:var(--text-3);flex-wrap:wrap}
.crumbs a{color:var(--text-2);text-decoration:none;border-radius:4px}
.crumbs a:hover{color:var(--text)}
.crumbs .icon{width:13px;height:13px}
.back{display:none}
h1{font-size:22px}
button,.button{min-height:34px;padding:0 12px;font-size:13px}
.icon-btn,button.icon-btn,details.confirm>summary{width:32px;height:32px}
.icon-btn .count{top:-4px;right:-6px}
input,select,textarea{min-height:34px;padding:6px 10px;font-size:14px}
textarea{min-height:160px;font-size:13px}
.seg a{min-height:30px;padding:0 10px}
.tabs a{min-height:38px;font-size:13px}
.row{flex-wrap:nowrap;min-height:52px;padding:8px 12px}
.row-title{font-size:13px}
.row-actions{flex:none;margin:0}
.row-side:has(.state){flex:none;padding-left:0;justify-content:flex-end;text-align:right}
.row-side .state{align-items:flex-end}
.menu-item{min-height:36px;font-size:13px}
.stats{grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.stat{padding:14px}
.fields{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:end}
.fields>button{justify-self:start;align-self:end}
.adders{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}
.table thead{display:table-header-group}
.table tbody tr{display:table-row;padding:0}
.table th{padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:var(--text-3);border-bottom:1px solid var(--border);
white-space:nowrap}
.table td{display:table-cell;padding:8px 12px;border-top:1px solid var(--border);vertical-align:middle}
.table tbody tr:first-child td{border-top:0}
.table td[data-label]::before{content:none}
.table td:first-child{font-size:13px}
.table tbody tr:hover td{background:var(--hover)}
.table th.num,.table td.num{text-align:right;white-space:nowrap}
.table td select{max-width:none}
.modal{align-items:center;padding:24px}
.modal-card{width:min(520px,100%);max-height:86vh;border-radius:12px;padding:18px 20px 20px;animation-name:pop}
dialog.palette{margin-top:12vh}
.pal-o{min-height:38px}
.pal-foot{display:flex}
.kv{grid-template-columns:minmax(120px,auto) minmax(0,1fr)}
}
@media (min-width:768px) and (hover:hover){
.list .row-actions{opacity:.35;transition:opacity .12s}
.list .row:hover .row-actions,.list .row:focus-within .row-actions{opacity:1}
}
@media (min-width:1100px){
.split{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}
.split.even{grid-template-columns:1fr 1fr}
.main{padding:32px 40px 64px}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media (forced-colors:active){.lamp::before,.sw,.mini-bar i{forced-color-adjust:none}}
`;

/*
 * Stroke icons (24-unit grid, after Lucide, ISC). Inline paths rather than a
 * sprite: every page stays one self-contained document.
 */
const ICONS = {
  logo: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/>',
  overview:
    '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9"/>',
  workspaces:
    '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  costs:
    '<path d="M3 3v18h18"/><path d="M7 16v-4"/><path d="M11 16V8"/><path d="M15 16v-6"/><path d="M19 16V5"/>',
  admins:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  tokens:
    '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  audit:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  config:
    '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
  channels: '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="M16 3l-2 18"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  dashed:
    '<path d="M10.1 2.18a9.93 9.93 0 0 1 3.8 0"/><path d="M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7"/><path d="M21.82 10.1a9.93 9.93 0 0 1 0 3.8"/><path d="M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69"/><path d="M13.9 21.82a9.94 9.94 0 0 1-3.8 0"/><path d="M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7"/><path d="M2.18 13.9a9.93 9.93 0 0 1 0-3.8"/><path d="M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  enable: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  disable: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  userMinus:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6"/>',
  userPlus:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  tools:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  edit: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  login:
    '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  updown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  model:
    '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3"/><path d="M15 1v3"/><path d="M9 20v3"/><path d="M15 20v3"/><path d="M20 9h3"/><path d="M20 14h3"/><path d="M1 9h3"/><path d="M1 14h3"/>',
  prompt: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  bot: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8 14h.01"/><path d="M16 14h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  more: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** A decorative icon; the accessible name comes from text or aria-label next to it. */
export function icon(name: IconName): Raw {
  return raw(
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`,
  );
}

export type Section =
  | 'overview'
  | 'workspaces'
  | 'costs'
  | 'admins'
  | 'tokens'
  | 'audit'
  | 'config';

const ORGANIZATION: Array<[Section, string, string]> = [
  ['workspaces', '/workspaces', 'Workspaces'],
  ['costs', '/costs', 'Costs'],
  ['audit', '/audit', 'Audit log'],
];
const ADMINISTRATION: Array<[Section, string, string]> = [
  ['admins', '/admins', 'Accounts'],
  ['tokens', '/tokens', 'API tokens'],
  ['config', '/config', 'Application settings'],
];

export interface PageContext {
  adminName: string | null;
  csrf: string | null;
  studioUrl?: string | null;
  notice?: { kind: 'ok' | 'err'; text: string } | undefined;
  /** The workspaces of the sidebar switcher. */
  workspaces?: Installation[];
}

export interface PageOptions {
  /** Highlights the matching navigation entry. */
  section?: Section;
  /** The browser tab title when it differs from the heading. */
  windowTitle?: string;
  /** The workspace the page belongs to, and which of its pages it is. */
  workspace?: { installation: Installation; page: 'channels' | 'tools' | null };
  /** Links above the heading, outermost first. */
  crumbs?: Array<[label: string, href: string]>;
  /** A narrow, centred column (sign-in and message pages). */
  narrow?: boolean;
  /** Next to the heading (a status). */
  badge?: Raw;
  /** One line under the heading. */
  sub?: Raw | string;
  /** Buttons on the right of the heading. */
  actions?: Raw;
  /** Page tabs: label, href, current. */
  tabs?: Array<[label: string, href: string, current: boolean]>;
  /**
   * a hidden "changed elsewhere" notice the client shows when
   * one of `topics` changes; the page itself is never replaced (forms keep
   * what the admin typed).
   */
  liveNotice?: {
    topics: string[];
    epoch: string;
    versions: Record<string, number>;
    text: string;
  };
}

/** Initials for an avatar: "Acme Engineering" → "AE". */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2);
  return `${words[0]![0]}${words[1]![0]}`;
}

function workspaceState(row: Installation): [kind: 'live' | 'wait' | 'off' | 'idle', text: string] {
  if (!row.hasToken) return ['off', 'Not paired'];
  if (row.status === 'whitelisted') return ['live', 'Whitelisted'];
  if (row.status === 'disabled') return ['idle', 'Disabled'];
  return ['wait', 'Pending'];
}

function current(on: boolean): Raw {
  return on ? raw('aria-current="page"') : raw('');
}

function signOut(context: PageContext, className: string, label: Raw): Raw {
  return html`<form class="inline" method="post" action="/logout">
    ${csrfField(context.csrf)}<button
      type="submit"
      class="${className}"
      aria-label="Sign out"
      ${className === 'icon-btn' ? raw('data-tip="Sign out"') : ''}
    >
      ${label}
    </button>
  </form>`;
}

function sidebar(context: PageContext, options: PageOptions): Raw {
  const name = context.adminName ?? '';
  const scope = options.workspace?.installation;
  const workspaces = context.workspaces ?? [];
  const link = (section: Section, href: string, label: string) =>
    html`<a
      href="${href}"
      ${current(section === options.section && scope === undefined)}
      class="sb-link"
      >${icon(section)}<span class="sb-label">${label}</span></a
    >`;
  const switcherLabel =
    scope === undefined
      ? html`<span class="mark">${icon('logo')}</span
          ><span class="meta"
            ><span class="nm">Support Agent</span><span class="sub">Admin</span></span
          >`
      : html`<span class="av accent">${initials(scope.teamName || scope.teamId)}</span
          ><span class="meta"
            ><span class="nm">${scope.teamName || scope.teamId}</span
            ><span class="sub">${workspaceState(scope)[1]}</span></span
          >`;
  return html`<aside class="sidebar" aria-label="Navigation">
    <div class="sb-top">
      <details class="ws-switch" data-menu>
        <summary aria-label="Switch workspace">${switcherLabel}${icon('updown')}</summary>
        <div class="ws-menu">
          <div class="menu-h">Workspaces</div>
          ${workspaces.length === 0
            ? html`<p class="sub" style="padding:4px 10px">No workspace yet.</p>`
            : workspaces.map((row) => {
                const [kind, state] = workspaceState(row);
                const label = row.teamName || row.teamId;
                return html`<a
                  class="menu-item"
                  href="${row.hasToken ? `/workspaces/${row.teamId}/channels` : '/workspaces'}"
                  ${current(row.teamId === scope?.teamId)}
                  ><span class="av">${initials(label)}</span
                  ><span class="meta"
                    >${label}<span class="sub"
                      ><span class="lamp ${kind}">${state}</span></span
                    ></span
                  >${row.teamId === scope?.teamId
                    ? html`<span class="check">${icon('check')}</span>`
                    : ''}</a
                >`;
              })}
          <div class="menu-sep"></div>
          <a class="menu-item" href="/workspaces">${icon('workspaces')}All workspaces</a>
          <a class="menu-item" href="/slack/install">${icon('plus')}Add to Slack</a>
        </div>
      </details>
    </div>
    <button type="button" class="sb-search" data-palette-open hidden>
      ${icon('search')}<span class="sb-label">Search or jump to…</span><kbd>Ctrl K</kbd>
    </button>
    <nav class="sb-nav" aria-label="Sections">
      <a href="/" ${current(options.section === 'overview')} class="sb-link"
        >${icon('overview')}<span class="sb-label">Overview</span></a
      >
      ${scope === undefined
        ? ''
        : html`<div class="sb-group">
            <div class="sb-h">${scope.teamName || scope.teamId}</div>
            <a
              href="/workspaces/${scope.teamId}/channels"
              ${current(options.workspace?.page === 'channels')}
              class="sb-link"
              >${icon('channels')}<span class="sb-label">Channels</span></a
            >
            <a
              href="/workspaces/${scope.teamId}/tools"
              ${current(options.workspace?.page === 'tools')}
              class="sb-link"
              >${icon('tools')}<span class="sb-label">Tools, model and prompt</span></a
            >
          </div>`}
      <div class="sb-group">
        <div class="sb-h">Organization</div>
        ${ORGANIZATION.map(([section, href, label]) => link(section, href, label))}
      </div>
      <div class="sb-group">
        <div class="sb-h">Administration</div>
        ${ADMINISTRATION.map(([section, href, label]) => link(section, href, label))}
        ${context.studioUrl == null
          ? ''
          : html`<a
              href="${context.studioUrl}"
              target="_blank"
              rel="noopener noreferrer"
              class="sb-link"
              >${icon('external')}<span class="sb-label">Mastra Studio</span></a
            >`}
      </div>
    </nav>
    <div class="sb-foot">
      <span class="who"
        ><span class="av round" aria-hidden="true">${initials(name)}</span
        ><span class="nm">${name}</span></span
      >
      <button
        type="button"
        class="icon-btn"
        data-theme-toggle
        aria-label="Switch theme"
        data-tip="Theme"
        hidden
      >
        ${icon('moon')}
      </button>
      ${signOut(context, 'icon-btn', icon('logout'))}
      <button
        type="button"
        class="icon-btn"
        data-sidebar-toggle
        aria-label="Collapse sidebar"
        data-tip="Sidebar"
        hidden
      >
        ${icon('panel')}
      </button>
    </div>
  </aside>`;
}

function tabbar(context: PageContext, options: PageOptions): Raw {
  const tab = (section: Section, href: string, label: string, name: IconName) =>
    html`<a href="${href}" ${current(section === options.section)}>${icon(name)}${label}</a>`;
  const more = ADMINISTRATION.some(([section]) => section === options.section);
  return html`<nav class="tabbar" aria-label="Sections">
    ${tab('overview', '/', 'Overview', 'overview')}
    ${tab('workspaces', '/workspaces', 'Workspaces', 'workspaces')}
    ${tab('costs', '/costs', 'Costs', 'costs')} ${tab('audit', '/audit', 'Audit', 'audit')}
    <details data-menu>
      <summary ${more ? raw('aria-current="page"') : ''}>${icon('more')}More</summary>
      <div class="sheet" role="group" aria-label="More">
        <div class="grabber"></div>
        ${ADMINISTRATION.map(
          ([section, href, label]) =>
            html`<a class="menu-item" href="${href}" ${current(section === options.section)}
              >${icon(section)}${label}</a
            >`,
        )}
        ${context.studioUrl == null
          ? ''
          : html`<a
              class="menu-item"
              href="${context.studioUrl}"
              target="_blank"
              rel="noopener noreferrer"
              >${icon('external')}Mastra Studio</a
            >`}
        <div class="menu-sep"></div>
        <button type="button" class="menu-item" data-theme-toggle hidden>
          ${icon('moon')}Switch theme
        </button>
        ${signOut(
          context,
          'menu-item',
          html`${icon('logout')}Sign out (${context.adminName ?? ''})`,
        )}
      </div>
    </details>
  </nav>`;
}

function topbar(options: PageOptions): Raw {
  const scope = options.workspace?.installation;
  return html`<header class="topbar">
    <a class="brand" href="/"
      ><span class="mark">${icon('logo')}</span
      ><span class="t"
        >${scope === undefined ? 'Support Agent' : scope.teamName || scope.teamId}</span
      ></a
    >
    <button type="button" class="icon-btn" data-palette-open aria-label="Search or jump to" hidden>
      ${icon('search')}
    </button>
    <button type="button" class="icon-btn" data-theme-toggle aria-label="Switch theme" hidden>
      ${icon('moon')}
    </button>
  </header>`;
}

const PALETTE = html`<dialog class="palette" id="palette" aria-label="Search or jump to">
  <div class="pal-in">
    ${icon('search')}<input
      type="text"
      id="palette-input"
      placeholder="Search workspaces, channels and pages…"
      autocomplete="off"
      role="combobox"
      aria-expanded="true"
      aria-controls="palette-list"
    />
    <kbd>Esc</kbd>
  </div>
  <ul class="pal-list" id="palette-list" role="listbox" aria-label="Results"></ul>
  <div class="pal-foot"><span>↑↓ choose</span><span>↵ open</span><span>Esc close</span></div>
</dialog>`;

export function page(
  title: string,
  context: PageContext,
  body: Raw,
  options: PageOptions = {},
): string {
  const notice =
    context.notice === undefined
      ? html``
      : html`<div class="notice ${context.notice.kind}" role="status">
          <div>${context.notice.text}</div>
        </div>`;
  const crumbs =
    options.crumbs === undefined || options.crumbs.length === 0
      ? html``
      : html`<nav class="crumbs" aria-label="Breadcrumb">
            ${options.crumbs.map(
              ([label, href], index) =>
                html`${index > 0 ? icon('chevron') : ''}<a href="${href}">${label}</a>`,
            )}
          </nav>
          <a class="back" href="${options.crumbs[options.crumbs.length - 1]![1]}"
            >${icon('chevron')}${options.crumbs[options.crumbs.length - 1]![0]}</a
          >`;
  const tabs =
    options.tabs === undefined
      ? html``
      : html`<nav class="tabs" aria-label="${title}">
          ${options.tabs.map(
            ([label, href, on]) => html`<a href="${href}" ${current(on)}>${label}</a>`,
          )}
        </nav>`;
  const live =
    options.liveNotice === undefined
      ? html``
      : html`<div
            class="notice wait"
            role="status"
            hidden
            data-live-notice
            data-live-topics="${options.liveNotice.topics.join(' ')}"
            data-live-epoch="${options.liveNotice.epoch}"
            data-live-versions="${JSON.stringify(options.liveNotice.versions)}"
          >
            <div>${options.liveNotice.text} <a href="">Reload</a></div>
          </div>
          <p id="live-status" class="live-status" role="status" data-state="off">Updates: off</p>`;
  const header = html`${crumbs}
    <div class="ph">
      <div class="ph-title">
        <h1>${title}</h1>
        ${options.badge === undefined && options.sub === undefined
          ? ''
          : html`<div class="ph-sub">${options.badge ?? ''}${options.sub ?? ''}</div>`}
      </div>
      ${options.actions === undefined ? '' : html`<div class="ph-actions">${options.actions}</div>`}
    </div>
    ${tabs}`;
  const signedIn = context.adminName !== null && options.narrow !== true;
  const document = signedIn
    ? html`<a class="skip" href="#main">Skip to content</a>
        <div class="app">
          ${sidebar(context, options)}
          <div class="content">
            ${topbar(options)}
            <main class="main" id="main" tabindex="-1">${header}${live}${notice}${body}</main>
          </div>
          ${tabbar(context, options)}
        </div>
        ${PALETTE}`
    : html`<main class="narrow" id="main">
        <p class="brand"><span class="mark">${icon('logo')}</span>Support Agent</p>
        <h1>${title}</h1>
        ${notice}${body}
      </main>`;
  return toString(
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <title>${options.windowTitle ?? title} - Support Agent settings</title>
          <style>
            ${raw(STYLE)}
          </style>
          ${raw('<script src="/assets/admin.js"></script>')}
        </head>
        <body>
          ${document}
          ${options.liveNotice !== undefined
            ? raw('<script src="/assets/live.js" defer></script>')
            : ''}
        </body>
      </html>`,
  );
}

/** A status lamp: a coloured dot followed by the state in words. */
export function lamp(
  kind: 'live' | 'wait' | 'off' | 'idle',
  label: string,
  detail?: Raw | string,
): Raw {
  return detail === undefined || detail === ''
    ? html`<span class="lamp ${kind}">${label}</span>`
    : html`<span class="state"
        ><span class="lamp ${kind}">${label}</span><span class="sub">${detail}</span></span
      >`;
}

export function csrfField(csrf: string | null): Raw {
  return csrf === null ? html`` : html`<input type="hidden" name="csrf" value="${csrf}" />`;
}

export interface ButtonLook {
  icon?: IconName;
  /** Only the icon, with the label as accessible name and tooltip. */
  iconOnly?: boolean;
  /** Hover tint of an icon-only button: go (turns something on), stop (off). */
  tone?: 'go' | 'stop';
}

/** A button's content: icon and label, or only the icon named by the label. */
function buttonBody(label: string, look: ButtonLook): Raw {
  return look.icon === undefined
    ? html`${label}`
    : look.iconOnly === true
      ? icon(look.icon)
      : html`${icon(look.icon)}${label}`;
}

/** Attributes of an icon-only control: class, accessible name and tooltip. */
export function iconAttrs(label: string, tone?: 'go' | 'stop'): Raw {
  return html`class="icon-btn ${tone ?? ''}" aria-label="${label}" data-tip="${label}"`;
}

/** A one-button POST form (all state changes are POSTs with a CSRF token). */
export function postButton(
  action: string,
  label: string,
  csrf: string | null,
  fields: Record<string, string> = {},
  variant: 'primary' | 'quiet' | 'danger' = 'primary',
  look: ButtonLook = {},
): Raw {
  const attrs =
    look.iconOnly === true && look.icon !== undefined
      ? iconAttrs(label, look.tone)
      : html`class="${variant === 'primary' ? '' : variant}"`;
  return html`<form class="inline" method="post" action="${action}">
    ${csrfField(csrf)}${Object.entries(fields).map(
      ([name, value]) => html`<input type="hidden" name="${name}" value="${value}" />`,
    )}<button type="submit" ${attrs}>${buttonBody(label, look)}</button>
  </form>`;
}

/**
 * An irreversible POST behind a disclosure: the first click only reveals
 * what will happen and the button that does it (no script needed).
 */
export function confirmButton(
  action: string,
  label: string,
  consequence: string,
  csrf: string | null,
): Raw {
  return html`<details class="confirm" data-menu>
    <summary data-tip="${label}">${icon('trash')}<span class="sr">${label}</span></summary>
    <div class="pop">
      <p>${consequence}</p>
      ${postButton(action, label, csrf, {}, 'danger', { icon: 'trash' })}
    </div>
  </details>`;
}

/** A sparkline of a few values (inline SVG, no script). */
export function sparkline(values: number[], label: string): Raw {
  if (values.length < 2) return html``;
  const width = 200;
  const height = 28;
  const max = Math.max(...values, 1);
  const points = values.map(
    (value, index) =>
      [(index / (values.length - 1)) * width, height - 3 - (value / max) * (height - 6)] as const,
  );
  const line = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  return html`<svg
    class="spark"
    viewBox="0 0 ${width} ${height}"
    preserveAspectRatio="none"
    role="img"
    aria-label="${label}"
  >
    <path class="area" d="${line} L${width} ${height} L0 ${height} Z" />
    <path d="${line}" vector-effect="non-scaling-stroke" />
  </svg>`;
}
