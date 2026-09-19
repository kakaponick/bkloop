#!/usr/bin/env node
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SESSIONS = "sessions";
const USAGE = `usage:
  spike-lease link <checkout>                          mirror the main .spike into <checkout>/.spike — everything except sessions/
  spike-lease acquire <checkout> <session> [--wait s]  take the session's lease, link .spike/sessions/<session> into <checkout>
  spike-lease release <checkout> <session>             drop the link and the lease
  spike-lease unlink <checkout>                        remove the whole mirror (releases its sessions first)
  spike-lease status [<checkout>]                      every session and who holds it
a session is a folder .spike/sessions/<name>/ in the main checkout; one holder at a time; a lane without the lease has no such folder.`;

function die(msg, code = 64) {
  process.stderr.write(`spike-lease: ${msg}\n`);
  process.exit(code);
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) die(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function mainCheckout(checkout) {
  return dirname(resolve(checkout, git(["rev-parse", "--git-common-dir"], checkout)));
}

function isReparse(p) {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return true;
    if (process.platform !== "win32" || !st.isDirectory()) return false;
    const r = spawnSync("cmd", ["/c", "dir", "/AL", "/B", dirname(p)], { encoding: "utf8" });
    return r.status === 0 && r.stdout.split(/\r?\n/).includes(p.split(/[\\/]/).pop());
  } catch {
    return false;
  }
}

function linkDir(link, target) {
  if (process.platform === "win32") {
    const r = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { encoding: "utf8" });
    if (r.status !== 0) die(`mklink failed: ${(r.stderr || r.stdout).trim()}`);
  } else symlinkSync(target, link, "dir");
}

function linkFile(link, target) {
  if (process.platform === "win32") {
    const r = spawnSync("cmd", ["/c", "mklink", "/H", link, target], { encoding: "utf8" });
    if (r.status !== 0) die(`mklink /H failed: ${(r.stderr || r.stdout).trim()}`);
  } else symlinkSync(target, link, "file");
}

function unlinkDir(link) {
  if (process.platform === "win32") rmdirSync(link);
  else unlinkSync(link);
}

function readLease(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function ctx(checkoutArg) {
  const checkout = resolve(checkoutArg ?? die(USAGE));
  const main = mainCheckout(checkout);
  const spike = join(main, ".spike");
  mkdirSync(join(spike, SESSIONS), { recursive: true });
  return { checkout, main, spike, isMain: resolve(checkout) === resolve(main), mirror: join(checkout, ".spike") };
}

function link(args) {
  const c = ctx(args[0]);
  if (c.isMain) return process.stdout.write("main checkout holds the real .spike — nothing to link\n");
  if (existsSync(c.mirror) && isReparse(c.mirror)) die(`${c.mirror} is a link to the whole .spike — remove it, sessions must not be shared that way`, 65);
  mkdirSync(join(c.mirror, SESSIONS), { recursive: true });
  let n = 0;
  for (const name of readdirSync(c.spike)) {
    if (name === SESSIONS || name.startsWith(".")) continue;
    const src = join(c.spike, name);
    const dst = join(c.mirror, name);
    if (existsSync(dst)) continue;
    if (lstatSync(src).isDirectory()) linkDir(dst, src);
    else linkFile(dst, src);
    n++;
  }
  process.stdout.write(`linked ${n} entries into ${c.mirror} (sessions come only through acquire)\n`);
}

function acquire(args) {
  const c = ctx(args[0]);
  const name = args[1];
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) die("acquire <checkout> <session>");
  const src = join(c.spike, SESSIONS, name);
  if (!existsSync(src) || !lstatSync(src).isDirectory()) die(`no session folder ${src}`, 66);
  const waitIdx = args.indexOf("--wait");
  const deadline = Date.now() + (waitIdx >= 0 ? Number(args[waitIdx + 1]) : 0) * 1000;
  const leasePath = join(src, ".lease");
  const body = JSON.stringify({ owner: c.checkout, since: new Date().toISOString() }) + "\n";
  for (;;) {
    try {
      const fd = openSync(leasePath, "wx");
      writeSync(fd, body);
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = readLease(leasePath);
      if (held?.owner === c.checkout) break;
      if (Date.now() >= deadline) die(`${name} busy: held by ${held?.owner ?? "?"} since ${held?.since ?? "?"} — release it there, or --wait <s>`, 75);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  if (!c.isMain) {
    if (!existsSync(join(c.mirror, SESSIONS))) die(`${c.mirror} is not linked — run link first`, 65);
    const dst = join(c.mirror, SESSIONS, name);
    if (!existsSync(dst)) linkDir(dst, src);
  }
  process.stdout.write(`acquired ${name} for ${c.checkout}\n`);
}

function release(args, quiet = false) {
  const c = ctx(args[0]);
  const name = args[1];
  if (!name) die("release <checkout> <session>");
  const src = join(c.spike, SESSIONS, name);
  const leasePath = join(src, ".lease");
  const held = readLease(leasePath);
  if (!held) return quiet ? undefined : die(`${name}: no lease held`, 66);
  if (held.owner !== c.checkout) die(`${name} is held by ${held.owner}, not ${c.checkout}`, 65);
  const dst = join(c.mirror, SESSIONS, name);
  if (!c.isMain && existsSync(dst)) {
    if (!isReparse(dst)) die(`${dst} is a real directory — refusing to remove`, 65);
    unlinkDir(dst);
  }
  unlinkSync(leasePath);
  process.stdout.write(`released ${name} from ${c.checkout}\n`);
}

function unlink(args) {
  const c = ctx(args[0]);
  if (c.isMain) die("the main checkout is never unlinked", 65);
  if (!existsSync(c.mirror)) return process.stdout.write("nothing linked\n");
  const sessions = join(c.mirror, SESSIONS);
  if (existsSync(sessions)) for (const name of readdirSync(sessions)) release([c.checkout, name], true);
  for (const name of readdirSync(c.mirror)) {
    const p = join(c.mirror, name);
    if (name === SESSIONS) {
      rmdirSync(p);
      continue;
    }
    if (lstatSync(p).isDirectory()) {
      if (!isReparse(p)) die(`${p} is a real directory — refusing to remove`, 65);
      unlinkDir(p);
    } else unlinkSync(p);
  }
  rmdirSync(c.mirror);
  process.stdout.write(`unlinked ${c.mirror}\n`);
}

function status(args) {
  const c = ctx(args[0] ?? process.cwd());
  const dir = join(c.spike, SESSIONS);
  const names = readdirSync(dir).filter((n) => lstatSync(join(dir, n)).isDirectory());
  if (!names.length) return process.stdout.write(`no sessions under ${dir}\n`);
  let busy = 0;
  for (const n of names) {
    const held = readLease(join(dir, n, ".lease"));
    if (held) busy++;
    process.stdout.write(`${n.padEnd(20)} ${held ? `held by ${held.owner} since ${held.since}` : "free"}\n`);
  }
  process.exit(busy ? 1 : 0);
}

const [cmd, ...rest] = process.argv.slice(2);
const commands = { link, acquire, release, unlink, status };
if (!commands[cmd]) die(USAGE);
commands[cmd](rest);
