import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2).filter(Boolean);
if (!args.length) {
  console.error("usage: bun spend.mjs <session-id|session-dir> [...]");
  process.exit(1);
}

const projectsRoot = join(homedir(), ".claude", "projects");

function resolveSubagentDirs(arg) {
  const direct = [join(arg, "subagents"), arg];
  for (const d of direct) if (existsSync(d) && basename(d) === "subagents") return [d];
  if (existsSync(direct[0])) return [direct[0]];
  const hits = [];
  if (existsSync(projectsRoot)) {
    for (const project of readdirSync(projectsRoot)) {
      const d = join(projectsRoot, project, arg, "subagents");
      if (existsSync(d)) hits.push(d);
    }
  }
  return hits;
}

function collect(path) {
  const byId = new Map();
  const tools = new Set();
  let steps = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "assistant" || !e.message) continue;
    for (const block of Array.isArray(e.message.content) ? e.message.content : [])
      if (block?.type === "tool_use") tools.add(block.id ?? `${e.uuid}:${tools.size}`);
    const u = e.message.usage;
    if (!u) continue;
    const id = e.message.id ?? `${e.uuid}`;
    const next = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    };
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, next);
      steps += 1;
    } else {
      for (const k of Object.keys(next)) next[k] = Math.max(prev[k], next[k]);
      byId.set(id, next);
    }
  }
  const sum = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const v of byId.values()) for (const k of Object.keys(sum)) sum[k] += v[k];
  return { ...sum, steps, tools: tools.size };
}

const rows = [];
for (const arg of args) {
  for (const dir of resolveSubagentDirs(arg)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
      } catch {}
      const t = collect(path);
      const label = (meta.description ?? "").trim();
      const round = label.match(/\br(\d+)\b/i);
      const unit = label.match(/\bu\d+\b/i) ?? label.match(/^assess\b/i);
      const critique = label.match(/\bcritique\s+([AB])\b/i);
      rows.push({
        started: statSync(path).birthtimeMs || statSync(path).mtimeMs,
        unit: unit ? unit[0].toLowerCase() : "—",
        role: critique ? `critique ${critique[1].toUpperCase()}` : (meta.agentType ?? "—"),
        round: round ? round[1] : "—",
        label,
        steps: t.steps,
        context: t.input + t.output,
        cache: t.cacheWrite + t.cacheRead,
      });
    }
  }
}

if (!rows.length) {
  console.error(`no subagent transcripts found for: ${args.join(", ")}`);
  process.exit(1);
}

rows.sort((a, b) => a.started - b.started);

const fmt = (n) =>
  n < 1000
    ? String(n)
    : n < 1_000_000
      ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
      : `${(n / 1_000_000).toFixed(1)}M`;

const units = [];
for (const r of rows) {
  let u = units.find((x) => x.unit === r.unit);
  if (!u) units.push((u = { unit: r.unit, rows: [], context: 0, cache: 0 }));
  u.rows.push(r);
  u.context += r.context;
  u.cache += r.cache;
}

const out = [
  "| Юнит | Роль | Раунд | Шаги | Контекст | Кэш |",
  "| --- | --- | --- | --- | --- | --- |",
];
for (const u of units) {
  for (const r of u.rows)
    out.push(
      `| ${r.unit} | ${r.role} | ${r.round} | ${r.steps} | ${fmt(r.context)} | ${fmt(r.cache)} |`,
    );
  if (units.length > 1 && u.rows.length > 1)
    out.push(`| **${u.unit}** | | | | **${fmt(u.context)}** | **${fmt(u.cache)}** |`);
}

const grand = rows.reduce((a, r) => a + r.context, 0);
const grandCache = rows.reduce((a, r) => a + r.cache, 0);
out.push(`| **Всего** | ${rows.length} агентов | | | **${fmt(grand)}** | **${fmt(grandCache)}** |`);

const byRole = new Map();
for (const r of rows) byRole.set(r.role, (byRole.get(r.role) ?? 0) + r.context);
const sumRoles = (test) =>
  [...byRole.entries()].reduce((a, [role, n]) => (test(role) ? a + n : a), 0);
const impl = sumRoles((role) => /-implement$|-debug$/.test(role));
const crit = sumRoles((role) => /-critic$|-review$|^critique [AB]$/.test(role));
const costliest = [...byRole.entries()].sort((a, b) => b[1] - a[1])[0];

out.push("");
out.push(
  `Ревью : реализация — ${impl ? `${(crit / impl).toFixed(2)} : 1` : "n/a"} (ревью ${fmt(crit)}, реализация ${fmt(impl)}, по контексту).`,
);
out.push(`Самая дорогая роль — ${costliest[0]}, ${fmt(costliest[1])}.`);

console.log(out.join("\n"));
