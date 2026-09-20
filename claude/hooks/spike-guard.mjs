import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { commandSegments, verbOf } from "./shell-text.mjs";

const SPIKE = /(^|[\\/])\.spike([\\/]|$)/i;
const SESSIONS = /(^|[\\/])\.spike[\\/]sessions([\\/]|$)/i;
const LEASE = /(^|[\\/])\.spike[\\/]sessions[\\/][^\\/]+[\\/]\.lease$/i;
const LINK_VERBS = /^(ln|mklink)$/i;
const COPY_VERBS = /^(cp|copy|xcopy|robocopy|Copy-Item|rsync|mv|move|Move-Item)$/i;
const DELETE_VERBS = /^(rm|del|Remove-Item|unlink)$/i;
const LINK_ITEM = /^(Junction|SymbolicLink|HardLink)$/i;
const RECURSIVE_DELETE_VERBS = /^(rm|rmdir|Remove-Item|rd)$/i;
const RECURSIVE_FLAG = /^(-[a-z]*r[a-z]*|--recursive|-Recurse|\/s)$/i;

function isReparse(p) {
  try {
    if (lstatSync(p).isSymbolicLink()) return true;
    if (process.platform !== "win32") return false;
    const r = spawnSync("cmd", ["/c", "dir", "/AL", "/B", dirname(p)], { encoding: "utf8" });
    return r.status === 0 && r.stdout.split(/\r?\n/).includes(basename(p));
  } catch {
    return false;
  }
}

function mirrorOnDisk(p) {
  const spike = /(^|[\\/])\.spike$/i.test(p) ? p : join(p, ".spike");
  if (!existsSync(spike)) return false;
  try {
    return readdirSync(spike).some((name) => isReparse(join(spike, name)));
  } catch {
    return false;
  }
}

function removalTargets({ verb, args }) {
  if (/^git$/i.test(verb)) {
    const at = args.indexOf("worktree");
    if (at < 0 || args[at + 1] !== "remove") return [];
    const c = args.indexOf("-C");
    const base = c >= 0 && c < at ? args[c + 1] : process.cwd();
    return args.slice(at + 2).filter((a) => !a.startsWith("-")).map((a) => resolve(winPath(base), winPath(a)));
  }
  if (RECURSIVE_DELETE_VERBS.test(verb) && args.some((a) => RECURSIVE_FLAG.test(a))) {
    return args.filter((a) => !a.startsWith("-") && !/^\/[sq]$/i.test(a)).map((a) => resolve(winPath(a)));
  }
  return [];
}

function winPath(p) {
  const m = /^\/([a-z])(\/|$)/i.exec(p);
  return m && process.platform === "win32" ? `${m[1].toUpperCase()}:/${p.slice(m[0].length)}` : p;
}

const RULES = [
  {
    hit: (call, mirrorAt) => removalTargets(call).some((p) => mirrorAt(p)),
    why: "removing a checkout over a standing .spike mirror walks its junctions and empties the main .spike; run spike-lease.mjs unlink <checkout> first",
  },
  {
    hit: ({ verb, args }) =>
      (LINK_VERBS.test(verb) && args.some((a) => SPIKE.test(a))) ||
      (/^New-Item$/i.test(verb) && args.some((a) => LINK_ITEM.test(a)) && args.some((a) => SPIKE.test(a))),
    why: "a hand-made link into .spike bypasses the session lease",
  },
  {
    hit: ({ verb, args }) => COPY_VERBS.test(verb) && args.some((a) => SESSIONS.test(a)),
    why: "copying or moving a session out of .spike/sessions makes a second usable copy",
  },
  {
    hit: ({ verb, args }) => DELETE_VERBS.test(verb) && args.some((a) => LEASE.test(a)),
    why: "a lease is released with spike-lease, never deleted by hand",
  },
];

export function spikeViolation(command, { mirrorAt = mirrorOnDisk } = {}) {
  const text = String(command ?? "");
  if (!text || /spike-lease\.mjs/.test(text)) return null;
  for (const tokens of commandSegments(text)) {
    const call = verbOf(tokens);
    const hit = RULES.find((rule) => rule.hit(call, mirrorAt));
    if (hit) return hit;
  }
  return null;
}

if (import.meta.main) {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const hit = spikeViolation(payload?.tool_input?.command);
  if (!hit) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blocked by spike-guard: ${hit.why}. Use .claude/skills/bkloop/spike-lease.mjs (link / acquire / release).`,
      },
    }),
  );
}
