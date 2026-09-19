#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const target = resolve(process.argv[2] ?? process.cwd());
if (!existsSync(join(target, ".git"))) {
  console.error(`install: ${target} is not a git repo root\nusage: node install.mjs <repo>`);
  process.exit(64);
}
const src = join(dirname(fileURLToPath(import.meta.url)), "claude");
const claude = join(target, ".claude");

cpSync(src, claude, { recursive: true });
console.log(`copied skills, agents, hooks → ${claude}`);

const settingsPath = join(claude, "settings.json");
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const command = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/spike-guard.mjs"';
const pre = ((settings.hooks ??= {}).PreToolUse ??= []);
if (!JSON.stringify(pre).includes("spike-guard.mjs")) {
  pre.push({ matcher: "Bash|PowerShell", hooks: [{ type: "command", command }] });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`added spike-guard hook → ${settingsPath}`);
}

const gitignore = join(target, ".gitignore");
const ignored = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
if (!/^\/?\.spike\/?$/m.test(ignored)) {
  appendFileSync(gitignore, `${ignored && !ignored.endsWith("\n") ? "\n" : ""}.spike/\n`);
  console.log("added .spike/ → .gitignore");
}

const spike = join(target, ".spike");
for (const d of ["data", "sessions", "toolkits"]) mkdirSync(join(spike, d), { recursive: true });
const readme = join(spike, "README.md");
if (!existsSync(readme)) {
  writeFileSync(
    readme,
    `# .spike

Research workspace for /spike and /bkloop. Never committed.

- \`data/\` — proxies, samples, exports: what each file is.
- \`sessions/<name>/\` — one folder per account: what opens it (session string, tdata, cookies, 2FA).
- \`toolkits/<topic>/\` — written by spike-researcher.

## Limits

none
`,
  );
  console.log(`created ${readme} — describe your resources and limits there`);
}
