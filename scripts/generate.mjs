// Builds the profile README graphics in ../assets from config.json and live repo data.
//
//   node generate.mjs                     # fetch repos with GITHUB_TOKEN (CI)
//   node generate.mjs --fixture data.json # use a saved snapshot instead
//
// Every SVG is self-contained: text is converted to paths at build time, so the
// graphics look the same everywhere and never load fonts or call other services.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
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
    langs: { Rust: '#E07A5F', JavaScript: '#E9B872', TypeScript: '#8FB8DE', Python: '#F4EFE6', Swift: '#B9A3E3', Vue: '#5CC4B8', QML: '#2E9C92', Other: '#5F7F7A' },
    langsExtra: ['#D98FB0', '#9CCB7A', '#7FC8C8', '#C7B08A'],
  },
  light: {
    bg: '#F3F8F6', surface: '#FFFFFF', line: '#D3E4DF', diamond: '#E6F0EC',
    text: '#072E2E', muted: '#4F6B67', accent: '#0E716B', track: '#E2EEEA',
    langs: { Rust: '#C0533A', JavaScript: '#B7802A', TypeScript: '#3C6FA6', Python: '#072E2E', Swift: '#7A5EBF', Vue: '#0E716B', QML: '#3FA89D', Other: '#9FB8B3' },
    langsExtra: ['#B0577F', '#5E8F3A', '#2F8A8A', '#8A7247'],
  },
};

// Each language keeps the same colour every day; languages without one borrow
// from `langsExtra` by rank.
const langColor = (theme, name, rank) => {
  const t = THEMES[theme];
  return t.langs[name] ?? t.langsExtra[rank % t.langsExtra.length];
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

// GitHub's GraphQL API sometimes answers with a 502 page instead of JSON, so
// retry a few times with a growing pause before giving up.
async function graphql(token, login, query, variables, attempts = 4) {
  for (let i = 1; ; i++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': `${login}-profile` },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* an HTML error page */ }
    if (res.ok && json && !json.errors) return json;
    const reason = `${res.status} ${json?.errors ? JSON.stringify(json.errors) : body.slice(0, 200)}`;
    if (i >= attempts) throw new Error(`GitHub API: ${reason}`);
    console.warn(`GitHub API attempt ${i} failed (${reason.slice(0, 80)}), retrying`);
    await new Promise((r) => setTimeout(r, 5000 * i));
  }
}

async function fetchRepos(login, token) {
  const blobs = Object.entries(MANIFESTS)
    .map(([alias, file]) => `${alias}: object(expression: "HEAD:${file}") { ... on Blob { text } }`).join('\n');
  const query = `query($login: String!, $cursor: String) {
    user(login: $login) {
      repositories(first: 50, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC, isFork: false, orderBy: {field: PUSHED_AT, direction: DESC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name description url stargazerCount isArchived pushedAt
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
    const json = await graphql(token, login, query, { login, cursor });
    const page = json.data.user.repositories;
    for (const r of page.nodes) {
      if (r.isArchived) continue;
      const files = {};
      for (const [alias, file] of Object.entries(MANIFESTS)) if (r[alias]?.text) files[file] = r[alias].text;
      repos.push({
        name: r.name, description: r.description, url: r.url, stars: r.stargazerCount, pushedAt: r.pushedAt,
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
// a language used across many projects. Each repo's weight halves every
// `halfLifeYears` since its last push, so the card shows what I use now.
function rankLanguages(repos) {
  const { ignore = [], ignoreRepos = [], max = 7, halfLifeYears = 2 } = config.languages;
  const acc = new Map();
  for (const repo of repos) {
    if (ignoreRepos.includes(repo.name)) continue;
    const ageYears = repo.pushedAt ? (Date.now() - Date.parse(repo.pushedAt)) / 3.156e10 : 0;
    const weight = 0.5 ** (Math.max(ageYears, 0) / halfLifeYears);
    for (const { name, size } of repo.languages) {
      if (ignore.includes(name)) continue;
      const e = acc.get(name) ?? { name, bytes: 0, repos: 0 };
      e.bytes += size * weight;
      e.repos += weight;
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

// The banner shows at roughly 0.47x on a profile page, so no text here is set
// below 20px; that keeps it at about 9-10px on screen.
// The project I'm on right now: my most recently pushed public repo, minus the
// ones listed in config.building.exclude (this profile repo, the Homebrew tap…).
function currentProject(repos) {
  const { exclude = [], names = {} } = config.building;
  const latest = repos
    .filter((r) => r.pushedAt && !exclude.includes(r.name))
    .sort((a, b) => Date.parse(b.pushedAt) - Date.parse(a.pushedAt))[0];
  return latest ? (names[latest.name] ?? latest.name) : null;
}

function header(building) {
  // A role line can say {building}; drop that line if no project was found.
  const roleLines = config.roles
    .filter((r) => building || !r.includes('{building}'))
    .map((r) => r.replace('{building}', building));
  const W = 1200, H = 260, B = BANNER;
  const roles = roleLines.map((r, i) => `<g class="role r${i}">${text(r, { font: F.medium, size: 24, x: 72, y: 200, fill: B.muted })}</g>`).join('');
  const handleW = measure(config.handle, F.mono, 20);
  const nameSize = 76;

  // Chat bubbles on the right, in the style of the CheckSen banner.
  const right = 1136;
  const qSize = 21, qW = measure(config.chat.question, F.medium, qSize);
  const q = { w: qW + 48, h: 52 };
  const qx = right - q.w;

  // Each answer gets its own bubble; with more than one, they take turns.
  const titleSize = 22, bodySize = 21, lineH = 30, pad = 24, iconW = 32;
  const answers = config.chat.answers.map((a) => {
    const titleW = iconW + measure(a.title, F.heading, titleSize);
    const bodyW = measure(a.body, F.body, bodySize);
    // Keep the answer on one line when it fits beside the name; otherwise wrap it.
    const w = Math.min(Math.max(titleW, bodyW), 500) + pad * 2;
    const lines = wrap(a.body, F.body, bodySize, w - pad * 2, 2);
    return { ...a, w, lines, h: 42 + lines.length * lineH + 20 };
  });
  const aMaxW = Math.max(...answers.map((a) => a.w)), aMaxH = Math.max(...answers.map((a) => a.h));
  const qy = Math.round((H - (q.h + 14 + aMaxH)) / 2);  // centre the conversation vertically
  const aX = right - aMaxW - 24, aY = qy + q.h + 14;
  const nameRight = 68 + measure(config.name, F.display, nameSize, -0.02);
  if (nameRight > aX - 40) throw new Error(`Header: the name and the answer bubble overlap (${nameRight.toFixed(0)} > ${aX - 40}).`);
  if (aY + aMaxH > H - 24) throw new Error('Header: an answer bubble is too tall; shorten its body.');

  const bubble = (x, y, w, h, tail) => {
    // Rounded rect with one tighter corner, like a chat bubble's tail.
    const r = 20, t = 6;
    const [tl, tr, br, bl] = tail === 'right' ? [r, r, t, r] : [r, r, r, t];
    return `M${x + tl},${y} H${x + w - tr} Q${x + w},${y} ${x + w},${y + tr} V${y + h - br} Q${x + w},${y + h} ${x + w - br},${y + h} H${x + bl} Q${x},${y + h} ${x},${y + h - bl} V${y + tl} Q${x},${y} ${x + tl},${y} Z`;
  };
  const icon = (kind, cx, cy) => kind === 'spark'
    ? `<path d="M${cx} ${cy - 6.5} Q${cx + 1.2} ${cy - 1.2} ${cx + 6.5} ${cy} Q${cx + 1.2} ${cy + 1.2} ${cx} ${cy + 6.5} Q${cx - 1.2} ${cy + 1.2} ${cx - 6.5} ${cy} Q${cx - 1.2} ${cy - 1.2} ${cx} ${cy - 6.5} Z" fill="${B.ink}"/>`
    : `<path d="M${cx - 4.5} ${cy + 0.5} l3.5 3.5 l6.5 -7.5" fill="none" stroke="${B.ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  const answerMarkup = answers.map((a, k) => `<g class="ans ans${k}"><path d="${bubble(aX, aY, a.w, a.h, 'left')}" fill="${B.bubbleOut}"/>
<circle cx="${aX + pad + 10}" cy="${aY + 35}" r="10" fill="${B.mint}"/>${icon(a.icon, aX + pad + 10, aY + 35)}
${text(a.title, { font: F.heading, size: titleSize, x: aX + pad + iconW, y: aY + 43, fill: B.teal })}
${a.lines.map((l, i) => text(l, { font: F.body, size: bodySize, x: aX + pad, y: aY + 42 + (i + 1) * lineH, fill: B.ink })).join('')}</g>`).join('\n');

  // The conversation: the question pops in, then dots type each answer in turn.
  // With one answer it plays once and stays; with more it loops every `turn` seconds.
  const start = 1.5, typing = 1.3, turn = 10, cycle = turn * answers.length;
  const at = (sec) => `${((sec / cycle) * 100).toFixed(2)}%`;
  let chatStyle;
  if (answers.length === 1) {
    chatStyle = `
    .typing { opacity: 0; animation: typing ${typing}s ${start}s both; }
    @keyframes typing { 0% { opacity: 0; } 12%, 88% { opacity: 1; } 100% { opacity: 0; } }
    .ans0 { transform-box: fill-box; transform-origin: left bottom; animation: pop .55s cubic-bezier(.2,.9,.3,1.15) ${start + typing}s both; }`;
  } else {
    const typingFrames = answers.map((_, k) => `${at(k * turn + 0.15)}, ${at(k * turn + typing - 0.1)} { opacity: 1; } ${at(k * turn + typing)} { opacity: 0; }`).join(' ');
    chatStyle = `
    .typing { opacity: 0; animation: typing ${cycle}s linear ${start}s infinite forwards; }
    @keyframes typing { 0% { opacity: 0; } ${typingFrames} 100% { opacity: 0; } }
    .ans { opacity: 0; transform-box: fill-box; transform-origin: left bottom; animation: ${cycle}s ease-out ${start}s infinite both; }
    .ans0 { opacity: 1; }` + answers.map((_, k) => {
      const s0 = k * turn + typing, e = (k + 1) * turn;
      return `
    .ans${k} { animation-name: ans${k}; }
    @keyframes ans${k} { 0%, ${at(s0)} { opacity: 0; transform: translateY(10px) scale(.96); } ${at(s0 + 0.45)}, ${at(e - 0.4)} { opacity: 1; transform: none; } ${at(e)}, 100% { opacity: 0; transform: translateY(-6px); } }`;
    }).join('');
  }

  // One orchestrated moment (the chat), plus the role line. Everything else is still.
  const style = `
    .drift { animation: drift 90s linear infinite; }
    @keyframes drift { to { transform: translate(56px, -56px); } }
    .up { animation: up .9s cubic-bezier(.2,.7,.2,1) both; }
    .d1 { animation-delay: .12s; } .d2 { animation-delay: .24s; }
    @keyframes up { from { opacity: 0; transform: translateY(14px); } }
    .caret { animation: blink 1.1s steps(1) 4; }
    @keyframes blink { 50% { opacity: 0; } }
    .role { opacity: 0; animation: role 12s ease-in-out infinite both; }
    .r0 { opacity: 1; animation-delay: .24s; } .r1 { animation-delay: 4.24s; } .r2 { animation-delay: 8.24s; }
    @keyframes role { 0% { opacity: 0; transform: translateY(8px); } 4%, 29% { opacity: 1; transform: none; } 33%, 100% { opacity: 0; transform: translateY(-8px); } }
    .pop { transform-box: fill-box; animation: pop .55s cubic-bezier(.2,.9,.3,1.15) both; }
    .q { transform-origin: right bottom; animation-delay: .9s; }
    @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.95); } }
    ${chatStyle}
    .dot { transform-box: fill-box; transform-origin: center; animation: bounce .9s ease-in-out infinite; }
    .dot:nth-child(2) { animation-delay: .15s; } .dot:nth-child(3) { animation-delay: .3s; }
    @keyframes bounce { 0%, 100% { transform: translateY(0); opacity: .45; } 50% { transform: translateY(-4px); opacity: 1; } }`;

  const body = `<defs>
${diamondPattern('dia', B.diamond)}
<clipPath id="card"><rect width="${W}" height="${H}" rx="28"/></clipPath>
<radialGradient id="g1" cx="0.85" cy="0.05" r="0.6"><stop offset="0" stop-color="${B.mint}" stop-opacity=".16"/><stop offset="1" stop-color="${B.mint}" stop-opacity="0"/></radialGradient>
<linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="${B.bg}" stop-opacity=".9"/><stop offset=".55" stop-color="${B.bg}" stop-opacity="0"/></linearGradient>
</defs>
<g clip-path="url(#card)">
<rect width="${W}" height="${H}" fill="${B.bg}"/>
<g class="drift"><rect x="-112" y="-56" width="${W + 224}" height="${H + 168}" fill="url(#dia)"/></g>
<rect width="${W}" height="${H}" fill="url(#fade)"/>
<rect width="${W}" height="${H}" fill="url(#g1)"/>
</g>
<g class="up">${text(config.handle, { font: F.mono, size: 20, x: 72, y: 76, fill: B.mint })}<rect class="caret" x="${72 + handleW + 5}" y="59" width="10" height="20" rx="2" fill="${B.mint}"/></g>
<g class="up d1">${text(config.name, { font: F.display, size: nameSize, x: 69, y: 156, fill: B.cream, ls: -0.02 })}</g>
<g class="up d2">${roles}</g>
<path class="pop q" d="${bubble(qx, qy, q.w, q.h, 'right')}" fill="${B.bubbleIn}"/>
<g class="pop q">${text(config.chat.question, { font: F.medium, size: qSize, x: qx + 24, y: qy + 33, fill: B.ink })}</g>
<g class="typing"><path d="${bubble(aX, aY, 88, 48, 'left')}" fill="${B.bubbleOut}"/><g>${[0, 1, 2].map((i) => `<circle class="dot" cx="${aX + 28 + i * 16}" cy="${aY + 24}" r="5" fill="${B.teal}"/>`).join('')}</g></g>
${answerMarkup}`;
  return svg(W, H, `${config.name}. ${roleLines.join('. ')}. ${answers.map((a) => `${a.title} ${a.body}`).join(' ')}`, style, body);
}

// ---------------------------------------------------------------- toolbox

// Languages on the left, tools on the right, in one card. Shown at ~0.47x like
// the header, so text stays at 20px or more in this canvas.
function toolboxCard(langs, stack, theme) {
  const t = THEMES[theme], W = 1200, H = 260, colW = 504, leftX = 48, rightX = 648;
  const colorOf = (i, name) => langColor(theme, name, i);

  const barY = 90, barH = 14;
  let x = leftX;
  const segs = langs.map((l, i) => {
    const w = (l.pct / 100) * colW;
    const seg = `<rect class="grow" style="animation-delay:${(i * 0.08).toFixed(2)}s" x="${x.toFixed(2)}" y="${barY}" width="${Math.max(w - 3, 1).toFixed(2)}" height="${barH}" fill="${colorOf(i, l.name)}"/>`;
    x += w;
    return seg;
  }).join('');
  const legendColW = (colW - 24) / 2;
  const legend = langs.slice(0, 6).map((l, i) => {
    const cx = leftX + (i % 2) * (legendColW + 24), y = 146 + Math.floor(i / 2) * 36;
    return `<circle cx="${cx + 6}" cy="${y - 7}" r="6" fill="${colorOf(i, l.name)}"/>
${text(l.name, { font: F.medium, size: 22, x: cx + 22, y, fill: t.text })}
${text(`${l.pct.toFixed(1)}%`, { font: F.mono, size: 20, x: cx + 22 + measure(l.name, F.medium, 22) + 10, y, fill: t.muted })}`;
  }).join('');

  // Tools are listed as icon + name, 3 by 3, on the same rows as the language
  // legend. Languages already shown on the left are skipped.
  const shown = new Set(langs.map((l) => l.name.toLowerCase()));
  const short = { 'Tailwind CSS': 'Tailwind', 'Google Gemini': 'Gemini', 'GNU Bash': 'Bash' };
  const tools = stack.filter((s) => !shown.has(s.title.toLowerCase())).slice(0, 9);
  // One type size for every name; the three columns get their natural widths
  // and share the leftover space as equal gaps.
  const iconSize = 24, nameSize = 21;
  const names = tools.map((s) => short[s.title] ?? s.title);
  const colWidths = [0, 1, 2].map((c) => Math.max(0, ...names.filter((_, i) => i % 3 === c).map((n) => iconSize + 10 + measure(n, F.medium, nameSize))));
  const colGap = (colW - colWidths.reduce((a, w) => a + w, 0)) / 2;
  const colX = [rightX, rightX + colWidths[0] + colGap, rightX + colWidths[0] + colWidths[1] + colGap * 2];
  const tiles = tools.map((s, i) => {
    const tx = colX[i % 3], ty = 146 + Math.floor(i / 3) * 36;
    return `<path transform="translate(${tx} ${ty - 19}) scale(${(iconSize / 24).toFixed(4)})" d="${s.path}" fill="${t.text}"/>
${text(names[i], { font: F.medium, size: nameSize, x: tx + iconSize + 10, y: ty, fill: t.text })}`;
  }).join('');

  const style = `
    .grow { transform-box: fill-box; transform-origin: left center; animation: grow 1s cubic-bezier(.2,.7,.2,1) both; }
    @keyframes grow { from { transform: scaleX(0); } }`;
  const body = `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="28" fill="${t.surface}" stroke="${t.line}" stroke-width="2"/>
<path d="M600 44 V${H - 44}" stroke="${t.line}" stroke-width="2"/>
${text('Languages', { font: F.heading, size: 26, x: leftX, y: 66, fill: t.text })}
${text('Tools', { font: F.heading, size: 26, x: rightX, y: 66, fill: t.text })}
${text('What I build with', { font: F.mono, size: 20, x: rightX, y: 104, fill: t.muted })}
<clipPath id="bar"><rect x="${leftX}" y="${barY}" width="${colW}" height="${barH}" rx="${barH / 2}"/></clipPath>
<rect x="${leftX}" y="${barY}" width="${colW}" height="${barH}" rx="${barH / 2}" fill="${t.track}"/>
<g clip-path="url(#bar)">${segs}</g>
${legend}
${tiles}`;
  const summary = `Languages: ${langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ')}. Tools: ${tools.map((s) => s.title).join(', ')}.`;
  return svg(W, H, summary, style, body);
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

  mkdirSync(OUT, { recursive: true });
  const written = new Set();
  const write = (name, content) => {
    writeFileSync(path.join(OUT, name), content);
    written.add(name);
    console.log(`${name.padEnd(22)} ${(Buffer.byteLength(content) / 1024).toFixed(1)} KB`);
  };
  const building = currentProject(repos);
  write('header.svg', header(building));
  for (const theme of Object.keys(THEMES)) write(`toolbox-${theme}.svg`, toolboxCard(langs, stack, theme));

  // Drop graphics from older layouts so assets/ only holds what the README uses.
  for (const file of readdirSync(OUT)) {
    if (file.endsWith('.svg') && !written.has(file)) {
      unlinkSync(path.join(OUT, file));
      console.log(`${file.padEnd(22)} removed`);
    }
  }
  console.log(`\nNow building: ${building}`);
  console.log(`Languages: ${langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ')}`);
  console.log(`Tools: ${stack.map((s) => `${s.slug}(${s.repos})`).join(', ')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
