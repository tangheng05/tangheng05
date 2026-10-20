// Builds the profile README graphics in ../assets from config.json and live repo data.
//
//   node generate.mjs                     # fetch repos with GITHUB_TOKEN (CI)
//   node generate.mjs --fixture data.json # use a saved snapshot instead
//
// Every SVG is self-contained: text is converted to paths at build time, so the
// graphics look the same everywhere and never load fonts or call other services.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import opentype from 'opentype.js';
import * as simpleIcons from 'simple-icons';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets');
const config = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// ---------------------------------------------------------------- design tokens

const BANNER = {
  bg: '#072E2E', diamond: '#0B3B3A', mint: '#5CC4B8', teal: '#0E716B',
  cream: '#F4EFE6', muted: '#9FB8B3', bubbleIn: '#D9F2EE', bubbleOut: '#FFFFFF', ink: '#072E2E',
};

const THEMES = {
  dark: {
    bg: '#072E2E', surface: '#0B3B3A', line: '#155250', diamond: '#0A3634',
    text: '#F4EFE6', muted: '#9FB8B3', accent: '#5CC4B8', track: '#123F3D',
    langs: ['#5CC4B8', '#F4EFE6', '#E9B872', '#E07A5F', '#8FB8DE', '#B9A3E3', '#2E9C92', '#5F7F7A'],
  },
  light: {
    bg: '#F3F8F6', surface: '#FFFFFF', line: '#D3E4DF', diamond: '#E6F0EC',
    text: '#072E2E', muted: '#4F6B67', accent: '#0E716B', track: '#E2EEEA',
    langs: ['#0E716B', '#072E2E', '#B7802A', '#C0533A', '#3C6FA6', '#7A5EBF', '#3FA89D', '#9FB8B3'],
  },
};

// ---------------------------------------------------------------- type

const fontFile = (pkg, file) => require.resolve(`@fontsource/${pkg}/files/${file}`);
const loadFont = (pkg, file) => {
  const buf = readFileSync(fontFile(pkg, file));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const F = {
  display: loadFont('bricolage-grotesque', 'bricolage-grotesque-latin-800-normal.woff'),
  heading: loadFont('bricolage-grotesque', 'bricolage-grotesque-latin-700-normal.woff'),
  body: loadFont('inter', 'inter-latin-400-normal.woff'),
  medium: loadFont('inter', 'inter-latin-500-normal.woff'),
  semibold: loadFont('inter', 'inter-latin-600-normal.woff'),
  mono: loadFont('jetbrains-mono', 'jetbrains-mono-latin-500-normal.woff'),
};

const measure = (str, font, size, ls = 0) => font.getAdvanceWidth(str, size, { letterSpacing: ls });

// Text as a filled path. `anchor` works like SVG text-anchor.
function text(str, { font, size, x, y, fill, anchor = 'start', ls = 0, attrs = '' }) {
  const w = measure(str, font, size, ls);
  const left = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
  const d = font.getPath(str, left, y, size, { letterSpacing: ls }).toPathData(1);
  return `<path d="${d}" fill="${fill}"${attrs ? ' ' + attrs : ''}/>`;
}

function wrap(str, font, size, maxWidth, maxLines = Infinity) {
  const lines = [];
  let line = '';
  for (const word of str.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next, font, size) <= maxWidth || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (measure(`${last}…`, font, size) > maxWidth) last = last.replace(/\s*\S+$/, '');
    kept[maxLines - 1] = `${last.replace(/[,.;:]$/, '')}…`;
    return kept;
  }
  return lines;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const svg = (w, h, title, style, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t">
<title id="t">${esc(title)}</title>
<style>${style.replace(/\s+/g, ' ').trim()} @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }</style>
${body}
</svg>
`;

// The rounded-diamond grid from the CheckSen banner. `drift` slowly slides it.
const diamondPattern = (id, color, step = 56, size = 20) => `<pattern id="${id}" width="${step}" height="${step}" patternUnits="userSpaceOnUse">
<rect x="${(step - size) / 2}" y="${(step - size) / 2}" width="${size}" height="${size}" rx="${size / 4}" fill="${color}" transform="rotate(45 ${step / 2} ${step / 2})"/>
</pattern>`;

// ---------------------------------------------------------------- data

const MANIFESTS = {
  cargo: 'Cargo.toml', pkg: 'package.json', req: 'requirements.txt', pyproject: 'pyproject.toml',
  swiftpm: 'Package.swift', dockerfile: 'Dockerfile', compose: 'docker-compose.yml', composeAlt: 'compose.yaml', xcodegen: 'project.yml',
};

async function fetchRepos(login, token) {
  const blobs = Object.entries(MANIFESTS)
    .map(([alias, file]) => `${alias}: object(expression: "HEAD:${file}") { ... on Blob { text } }`).join('\n');
  const query = `query($login: String!, $cursor: String) {
    user(login: $login) {
      repositories(first: 50, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false, orderBy: {field: PUSHED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name description url stargazerCount isArchived
          primaryLanguage { name color }
          languages(first: 20, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } }
          repositoryTopics(first: 20) { nodes { topic { name } } }
          root: object(expression: "HEAD:") { ... on Tree { entries { name } } }
          ${blobs}
        }
      }
    }
  }`;
  const repos = [];
  let cursor = null;
  do {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': `${login}-profile` },
      body: JSON.stringify({ query, variables: { login, cursor } }),
    });
    const json = await res.json();
    if (!res.ok || json.errors) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
    const page = json.data.user.repositories;
    for (const r of page.nodes) {
      if (r.isArchived) continue;
      const files = {};
      for (const [alias, file] of Object.entries(MANIFESTS)) if (r[alias]?.text) files[file] = r[alias].text;
      repos.push({
        name: r.name, description: r.description, url: r.url, stars: r.stargazerCount,
        primaryLanguage: r.primaryLanguage,
        languages: r.languages.edges.map((e) => ({ name: e.node.name, color: e.node.color, size: e.size })),
        topics: r.repositoryTopics.nodes.map((n) => n.topic.name),
        rootEntries: (r.root?.entries ?? []).map((e) => e.name),
        files,
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return repos;
}

// ---------------------------------------------------------------- analysis

// Ranks languages by sqrt(bytes) * sqrt(repos), so one huge repo can't drown out
// a language used across many projects.
function rankLanguages(repos) {
  const { ignore = [], ignoreRepos = [], max = 7 } = config.languages;
  const acc = new Map();
  for (const repo of repos) {
    if (ignoreRepos.includes(repo.name)) continue;
    for (const { name, size } of repo.languages) {
      if (ignore.includes(name)) continue;
      const e = acc.get(name) ?? { name, bytes: 0, repos: 0 };
      e.bytes += size;
      e.repos += 1;
      acc.set(name, e);
    }
  }
  const scored = [...acc.values()].map((e) => ({ ...e, score: Math.sqrt(e.bytes) * Math.sqrt(e.repos) }))
    .sort((a, b) => b.score - a.score);
  const total = scored.reduce((s, e) => s + e.score, 0) || 1;
  const top = scored.slice(0, max).map((e) => ({ name: e.name, pct: (e.score / total) * 100 }));
  const rest = scored.slice(max).reduce((s, e) => s + e.score, 0);
  if (rest > 0) top.push({ name: 'Other', pct: (rest / total) * 100 });
  return top;
}

function dependencies(files) {
  const deps = new Set();
  const pkg = files['package.json'];
  if (pkg) {
    try {
      const p = JSON.parse(pkg);
      for (const k of Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies })) deps.add(k.toLowerCase());
    } catch { /* not valid JSON, skip it */ }
  }
  const cargo = files['Cargo.toml'];
  if (cargo) {
    let section = '';
    for (const raw of cargo.split('\n')) {
      const line = raw.trim();
      const head = line.match(/^\[([^\]]+)\]$/);
      if (head) {
        section = head[1];
        const table = section.match(/(?:^|\.)(?:dev-|build-)?dependencies\.([\w-]+)$/);
        if (table) deps.add(table[1].toLowerCase());
        continue;
      }
      if (/(?:^|\.)(?:dev-|build-)?dependencies$/.test(section)) {
        const m = line.match(/^([\w-]+)\s*=/);
        if (m) deps.add(m[1].toLowerCase());
      }
    }
  }
  for (const file of ['requirements.txt']) {
    for (const line of (files[file] ?? '').split('\n')) {
      const name = line.trim().split(/[=<>~!\[;\s]/)[0];
      if (name && !name.startsWith('#') && !name.startsWith('-')) deps.add(name.toLowerCase());
    }
  }
  for (const m of (files['pyproject.toml'] ?? '').matchAll(/["']([A-Za-z0-9_.-]+)\s*[<>=~!\[;"']/g)) deps.add(m[1].toLowerCase());
  return deps;
}

// Each rule adds one icon when a repo matches any of its conditions.
const STACK_RULES = [
  { icon: 'rust', langs: ['Rust'], files: ['Cargo.toml'] },
  { icon: 'typescript', langs: ['TypeScript'], deps: ['typescript'] },
  { icon: 'swift', langs: ['Swift'], files: ['Package.swift'] },
  { icon: 'python', langs: ['Python'], files: ['requirements.txt', 'pyproject.toml'] },
  { icon: 'javascript', langs: ['JavaScript'] },
  { icon: 'nodedotjs', files: ['package.json'] },
  { icon: 'react', deps: ['react'] },
  { icon: 'nextdotjs', deps: ['next'] },
  { icon: 'vuedotjs', langs: ['Vue'], deps: ['vue'] },
  { icon: 'tailwindcss', deps: ['tailwindcss'] },
  { icon: 'express', deps: ['express'] },
  { icon: 'tokio', deps: ['tokio'] },
  { icon: 'postgresql', deps: ['pg', 'postgres', 'psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg', 'tokio-postgres', 'diesel'], text: /postgres/i, name: /postgres/i },
  { icon: 'prisma', deps: ['prisma', '@prisma/client'] },
  { icon: 'redis', deps: ['redis', 'ioredis', '@upstash/redis'] },
  { icon: 'sqlite', deps: ['better-sqlite3', 'sqlite3', 'rusqlite'] },
  { icon: 'docker', files: ['Dockerfile', 'docker-compose.yml', 'compose.yaml'] },
  { icon: 'telegram', deps: ['teloxide', 'python-telegram-bot', 'aiogram', 'telegraf', 'grammy', 'node-telegram-bot-api'] },
  { icon: 'discord', deps: ['discord.js', 'discord.py', 'py-cord', 'nextcord'] },
  { icon: 'fastapi', deps: ['fastapi'] },
  { icon: 'flask', deps: ['flask'] },
  { icon: 'ffmpeg', deps: ['fluent-ffmpeg', 'ffmpeg-static', '@ffmpeg-installer/ffmpeg'], topics: ['ffmpeg'] },
  { icon: 'stripe', deps: ['stripe', 'async-stripe'], topics: ['stripe'], text: /stripe/i },
  { icon: 'googlegemini', deps: ['google-genai', 'google-generativeai', '@google/genai', '@google/generative-ai'], text: /gemini/i },
  { icon: 'claude', deps: ['anthropic', '@anthropic-ai/sdk'] },
  { icon: 'xcode', rootExt: ['.xcodeproj', '.xcworkspace'], files: ['project.yml'] },
  { icon: 'homebrew', name: /^homebrew-/ },
  { icon: 'qt', langs: ['QML'] },
  { icon: 'ubuntu', name: /ubuntu/i, topics: ['ubuntu-touch'] },
  { icon: 'dotnet', langs: ['C#'] },
  { icon: 'gnubash', langs: ['Shell'] },
  { icon: 'vite', deps: ['vite'] },
  { icon: 'threedotjs', deps: ['three'] },
  { icon: 'socketdotio', deps: ['socket.io', 'socket.io-client'] },
  { icon: 'pandas', deps: ['pandas'] },
];

const ICONS = new Map(Object.values(simpleIcons).filter((i) => i?.slug).map((i) => [i.slug, i]));

function detectStack(repos) {
  const { ignore = [], always = [], ignoreRepos = [], max = 18 } = config.stack;
  const counts = new Map();
  for (const repo of repos) {
    if (ignoreRepos.includes(repo.name)) continue;
    const deps = dependencies(repo.files);
    const langs = new Set(repo.languages.map((l) => l.name));
    if (repo.primaryLanguage) langs.add(repo.primaryLanguage.name);
    const manifestText = Object.values(repo.files).join('\n');
    for (const rule of STACK_RULES) {
      const hit = (rule.langs ?? []).some((l) => langs.has(l))
        || (rule.files ?? []).some((f) => f in repo.files)
        || (rule.deps ?? []).some((d) => deps.has(d))
        || (rule.topics ?? []).some((t) => repo.topics.includes(t))
        || (rule.rootExt ?? []).some((ext) => repo.rootEntries.some((e) => e.endsWith(ext)))
        || (rule.name?.test(repo.name) ?? false)
        || (rule.text?.test(manifestText) ?? false);
      if (hit) counts.set(rule.icon, (counts.get(rule.icon) ?? 0) + 1);
    }
  }
  for (const slug of always) counts.set(slug, Math.max(counts.get(slug) ?? 0, 1));
  const order = STACK_RULES.map((r) => r.icon);
  return [...counts.entries()]
    .filter(([slug]) => !ignore.includes(slug) && ICONS.has(slug))
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .slice(0, max)
    .map(([slug, repoCount]) => ({ slug, title: ICONS.get(slug).title, path: ICONS.get(slug).path, repos: repoCount }));
}

// ---------------------------------------------------------------- header

function header() {
  const W = 1200, H = 320, B = BANNER;
  const roles = config.roles.map((r, i) => `<g class="role r${i}">${text(r, { font: F.medium, size: 26, x: 72, y: 246, fill: B.muted })}</g>`).join('');
  const handleW = measure(config.handle, F.mono, 20);

  // Chat bubbles on the right, in the style of the CheckSen banner.
  const right = 1128;
  const qSize = 19, qW = measure(config.chat.question, F.medium, qSize);
  const q = { w: qW + 44, h: 52 };
  const qx = right - q.w, qy = 52;

  const aW = 420, aX = right - aW - 24, aY = qy + q.h + 18;
  const lines = wrap(config.chat.answer, F.body, 18, aW - 48);
  const aH = 30 + 30 + lines.length * 28 + 6;
  const bubble = (x, y, w, h, tail) => {
    // Rounded rect with one tighter corner, like a chat bubble's tail.
    const r = 20, t = 6;
    const [tl, tr, br, bl] = tail === 'right' ? [r, r, t, r] : [r, r, r, t];
    return `M${x + tl},${y} H${x + w - tr} Q${x + w},${y} ${x + w},${y + tr} V${y + h - br} Q${x + w},${y + h} ${x + w - br},${y + h} H${x + bl} Q${x},${y + h} ${x},${y + h - bl} V${y + tl} Q${x},${y} ${x + tl},${y} Z`;
  };
  const typingY = aY;
  const answerLines = lines.map((l, i) => text(l, { font: F.body, size: 18, x: aX + 24, y: aY + 66 + i * 28, fill: B.ink })).join('');

  const style = `
    .drift { animation: drift 24s linear infinite; }
    @keyframes drift { to { transform: translate(56px, -56px); } }
    .glow { animation: glow 6s ease-in-out infinite alternate; }
    @keyframes glow { from { opacity: .55; } to { opacity: 1; } }
    .up { animation: up .9s cubic-bezier(.2,.7,.2,1) both; }
    .d1 { animation-delay: .15s; } .d2 { animation-delay: .3s; }
    @keyframes up { from { opacity: 0; transform: translateY(16px); } }
    .caret { animation: blink 1.1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .role { opacity: 0; animation: role 12s ease-in-out infinite both; }
    .r0 { opacity: 1; animation-delay: .3s; } .r1 { animation-delay: 4.3s; } .r2 { animation-delay: 8.3s; }
    @keyframes role { 0% { opacity: 0; transform: translateY(10px); } 4%, 29% { opacity: 1; transform: none; } 33%, 100% { opacity: 0; transform: translateY(-10px); } }
    .pop { transform-box: fill-box; animation: pop .6s cubic-bezier(.2,.9,.3,1.2) both; }
    .q { transform-origin: right bottom; animation-delay: 1s; }
    .a { transform-origin: left bottom; animation-delay: 3.1s; }
    @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.94); } }
    .typing { opacity: 0; animation: typing 1.5s 1.6s both; }
    @keyframes typing { 0% { opacity: 0; } 15%, 85% { opacity: 1; } 100% { opacity: 0; } }
    .dot { transform-box: fill-box; transform-origin: center; animation: bounce .9s ease-in-out infinite; }
    .dot:nth-child(2) { animation-delay: .15s; } .dot:nth-child(3) { animation-delay: .3s; }
    @keyframes bounce { 0%, 100% { transform: translateY(0); opacity: .45; } 50% { transform: translateY(-4px); opacity: 1; } }`;

  const body = `<defs>
${diamondPattern('dia', B.diamond)}
<clipPath id="card"><rect width="${W}" height="${H}" rx="24"/></clipPath>
<radialGradient id="g1" cx="0.82" cy="0.1" r="0.55"><stop offset="0" stop-color="${B.mint}" stop-opacity=".22"/><stop offset="1" stop-color="${B.mint}" stop-opacity="0"/></radialGradient>
<linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="${B.bg}" stop-opacity=".85"/><stop offset=".55" stop-color="${B.bg}" stop-opacity="0"/></linearGradient>
</defs>
<g clip-path="url(#card)">
<rect width="${W}" height="${H}" fill="${B.bg}"/>
<g class="drift"><rect x="-112" y="-56" width="${W + 224}" height="${H + 168}" fill="url(#dia)"/></g>
<rect width="${W}" height="${H}" fill="url(#fade)"/>
<rect class="glow" width="${W}" height="${H}" fill="url(#g1)"/>
</g>
<g class="up">${text(config.handle, { font: F.mono, size: 20, x: 72, y: 92, fill: B.mint })}<rect class="caret" x="${72 + handleW + 4}" y="76" width="10" height="20" rx="2" fill="${B.mint}"/></g>
<g class="up d1">${text(config.name, { font: F.display, size: 104, x: 68, y: 196, fill: B.cream, ls: -0.02 })}</g>
<g class="up d2">${roles}</g>
<path class="pop q" d="${bubble(qx, qy, q.w, q.h, 'right')}" fill="${B.bubbleIn}"/>
<g class="pop q">${text(config.chat.question, { font: F.medium, size: qSize, x: qx + 22, y: qy + 33, fill: B.ink })}</g>
<g class="typing"><path d="${bubble(aX, typingY, 84, 48, 'left')}" fill="${B.bubbleOut}"/><g>${[0, 1, 2].map((i) => `<circle class="dot" cx="${aX + 26 + i * 16}" cy="${typingY + 24}" r="5" fill="${B.teal}"/>`).join('')}</g></g>
<g class="pop a"><path d="${bubble(aX, aY, aW, aH, 'left')}" fill="${B.bubbleOut}"/>
<circle cx="${aX + 33}" cy="${aY + 33}" r="8" fill="${B.mint}"/><path d="M${aX + 29} ${aY + 33.5} l3 3 l5.5 -6" fill="none" stroke="${B.ink}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
${text(config.chat.answerTitle, { font: F.heading, size: 20, x: aX + 50, y: aY + 40, fill: B.teal })}
${answerLines}</g>`;
  return svg(W, H, `${config.name}: ${config.roles.join(', ')}`, style, body);
}

// ---------------------------------------------------------------- footer

function footer() {
  const W = 1200, H = 150, B = BANNER;
  const handleW = measure(config.handle, F.mono, 18);
  // A slow wave along the bottom edge, two periods wide so it can loop seamlessly.
  const period = 240, amp = 7, base = H - 26;
  let d = `M${-period} ${base}`;
  for (let x = -period; x < W + period; x += period / 2) {
    const dir = ((x + period) / (period / 2)) % 2 === 0 ? -1 : 1;
    d += ` Q${x + period / 4} ${base + dir * amp * 2} ${x + period / 2} ${base}`;
  }
  const style = `
    .drift { animation: drift 24s linear infinite; }
    @keyframes drift { to { transform: translate(56px, -56px); } }
    .wave { animation: wave 9s linear infinite; }
    @keyframes wave { to { transform: translateX(${period}px); } }
    .caret { animation: blink 1.1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }`;
  const body = `<defs>
${diamondPattern('dia', B.diamond)}
<clipPath id="card"><rect width="${W}" height="${H}" rx="24"/></clipPath>
<radialGradient id="g1" cx="0.1" cy="0.9" r="0.6"><stop offset="0" stop-color="${B.mint}" stop-opacity=".18"/><stop offset="1" stop-color="${B.mint}" stop-opacity="0"/></radialGradient>
<linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="${B.bg}" stop-opacity=".85"/><stop offset=".6" stop-color="${B.bg}" stop-opacity="0"/></linearGradient>
</defs>
<g clip-path="url(#card)">
<rect width="${W}" height="${H}" fill="${B.bg}"/>
<g class="drift"><rect x="-112" y="-56" width="${W + 224}" height="${H + 168}" fill="url(#dia)"/></g>
<rect width="${W}" height="${H}" fill="url(#fade)"/>
<rect width="${W}" height="${H}" fill="url(#g1)"/>
<path class="wave" d="${d}" fill="none" stroke="${B.mint}" stroke-opacity=".45" stroke-width="2"/>
</g>
${text(config.footer.title, { font: F.heading, size: 38, x: 72, y: 72, fill: B.cream })}
${text(config.footer.subtitle, { font: F.medium, size: 17, x: 72, y: 104, fill: B.muted })}
${text(config.handle, { font: F.mono, size: 18, x: 1128 - 14, y: 72, fill: B.mint, anchor: 'end' })}
<rect class="caret" x="${1128 - 9}" y="58" width="9" height="18" rx="2" fill="${B.mint}"/>
<desc>${esc(config.handle)} is ${handleW.toFixed(0)}px wide.</desc>`;
  return svg(W, H, `${config.footer.title} ${config.footer.subtitle}`, style, body);
}

// ---------------------------------------------------------------- cards

const cardFrame = (W, H, t) => `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="18" fill="${t.surface}" stroke="${t.line}"/>`;
const cardHead = (W, title, meta, t) =>
  text(title, { font: F.heading, size: 24, x: 28, y: 50, fill: t.text })
  + text(meta, { font: F.mono, size: 13, x: W - 28, y: 48, fill: t.muted, anchor: 'end' });

const cardStyle = `
  .grow { transform-box: fill-box; transform-origin: left center; animation: grow 1s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes grow { from { transform: scaleX(0); } }
  .up { animation: up .7s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes up { from { opacity: 0; transform: translateY(8px); } }`;

function languagesCard(langs, repoCount, theme) {
  const t = THEMES[theme], W = 480, H = 328;
  const colorOf = (i, name) => (name === 'Other' ? t.langs[7] : t.langs[i % 7]);
  const barX = 28, barW = W - 56, barY = 78, barH = 12;
  let x = barX;
  const segs = langs.map((l, i) => {
    const w = (l.pct / 100) * barW;
    const seg = `<rect class="grow" style="animation-delay:${(i * 0.08).toFixed(2)}s" x="${x.toFixed(2)}" y="${barY}" width="${Math.max(w - 2, 1).toFixed(2)}" height="${barH}" fill="${colorOf(i, l.name)}"/>`;
    x += w;
    return seg;
  }).join('');
  const maxPct = Math.max(...langs.map((l) => l.pct));
  const colW = (barW - 32) / 2;
  const rows = langs.map((l, i) => {
    const cx = barX + (i % 2) * (colW + 32);
    const y = 136 + Math.floor(i / 2) * 50;
    const delay = (0.3 + i * 0.07).toFixed(2);
    const track = `<rect x="${cx}" y="${y + 12}" width="${colW}" height="4" rx="2" fill="${t.track}"/>`
      + `<rect class="grow" style="animation-delay:${delay}s" x="${cx}" y="${y + 12}" width="${((l.pct / maxPct) * colW).toFixed(2)}" height="4" rx="2" fill="${colorOf(i, l.name)}"/>`;
    return `<g class="up" style="animation-delay:${delay}s">
<circle cx="${cx + 5}" cy="${y - 5}" r="5" fill="${colorOf(i, l.name)}"/>
${text(l.name, { font: F.medium, size: 15, x: cx + 18, y, fill: t.text })}
${text(`${l.pct.toFixed(1)}%`, { font: F.mono, size: 13, x: cx + colW, y, fill: t.muted, anchor: 'end' })}
${track}</g>`;
  }).join('');
  const body = `${cardFrame(W, H, t)}
${cardHead(W, 'Languages', `${repoCount} public repos`, t)}
<clipPath id="bar"><rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}"/></clipPath>
<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${t.track}"/>
<g clip-path="url(#bar)">${segs}</g>
${rows}`;
  return svg(W, H, `Languages: ${langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ')}`, cardStyle, body);
}

function stackCard(stack, theme) {
  const t = THEMES[theme], W = 480, H = 328;
  const cols = 6, tile = 54, gap = (W - 56 - cols * tile) / (cols - 1), rowH = 80, top = 78;
  const tiles = stack.map((s, i) => {
    const x = 28 + (i % cols) * (tile + gap), y = top + Math.floor(i / cols) * rowH;
    let size = 12;
    while (measure(s.title, F.medium, size) > tile + gap - 4 && size > 9) size -= 0.5;
    const scale = 26 / 24;
    return `<g class="up" style="animation-delay:${(i * 0.04).toFixed(2)}s">
<rect x="${x}" y="${y}" width="${tile}" height="${tile}" rx="14" fill="${t.bg}" stroke="${t.line}"/>
<path transform="translate(${x + (tile - 26) / 2} ${y + (tile - 26) / 2}) scale(${scale.toFixed(4)})" d="${s.path}" fill="${t.text}"/>
${text(s.title, { font: F.medium, size, x: x + tile / 2, y: y + tile + 17, fill: t.muted, anchor: 'middle' })}</g>`;
  }).join('');
  const body = `${cardFrame(W, H, t)}
${cardHead(W, 'Tech stack', 'tools I use most', t)}
${tiles}`;
  return svg(W, H, `Tech stack: ${stack.map((s) => s.title).join(', ')}`, cardStyle, body);
}

function featuredCard(entry, repo, langColor, theme) {
  const t = THEMES[theme], W = 480, H = 172;
  const desc = wrap(entry.blurb ?? repo.description ?? '', F.body, 15, W - 56, 2);
  const lang = repo.primaryLanguage?.name;
  const star = (x, y, r) => {
    const pts = Array.from({ length: 10 }, (_, i) => {
      const a = (Math.PI / 5) * i - Math.PI / 2, rr = i % 2 ? r * 0.45 : r;
      return `${(x + rr * Math.cos(a)).toFixed(2)},${(y + rr * Math.sin(a)).toFixed(2)}`;
    });
    return `<polygon points="${pts.join(' ')}" fill="${t.muted}" stroke="${t.muted}" stroke-width="1.2" stroke-linejoin="round"/>`;
  };
  const langW = lang ? measure(lang, F.medium, 13) : 0;
  const starX = lang ? 28 + 18 + langW + 22 : 28;
  const body = `${cardFrame(W, H, t)}
<rect x="30" y="30" width="12" height="12" rx="3" fill="${t.accent}" transform="rotate(45 36 36)"/>
${text(repo.name, { font: F.heading, size: 24, x: 56, y: 45, fill: t.text })}
<path d="M${W - 44} 40 l10 -10 m-7 0 h7 v7" fill="none" stroke="${t.muted}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
${desc.map((l, i) => text(l, { font: F.body, size: 15, x: 28, y: 84 + i * 23, fill: t.muted })).join('')}
${lang ? `<circle cx="34" cy="${H - 33}" r="6" fill="${langColor}"/>${text(lang, { font: F.medium, size: 13, x: 46, y: H - 28, fill: t.text })}` : ''}
${star(starX + 6, H - 33, 7)}${text(String(repo.stars), { font: F.mono, size: 13, x: starX + 18, y: H - 28, fill: t.text })}`;
  return svg(W, H, `${repo.name}: ${desc.join(' ')}`, '', body);
}

// ---------------------------------------------------------------- main

async function main() {
  const fixtureArg = process.argv.indexOf('--fixture');
  let repos;
  if (fixtureArg > -1) {
    repos = JSON.parse(readFileSync(process.argv[fixtureArg + 1], 'utf8')).repos;
  } else {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('Set GITHUB_TOKEN, or pass --fixture <file>.');
    repos = await fetchRepos(config.login, token);
  }

  const langs = rankLanguages(repos);
  const stack = detectStack(repos);
  const counted = repos.filter((r) => !config.languages.ignoreRepos.includes(r.name)).length;

  mkdirSync(OUT, { recursive: true });
  const write = (name, content) => {
    writeFileSync(path.join(OUT, name), content);
    console.log(`${name.padEnd(28)} ${(Buffer.byteLength(content) / 1024).toFixed(1)} KB`);
  };
  write('header.svg', header());
  write('footer.svg', footer());
  for (const theme of Object.keys(THEMES)) {
    write(`languages-${theme}.svg`, languagesCard(langs, counted, theme));
    write(`stack-${theme}.svg`, stackCard(stack, theme));
    for (const entry of config.featured) {
      const repo = repos.find((r) => r.name === entry.repo);
      if (!repo) throw new Error(`Featured repo "${entry.repo}" is not a public, non-fork repo of ${config.login}.`);
      const i = langs.findIndex((l) => l.name === repo.primaryLanguage?.name);
      const color = i > -1 ? THEMES[theme].langs[i % 7] : THEMES[theme].muted;
      write(`featured-${entry.repo}-${theme}.svg`, featuredCard(entry, repo, color, theme));
    }
  }
  console.log(`\nLanguages: ${langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ')}`);
  console.log(`Stack: ${stack.map((s) => `${s.slug}(${s.repos})`).join(', ')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
