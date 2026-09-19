const RULES = [
  {
    re: /\b(mklink|ln\s+-s|New-Item\b[^\n]*-ItemType\s+(Junction|SymbolicLink|HardLink))\b[^\n]*\.spike/i,
    why: "a hand-made link into .spike bypasses the session lease",
  },
  {
    re: /\b(cp|copy|xcopy|robocopy|Copy-Item|rsync|mv|move|Move-Item)\b[^\n]*\.spike[\\/]sessions/i,
    why: "copying or moving a session out of .spike/sessions makes a second usable copy",
  },
  {
    re: /\b(rm|del|Remove-Item|unlink)\b[^\n]*\.spike[\\/]sessions[\\/][^\s\\/]+[\\/]\.lease/i,
    why: "a lease is released with spike-lease, never deleted by hand",
  },
];

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}
const command = String(payload?.tool_input?.command ?? "");
if (!command || /spike-lease\.mjs/.test(command)) process.exit(0);
const hit = RULES.find(({ re }) => re.test(command));
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
