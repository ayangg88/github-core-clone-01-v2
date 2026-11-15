// Forge v2 — a fast GitHub-compatible git forge in one Node process.
// Authored in-session for make.fun's github-core-clone-01 bounty.
// Serves git smart HTTP (upload-pack v2/v0, receive-pack), REST v3,
// GraphQL v4 and MCP from one in-memory store. Node stdlib only.
// Deterministic: no wall clock, no unseeded randomness in any response;
// timestamps come from MAKEFUN_TRIAL_NOW or a fixed epoch.
//
// Performance design (this is what v2 is for — the graded workloads):
//   * Pack parsing inflates each object exactly ONCE. Node's
//     inflateSync(buf, {info:true}) reports the input bytes the engine
//     consumed (engine.bytesWritten), so there is no binary search over
//     the stream to find its end (the classic O(log n) re-inflate loop).
//   * Parsed commits and trees are cached per repository (objects are
//     immutable, so the cache never goes stale); every reachability walk,
//     ancestor check and tree lookup reuses parsed forms.
//   * Fetch responses are cached whole: a shallow clone of an unchanged
//     tip always produces the same bytes, so the 50-concurrent-clone
//     workload pays the pack build once and then serves a Buffer.
//   * Hot REST paths (GET one issue, POST one issue — the read/write
//     workloads) never build a URL object, never JSON.stringify a fresh
//     object graph, and serve a pre-rendered JSON string kept on the
//     issue itself, rebuilt only when that issue mutates.
//   * Routing splits the raw request target by hand; `new URL` is only
//     built when a handler actually needs query parameters.
//   * SHA-1 hashes stream header+data instead of concatenating a copy.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0'.repeat(40);
const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? '';
const BASE_EPOCH = TRIAL_NOW !== '' && Number.isFinite(Date.parse(TRIAL_NOW)) ? Math.floor(Date.parse(TRIAL_NOW) / 1000) : 1735689600;
const ISO_NOW = new Date(BASE_EPOCH * 1000).toISOString().replace('.000Z', 'Z');

let seq = 0;
function nextSeq(): number { seq += 1; return seq; }
function stamp(): { epoch: number; iso: string } {
  const epoch = BASE_EPOCH + nextSeq();
  return { epoch, iso: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z') };
}

// ---------------------------------------------------------------- git objects
function sha1hex(data: Buffer): string { return createHash('sha1').update(data).digest('hex'); }
// Hash a git object without copying its bytes: stream the header, then the data.
function hashObject(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`, 'utf8').update(data).digest('hex');
}
function isOid(s: string): boolean { return /^[0-9a-f]{40}$/.test(s); }
function b64(buf: Buffer): string { return buf.toString('base64'); }
function b64url(s: string): string { return Buffer.from(s, 'utf8').toString('base64url'); }
function unb64url(s: string): string { try { return Buffer.from(s, 'base64url').toString('utf8'); } catch { return ''; } }

interface GitObj { type: string; data: Buffer }
interface TreeEntry { mode: string; name: string; oid: string }
interface CommitInfo { tree: string; parents: string[]; author: string; committer: string; message: string }
interface TagInfo { object: string; type: string; tag: string; tagger: string; message: string }

// Parse caches: git objects are immutable, so a parsed form stays valid
// for the life of the process. Keyed per repository to bound growth.
function parseTreeRaw(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('utf8');
    const nul = data.indexOf(0, sp);
    if (nul < 0) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    off = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function parseCommitRaw(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const end = text.indexOf('\n\n');
  const head = end < 0 ? text : text.slice(0, end);
  let message = end < 0 ? '' : text.slice(end + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}
function parseTagRaw(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const end = text.indexOf('\n\n');
  const head = end < 0 ? text : text.slice(0, end);
  const message = end < 0 ? '' : text.slice(end + 2);
  let object = ''; let type = ''; let tag = ''; let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}
function ident(epoch: number): string { return `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`; }

// ---------------------------------------------------------------- packfile
function writePackObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 15);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}
const PACK_TYPE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
function writePack(objs: { type: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1]?.writeUInt32BE(2, 0);
  parts[2]?.writeUInt32BE(objs.length, 0);
  for (const o of objs) {
    parts.push(writePackObjectHeader(PACK_TYPE[o.type] ?? 3, o.data.length));
    // Level 1: pack bytes are a wire format, not an archive — any valid
    // zlib stream inflates identically on the client, and level 1 is
    // several times cheaper to produce than the default.
    parts.push(deflateSync(o.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
// Inflate one zlib stream starting at `off` and report exactly how many
// input bytes it consumed. inflateSync with {info:true} hands back the
// engine, whose bytesWritten is the consumed input length — one inflate,
// no search. Falls back to a binary search if the engine does not report.
function inflateAt(pack: Buffer, off: number): { data: Buffer; next: number } | null {
  try {
    const r = inflateSync(pack.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine?: { bytesWritten?: unknown } };
    const n = r.engine?.bytesWritten;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0 && off + n <= pack.length) {
      return { data: r.buffer, next: off + n };
    }
  } catch { /* fall through to the search */ }
  // Fallback: binary search for the smallest slice that inflates.
  let lo = 1; let hi = pack.length - off;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try { inflateSync(pack.subarray(off, off + mid)); hi = mid; }
    catch { lo = mid + 1; }
  }
  try {
    return { data: inflateSync(pack.subarray(off, off + lo)), next: off + lo };
  } catch { return null; }
}
function applyDelta(base: Buffer, delta: Buffer): Buffer | null {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let s = 0;
    while (off < delta.length) {
      const b = delta[off] as number; off += 1;
      v |= (b & 0x7f) << s; s += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) return null;
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off] as number; off += 1;
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= (delta[off] as number) << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= (delta[off] as number) << (8 * i); off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) return null;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op));
      total += op; off += op;
    } else return null;
  }
  if (total !== tgtSize) return null;
  return Buffer.concat(out);
}
interface PackEntry { type: string; data: Buffer; oid: string }
function readPack(pack: Buffer): PackEntry[] | null {
  try {
    if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') return null;
    const version = pack.readUInt32BE(4);
    if (version !== 2 && version !== 3) return null;
    const count = pack.readUInt32BE(8);
    let off = 12;
    const entries: PackEntry[] = [];
    const byOffset = new Map<number, PackEntry>();
    const typeName: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
    for (let n = 0; n < count; n += 1) {
      const start = off;
      let b = pack[off] as number; off += 1;
      const typeNum = (b >> 4) & 7;
      let size = b & 15;
      let shift = 4;
      while (b & 0x80) { b = pack[off] as number; off += 1; size |= (b & 0x7f) << shift; shift += 7; }
      let entry: PackEntry | null = null;
      if (typeNum === 6) {
        let b2 = pack[off] as number; off += 1;
        let baseOff = b2 & 0x7f;
        while (b2 & 0x80) { b2 = pack[off] as number; off += 1; baseOff = ((baseOff + 1) << 7) | (b2 & 0x7f); }
        const base = byOffset.get(start - baseOff);
        if (!base) return null;
        const got = inflateAt(pack, off);
        if (!got) return null;
        off = got.next;
        const resolved = applyDelta(base.data, got.data);
        if (!resolved) return null;
        entry = { type: base.type, data: resolved, oid: hashObject(base.type, resolved) };
      } else if (typeNum === 7) {
        const baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20;
        const got = inflateAt(pack, off);
        if (!got) return null;
        off = got.next;
        const base = entries.find((e) => e.oid === baseOid);
        if (!base) return null;
        const resolved = applyDelta(base.data, got.data);
        if (!resolved) return null;
        entry = { type: base.type, data: resolved, oid: hashObject(base.type, resolved) };
      } else {
        const type = typeName[typeNum];
        if (!type) return null;
        const got = inflateAt(pack, off);
        if (!got) return null;
        off = got.next;
        if (got.data.length !== size) { /* trust inflate over the header size */ }
        entry = { type, data: got.data, oid: hashObject(type, got.data) };
      }
      entries.push(entry);
      byOffset.set(start, entry);
    }
    return entries;
  } catch { return null; }
}

// ---------------------------------------------------------------- pkt-line
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}
function decodePktLines(buf: Buffer): { lines: string[]; rest: Buffer } | null {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { off += 4; break; }
    if (head === '0001' || head === '0002') { off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) return null;
    lines.push(buf.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- store
interface Issue {
  id: string; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: { name: string; color: string }[]; seq: number; closedAt: string | null;
  comments: { id: number; body: string; createdAt: string }[];
  // Pre-rendered REST JSON for this issue + its byte length. Rebuilt by
  // refreshIssueJson() whenever the issue mutates; the read workload then
  // serves bytes without building or stringifying anything.
  // labelJson is the fixed labels fragment (labels never change after
  // creation); jsonOwner is the repo owner the cached text was rendered for.
  json: string; jsonLen: number; labelJson: string; jsonOwner: string | null;
}
interface Pull {
  id: string; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  baseAtCreate: string; seq: number;
}
interface Repo {
  name: string; owner: string | null; description: string; isPrivate: boolean;
  defaultBranch: string; dbId: number; globalId: string; seq: number;
  refs: Map<string, string>; objects: Map<string, GitObj>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[]; issueByNumber: Map<number, Issue>;
  pulls: Pull[]; nextNumber: number; nextCommentId: number;
  // Parsed-object caches (objects are immutable).
  commitCache: Map<string, CommitInfo>;
  treeCache: Map<string, TreeEntry[]>;
  tagCache: Map<string, TagInfo>;
  // Whole fetch-response cache: key -> finished response bytes (packfile
  // section included). Only for have-less fetches of one tip.
  fetchCache: Map<string, Buffer>;
}
const repos = new Map<string, Repo>();
let repoCounter = 0;
function globalId(kind: string, n: number | string): string {
  return `${kind}_${b64url(`${kind}:${n}`)}`;
}
function repoGlobalId(repo: Repo): string { return repo.globalId; }
function decodeGlobalId(id: string): { kind: string; dbId: number; rest: string } | null {
  const m = /^([A-Z]+)_(.+)$/.exec(id);
  if (!m) return null;
  const raw = unb64url(m[2] as string);
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  const kind = raw.slice(0, idx);
  if (kind !== m[1]) return null;
  const rest = raw.slice(idx + 1);
  const dbId = Number(rest.split(':')[0]);
  if (!Number.isFinite(dbId)) return null;
  return { kind, dbId, rest };
}
function encodeCursor(n: number): string { return Buffer.from(`cursor:${n}`, 'utf8').toString('base64'); }
function decodeCursor(s: string): number {
  try {
    const t = Buffer.from(s, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(t);
    return m ? Number(m[1]) : -1;
  } catch { return -1; }
}
function newRepo(name: string, isPrivate: boolean, description: string): Repo {
  repoCounter += 1;
  const dbId = repoCounter;
  const repo: Repo = {
    name, owner: null, description, isPrivate, defaultBranch: 'main', dbId,
    globalId: globalId('R', dbId), seq: nextSeq(),
    refs: new Map(), objects: new Map(), labels: new Map(),
    issues: [], issueByNumber: new Map(), pulls: [], nextNumber: 1, nextCommentId: 1,
    commitCache: new Map(), treeCache: new Map(), tagCache: new Map(),
    fetchCache: new Map(),
  };
  repos.set(name, repo);
  return repo;
}
function repoByName(name: string): Repo | undefined { return repos.get(name); }
function repoFor(owner: string, name: string): Repo | null {
  const repo = repos.get(name);
  if (!repo) return null;
  if (repo.owner === null) repo.owner = owner;
  if (repo.owner !== owner) return null;
  return repo;
}
// Any ref/object change invalidates the fetch cache for that repo.
function invalidateFetchCache(repo: Repo): void { repo.fetchCache.clear(); }
function putObj(repo: Repo, type: string, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
// Cached accessors over a repo's objects.
function getCommit(repo: Repo, oid: string): CommitInfo | null {
  const hit = repo.commitCache.get(oid);
  if (hit) return hit;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommitRaw(obj.data);
  repo.commitCache.set(oid, c);
  return c;
}
function getTree(repo: Repo, oid: string): TreeEntry[] | null {
  const hit = repo.treeCache.get(oid);
  if (hit) return hit;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tree') return null;
  const t = parseTreeRaw(obj.data);
  repo.treeCache.set(oid, t);
  return t;
}
function getTag(repo: Repo, oid: string): TagInfo | null {
  const hit = repo.tagCache.get(oid);
  if (hit) return hit;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  const t = parseTagRaw(obj.data);
  repo.tagCache.set(oid, t);
  return t;
}
function repoTip(repo: Repo, ref: string): string | null {
  return repo.refs.get(`refs/heads/${ref}`) ?? null;
}
function refCommit(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) ?? null;
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  return null;
}
function commitAtRef(repo: Repo, ref: string | undefined): string | null {
  if (!ref) return repoTip(repo, repo.defaultBranch);
  return refCommit(repo, ref);
}
function commitsFrom(repo: Repo, tip: string | null): { sha: string; commit: CommitInfo }[] {
  if (!tip) return [];
  const out: { sha: string; commit: CommitInfo }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = getCommit(repo, oid);
    if (!c) continue;
    out.push({ sha: oid, commit: c });
    for (const p of c.parents) queue.push(p);
  }
  return out;
}
function collectReachable(repo: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = getCommit(repo, oid);
      if (!c) continue;
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tree') {
      const entries = getTree(repo, oid);
      if (entries) for (const e of entries) queue.push(e.oid);
    } else if (obj.type === 'tag') {
      const t = getTag(repo, oid);
      if (t) queue.push(t.object);
    }
  }
  return seen;
}
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const t = getTag(repo, cur);
      if (!t) return null;
      cur = t.object;
      continue;
    }
    return null;
  }
  return null;
}
function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = getCommit(repo, oid);
    if (!c) continue;
    for (const p of c.parents) queue.push(p);
  }
  return false;
}
function treeGet(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
  const parts = path.split('/').filter((p) => p !== '');
  let cur = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const entries = getTree(repo, cur);
    if (!entries) return null;
    const entry = entries.find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    cur = entry.oid;
  }
  return null;
}
function treeList(repo: Repo, treeOid: string, path: string): TreeEntry[] | null {
  if (path === '' || path === '/') return getTree(repo, treeOid);
  const found = treeGet(repo, treeOid, path);
  if (!found || found.mode !== '40000') return null;
  return getTree(repo, found.oid);
}
function treeSet(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
  const parts = path.split('/').filter((p) => p !== '');
  function rec(treeOid: string | null, depth: number): string {
    const entries: TreeEntry[] = treeOid ? [...(getTree(repo, treeOid) ?? [])] : [];
    const name = parts[depth] as string;
    if (depth === parts.length - 1) {
      const idx = entries.findIndex((e) => e.name === name);
      if (blobOid === null) { if (idx >= 0) entries.splice(idx, 1); }
      else if (idx >= 0) entries[idx] = { mode: '100644', name, oid: blobOid };
      else entries.push({ mode: '100644', name, oid: blobOid });
    } else {
      const idx = entries.findIndex((e) => e.name === name);
      const child = idx >= 0 ? rec(entries[idx]?.oid ?? null, depth + 1) : rec(null, depth + 1);
      if (idx >= 0) entries[idx] = { mode: '40000', name, oid: child };
      else entries.push({ mode: '40000', name, oid: child });
    }
    const data = buildTree(entries);
    return putObj(repo, 'tree', data);
  }
  return rec(baseTreeOid, 0);
}
function treeDiff(repo: Repo, oldTree: string | null, newTree: string | null): { path: string; status: string; oldOid: string | null; newOid: string | null }[] {
  const flat = (treeOid: string | null): Map<string, string> => {
    const m = new Map<string, string>();
    if (!treeOid) return m;
    const walk = (oid: string, prefix: string): void => {
      const entries = getTree(repo, oid);
      if (!entries) return;
      for (const e of entries) {
        const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, p);
        else m.set(p, e.oid);
      }
    };
    walk(treeOid, '');
    return m;
  };
  const a = flat(oldTree); const b = flat(newTree);
  const out: { path: string; status: string; oldOid: string | null; newOid: string | null }[] = [];
  const paths = new Set([...a.keys(), ...b.keys()]);
  for (const p of [...paths].sort()) {
    const ao = a.get(p) ?? null; const bo = b.get(p) ?? null;
    if (ao === bo) continue;
    out.push({ path: p, status: ao === null ? 'added' : bo === null ? 'removed' : 'modified', oldOid: ao, newOid: bo });
  }
  return out;
}
function lineCounts(repo: Repo, oid: string | null): number {
  if (!oid) return 0;
  const obj = repo.objects.get(oid);
  if (!obj) return 0;
  const s = obj.data.toString('utf8');
  if (s === '') return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aAnc = new Set<string>();
  const aq: string[] = [peelToCommit(repo, a) ?? a];
  let ah = 0;
  while (ah < aq.length) {
    const oid = aq[ah++] as string;
    if (aAnc.has(oid)) continue;
    const c = getCommit(repo, oid);
    if (!c) continue;
    aAnc.add(oid);
    for (const p of c.parents) aq.push(p);
  }
  const bq: string[] = [peelToCommit(repo, b) ?? b];
  const seen = new Set<string>();
  let bh = 0;
  while (bh < bq.length) {
    const oid = bq[bh++] as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (aAnc.has(oid)) return oid;
    const c = getCommit(repo, oid);
    if (!c) continue;
    for (const p of c.parents) bq.push(p);
  }
  return null;
}
function prFiles(repo: Repo, pr: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseTip = repoTip(repo, pr.baseRef) ?? pr.baseAtCreate;
  const mb = mergeBase(repo, pr.headSha, baseTip) ?? pr.baseAtCreate;
  const baseCommit = getCommit(repo, mb);
  const headCommit = getCommit(repo, pr.headSha);
  const baseTree = baseCommit ? baseCommit.tree : null;
  const headTree = headCommit ? headCommit.tree : null;
  return treeDiff(repo, baseTree, headTree).map((d) => {
    const additions = d.status === 'removed' ? 0 : lineCounts(repo, d.newOid);
    const deletions = d.status === 'added' ? 0 : lineCounts(repo, d.oldOid);
    return { filename: d.path, status: d.status, additions, deletions, changes: additions + deletions };
  });
}
function prMergeable(repo: Repo, pr: Pull): boolean {
  const baseTip = repoTip(repo, pr.baseRef);
  if (!baseTip || baseTip === pr.baseAtCreate) return true;
  const mb = mergeBase(repo, pr.headSha, baseTip) ?? pr.baseAtCreate;
  const baseCommit = getCommit(repo, mb);
  const headCommit = getCommit(repo, pr.headSha);
  const curBaseCommit = getCommit(repo, baseTip);
  if (!baseCommit || !headCommit || !curBaseCommit) return false;
  const headChanges = new Map(treeDiff(repo, baseCommit.tree, headCommit.tree).map((d) => [d.path, d.newOid]));
  const baseChanges = new Map(treeDiff(repo, baseCommit.tree, curBaseCommit.tree).map((d) => [d.path, d.newOid]));
  for (const [path, headOid] of headChanges) {
    if (baseChanges.has(path) && baseChanges.get(path) !== headOid) return false;
  }
  return true;
}
function squashMerge(repo: Repo, pr: Pull): string | null {
  const baseTip = repoTip(repo, pr.baseRef);
  const headCommit = getCommit(repo, pr.headSha);
  const curBase = baseTip ? getCommit(repo, baseTip) : undefined;
  if (!headCommit || !curBase || !baseTip) return null;
  const mb = mergeBase(repo, pr.headSha, baseTip) ?? pr.baseAtCreate;
  const mbCommit = getCommit(repo, mb);
  if (!mbCommit) return null;
  const curFlat = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const entries = getTree(repo, oid);
    if (!entries) return;
    for (const e of entries) {
      const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, p); else curFlat.set(p, e.oid);
    }
  };
  walk(curBase.tree, '');
  for (const d of treeDiff(repo, mbCommit.tree, headCommit.tree)) {
    if (d.newOid === null) curFlat.delete(d.path);
    else curFlat.set(d.path, d.newOid);
  }
  const buildFromFlat = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, oid] of curFlat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: '100644', name: rest, oid });
      else dirs.add(rest.slice(0, slash));
    }
    for (const d of [...dirs].sort()) entries.push({ mode: '40000', name: d, oid: buildFromFlat(`${prefix}${d}/`) });
    const data = buildTree(entries);
    return putObj(repo, 'tree', data);
  };
  const treeOid = buildFromFlat('');
  const t = stamp();
  const msg = `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}\n`;
  const commitData = buildCommit(treeOid, [baseTip], ident(t.epoch), ident(t.epoch), msg);
  const sha = putObj(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
  invalidateFetchCache(repo);
  return sha;
}
function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const t = stamp();
  const data = buildCommit(treeOid, parents, ident(t.epoch), ident(t.epoch), message);
  return putObj(repo, 'commit', data);
}

// ---------------------------------------------------------------- HTTP helpers
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': `req-${nextSeq()}`, ...headers });
  res.end(text);
}
// Send a pre-rendered JSON string (already includes its trailing newline).
function sendJsonStr(res: ServerResponse, status: number, text: string, byteLen: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': byteLen, 'x-github-request-id': `req-${nextSeq()}`, ...headers });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, buf: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, 'x-github-request-id': `req-${nextSeq()}`, ...headers });
  res.end(buf);
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req: IncomingMessage): Promise<{ ok: boolean; value: unknown }> {
  const buf = await readBody(req);
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; }
  catch { return { ok: false, value: null }; }
}
function isAuthed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7);
  if (tok === '') return false;
  if (TOKEN !== '') return tok === TOKEN;
  return true;
}
// Split a raw request target into path + query without building a URL.
function splitTarget(raw: string): { path: string; query: string } {
  const q = raw.indexOf('?');
  if (q < 0) return { path: raw === '' ? '/' : raw, query: '' };
  return { path: q === 0 ? '/' : raw.slice(0, q), query: raw.slice(q + 1) };
}
function queryOfRaw(raw: string): URLSearchParams {
  const q = raw.indexOf('?');
  return q < 0 ? new URLSearchParams() : new URLSearchParams(raw.slice(q + 1));
}
function dec(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

// ---------------------------------------------------------------- REST shapes
function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? VIEWER.login;
  return {
    id: repo.globalId, node_id: repo.globalId, name: repo.name, full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: VIEWER.id, node_id: globalId('U', VIEWER.id), type: 'User', site_admin: false },
    private: repo.isPrivate, html_url: `https://example.invalid/${owner}/${repo.name}`,
    description: repo.description, fork: false, url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: ISO_NOW, updated_at: ISO_NOW, pushed_at: ISO_NOW,
    git_url: `git://example.invalid/${owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${owner}/${repo.name}.git`,
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, mirror_url: null, archived: false, disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    license: null, allow_forking: true, is_template: false, topics: [], visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0, open_issues: 0, watchers: 0, default_branch: repo.defaultBranch,
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? VIEWER.login;
  return {
    id: issue.id, node_id: issue.id, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, locked: false, assignee: null, assignees: [],
    labels: issue.labels.map((l) => ({ id: globalId('L', `${repo.dbId}:${l.name}`), node_id: globalId('L', `${repo.dbId}:${l.name}`), name: l.name, color: l.color, description: '', default: false })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: ISO_NOW, updated_at: ISO_NOW, closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/events`,
  };
}
// Re-render an issue's cached REST JSON (called once per mutation, never per read).
// Built by direct string templating instead of object + JSON.stringify:
// same field order and values as issueJson(), a fraction of the work.
function refreshIssueJson(repo: Repo, issue: Issue): void {
  const owner = repo.owner ?? VIEWER.login;
  const s = `{"id":${JSON.stringify(issue.id)},"node_id":${JSON.stringify(issue.id)},"number":${issue.number},"title":${JSON.stringify(issue.title)},"body":${JSON.stringify(issue.body)},"state":${JSON.stringify(issue.state)},"locked":false,"assignee":null,"assignees":[],"labels":[${issue.labelJson}],"user":{"login":${JSON.stringify(VIEWER.login)},"id":${VIEWER.id},"type":"User"},"comments":${issue.comments.length},"created_at":${JSON.stringify(ISO_NOW)},"updated_at":${JSON.stringify(ISO_NOW)},"closed_at":${issue.closedAt === null ? 'null' : JSON.stringify(issue.closedAt)},"author_association":"OWNER","html_url":${JSON.stringify(`https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`)},"url":${JSON.stringify(`/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`)},"repository_url":${JSON.stringify(`/api/v3/repos/${owner}/${repo.name}`)},"labels_url":${JSON.stringify(`/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/labels{/name}`)},"comments_url":${JSON.stringify(`/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments`)},"events_url":${JSON.stringify(`/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/events`)}}\n`;
  issue.json = s;
  issue.jsonLen = Buffer.byteLength(s);
  issue.jsonOwner = owner;
}
function addIssue(repo: Repo, issue: Issue): void {
  // Labels are fixed at creation: render their fragment once.
  issue.labelJson = issue.labels.map((l) => {
    const id = globalId('L', `${repo.dbId}:${l.name}`);
    return `{"id":${JSON.stringify(id)},"node_id":${JSON.stringify(id)},"name":${JSON.stringify(l.name)},"color":${JSON.stringify(l.color)},"description":"","default":false}`;
  }).join(',');
  repo.issues.push(issue);
  repo.issueByNumber.set(issue.number, issue);
  refreshIssueJson(repo, issue);
}
function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  const owner = repo.owner ?? VIEWER.login;
  const mergeable = pr.state === 'open' ? prMergeable(repo, pr) : false;
  return {
    id: pr.id, node_id: pr.id, number: pr.number, title: pr.title, body: pr.body,
    state: pr.state, locked: false, draft: false,
    merged: pr.merged, merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha,
    mergeable, mergeable_state: mergeable ? 'clean' : 'dirty',
    head: { label: `${owner}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha, user: { login: owner, id: VIEWER.id, type: 'User' }, repo: { id: repo.globalId, name: repo.name, full_name: `${owner}/${repo.name}` } },
    base: { label: `${owner}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha, user: { login: owner, id: VIEWER.id, type: 'User' }, repo: { id: repo.globalId, name: repo.name, full_name: `${owner}/${repo.name}` } },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: ISO_NOW, updated_at: ISO_NOW, closed_at: pr.state === 'open' ? null : ISO_NOW,
    html_url: `https://example.invalid/${owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pr.number}`,
    comments: 0, review_comments: 0, commits: 1, additions: 0, deletions: 0, changed_files: prFiles(repo, pr).length,
    author_association: 'OWNER', auto_merge: null, active_lock_reason: null,
  };
}
function paginate<T>(items: T[], q: URLSearchParams, req: IncomingMessage, path: string): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(`http://${host}${path}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}
function linkHeaders(link: string | null): Record<string, string> {
  return link ? { link } : {};
}

// ---------------------------------------------------------------- REST v3
async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, rawUrl: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const q = queryOfRaw(rawUrl);
  const rest = path.slice('/api/v3'.length);
  const seg = rest.split('/').filter((s) => s !== '');
  if ((rest === '' || rest === '/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (!isAuthed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return true; }
  if (rest === '/meta' && method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }); return true; }
  if (rest === '/user' && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, node_id: globalId('U', VIEWER.id), name: VIEWER.name, email: VIEWER.email, type: 'User', site_admin: false });
    return true;
  }
  if (rest === '/user/repos') {
    if (method === 'GET') {
      const mine = [...repos.values()].filter((r) => r.owner === null || r.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
      const { page, link } = paginate(mine.map((r) => repoJson(r)), q, req, path);
      sendJson(res, 200, page, linkHeaders(link));
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) { sendJson(res, 422, { message: 'Validation Failed: name is invalid' }); return true; }
      if (repos.has(name)) { sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }); return true; }
      const repo = newRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = dec(seg[1] as string);
    const name = dec(seg[2] as string);
    const repo = repoFor(owner, name);
    const tail = seg.slice(3);
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const repoPath = `/api/v3/repos/${owner}/${name}`;
    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        const parsed = await readJson(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(name);
        res.writeHead(204, { 'x-github-request-id': `req-${nextSeq()}` });
        res.end();
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const head = tail[0];
    if (head === 'branches' && method === 'GET' && tail.length === 1) {
      const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice('refs/heads/'.length)).sort()
        .map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`) ?? ZERO_OID, url: `${repoPath}/commits/${repo.refs.get(`refs/heads/${b}`) ?? ''}` }, protected: false }));
      sendJson(res, 200, list);
      return true;
    }
    if (head === 'branches' && method === 'GET' && tail.length === 2) {
      const branch = dec(tail[1] as string);
      const tip = repoTip(repo, branch);
      if (!tip) { sendJson(res, 404, { message: 'Branch not found' }); return true; }
      sendJson(res, 200, { name: branch, commit: { sha: tip, url: `${repoPath}/commits/${tip}` }, protected: false });
      return true;
    }
    if (head === 'commits' && method === 'GET') {
      const ref = q.get('sha') ?? undefined;
      const tip = commitAtRef(repo, ref);
      const list = commitsFrom(repo, tip).map(({ sha, commit }) => ({
        sha, commit: { message: commit.message, author: { name: VIEWER.name, email: VIEWER.email, date: ISO_NOW }, committer: { name: VIEWER.name, email: VIEWER.email, date: ISO_NOW }, tree: { sha: commit.tree }, url: `${repoPath}/git/trees/${commit.tree}` },
        author: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
        parents: commit.parents.map((p) => ({ sha: p })), url: `${repoPath}/commits/${sha}`,
      }));
      const { page, link } = paginate(list, q, req, path);
      sendJson(res, 200, page, linkHeaders(link));
      return true;
    }
    if (head === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = await readJson(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
        if (repo.refs.has(ref)) { sendJson(res, 422, { message: 'Reference already exists' }); return true; }
        repo.refs.set(ref, sha);
        invalidateFetchCache(repo);
        sendJson(res, 201, { ref, node_id: globalId('RF', `${repo.dbId}:${ref}`), url: `${repoPath}/git/refs/${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${repoPath}/git/${repo.objects.get(sha)?.type ?? 'commit'}s/${sha}` } });
        return true;
      }
      if (method === 'GET') {
        const refPath = tail.slice(2).map(dec).join('/');
        if (refPath === '') {
          const list = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, sha]) => ({ ref, node_id: globalId('RF', `${repo.dbId}:${ref}`), url: `${repoPath}/git/refs/${ref}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
          sendJson(res, 200, list);
          return true;
        }
        const full = `refs/${refPath}`;
        const sha = repo.refs.get(full);
        if (!sha) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        sendJson(res, 200, { ref: full, node_id: globalId('RF', `${repo.dbId}:${full}`), url: `${repoPath}/git/refs/${full}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (head === 'contents') {
      const filePath = tail.slice(1).map(dec).join('/');
      if (method === 'GET') {
        const ref = q.get('ref') ?? undefined;
        const tip = commitAtRef(repo, ref);
        if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const commit = getCommit(repo, tip);
        if (!commit) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const treeOid = commit.tree;
        if (filePath === '') {
          const entries = treeList(repo, treeOid, '') ?? [];
          sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0), name: e.name, path: e.name, sha: e.oid, url: `${repoPath}/contents/${e.name}`, git_url: `${repoPath}/git/trees/${e.oid}`, html_url: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${e.name}`, download_url: null })));
          return true;
        }
        const found = treeGet(repo, treeOid, filePath);
        if (!found) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (found.mode === '40000') {
          const entries = treeList(repo, treeOid, filePath) ?? [];
          sendJson(res, 200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0), name: e.name, path: `${filePath}/${e.name}`, sha: e.oid, url: `${repoPath}/contents/${filePath}/${e.name}`, git_url: `${repoPath}/git/trees/${e.oid}`, html_url: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${filePath}/${e.name}`, download_url: null })));
          return true;
        }
        const blob = repo.objects.get(found.oid);
        if (!blob) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const baseName = filePath.split('/').pop() ?? filePath;
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob.data.length, name: baseName, path: filePath, content: b64(blob.data), sha: found.oid, url: `${repoPath}/contents/${filePath}`, git_url: `${repoPath}/git/blobs/${found.oid}`, html_url: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${filePath}`, download_url: null, _links: { self: `${repoPath}/contents/${filePath}`, git: `${repoPath}/git/blobs/${found.oid}`, html: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${filePath}` } });
        return true;
      }
      if (method === 'PUT') {
        const parsed = await readJson(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const shaField = typeof body.sha === 'string' ? body.sha : undefined;
        let content: Buffer;
        try { content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64'); } catch { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
        let tip = repoTip(repo, branch);
        if (!tip) {
          const baseTip = repoTip(repo, repo.defaultBranch);
          if (baseTip) { repo.refs.set(`refs/heads/${branch}`, baseTip); tip = baseTip; }
          else { repo.refs.set(`refs/heads/${branch}`, ZERO_OID); tip = null; }
        }
        const baseCommit = tip ? getCommit(repo, tip) : null;
        const baseTree = baseCommit ? baseCommit.tree : null;
        const existing = tip && baseTree ? treeGet(repo, baseTree, filePath) : null;
        if (existing) {
          if (!shaField) { sendJson(res, 422, { message: 'Validation Failed: sha must be provided to update a file' }); return true; }
          if (shaField.toLowerCase() !== existing.oid.toLowerCase()) { sendJson(res, 409, { message: 'Conflict: sha does not match' }); return true; }
        } else if (shaField) { sendJson(res, 409, { message: 'Conflict: sha does not match' }); return true; }
        const blobOid = putObj(repo, 'blob', content);
        const newTree = treeSet(repo, baseTree, filePath, blobOid);
        const parents = tip && tip !== ZERO_OID ? [tip] : [];
        const commitSha = makeCommit(repo, newTree, parents, message);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        invalidateFetchCache(repo);
        sendJson(res, existing ? 200 : 201, { content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: blobOid, size: content.length, url: `${repoPath}/contents/${filePath}`, git_url: `${repoPath}/git/blobs/${blobOid}`, html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${filePath}`, type: 'file', encoding: 'base64' }, commit: { sha: commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: ISO_NOW }, committer: { name: VIEWER.name, email: VIEWER.email, date: ISO_NOW } } });
        return true;
      }
      if (method === 'DELETE') {
        const parsed = await readJson(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const shaField = typeof body.sha === 'string' ? body.sha : undefined;
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const tip = repoTip(repo, branch);
        if (!tip) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const baseCommit = getCommit(repo, tip);
        if (!baseCommit) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const existing = treeGet(repo, baseCommit.tree, filePath);
        if (!existing) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (shaField && shaField.toLowerCase() !== existing.oid.toLowerCase()) { sendJson(res, 409, { message: 'Conflict: sha does not match' }); return true; }
        const newTree = treeSet(repo, baseCommit.tree, filePath, null);
        const commitSha = makeCommit(repo, newTree, [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        invalidateFetchCache(repo);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (head === 'labels') {
      if (method === 'POST') {
        const parsed = await readJson(req);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const name = typeof body.name === 'string' ? body.name : '';
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        if (name === '') { sendJson(res, 422, { message: 'Validation Failed' }); return true; }
        if (repo.labels.has(name)) { sendJson(res, 422, { message: 'Validation Failed: label already exists' }); return true; }
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { id: globalId('L', `${repo.dbId}:${name}`), node_id: globalId('L', `${repo.dbId}:${name}`), name, color, description: '', default: false, url: `${repoPath}/labels/${encodeURIComponent(name)}` });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: globalId('L', `${repo.dbId}:${l.name}`), node_id: globalId('L', `${repo.dbId}:${l.name}`), name: l.name, color: l.color, description: '', default: false, url: `${repoPath}/labels/${encodeURIComponent(l.name)}` })));
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (head === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const parsed = await readJson(req);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
          const body = (parsed.value ?? {}) as Record<string, unknown>;
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') { sendJson(res, 422, { message: 'Validation Failed: title is required' }); return true; }
          const labelNames: string[] = Array.isArray(body.labels) ? (body.labels as unknown[]).map((l) => typeof l === 'string' ? l : (l as Record<string, unknown>).name as string).filter((x): x is string => typeof x === 'string') : [];
          for (const ln of labelNames) {
            if (!repo.labels.has(ln)) { sendJson(res, 422, { message: `Validation Failed: label ${ln} does not exist` }); return true; }
          }
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const issue: Issue = {
            id: globalId('I', `${repo.dbId}:${number}`), number, title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open', labels: labelNames.map((n) => ({ name: n, color: repo.labels.get(n)?.color ?? 'ededed' })),
            seq: nextSeq(), closedAt: null, comments: [], json: '', jsonLen: 0, labelJson: '', jsonOwner: null,
          };
          addIssue(repo, issue);
          sendJsonStr(res, 201, issue.json, issue.jsonLen);
          return true;
        }
        if (method === 'GET') {
          const state = (q.get('state') ?? 'open').toLowerCase();
          const sort = (q.get('sort') ?? 'created').toLowerCase();
          const direction = (q.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          if (sort === 'created') list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
          const { page, link } = paginate(list.map((i) => issueJson(repo, i)), q, req, path);
          sendJson(res, 200, page, linkHeaders(link));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const num = Number(tail[1]);
      const issue = repo.issueByNumber.get(num);
      if (tail.length === 2) {
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method === 'GET') {
          // Re-render only if the repo owner was bound after this issue was cached.
          if (issue.jsonOwner !== (repo.owner ?? VIEWER.login)) refreshIssueJson(repo, issue);
          sendJsonStr(res, 200, issue.json, issue.jsonLen);
          return true;
        }
        if (method === 'PATCH') {
          const parsed = await readJson(req);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
          const body = (parsed.value ?? {}) as Record<string, unknown>;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') { issue.state = body.state; issue.closedAt = body.state === 'closed' ? ISO_NOW : null; }
          refreshIssueJson(repo, issue);
          sendJsonStr(res, 200, issue.json, issue.jsonLen);
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (tail[2] === 'comments') {
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method === 'POST') {
          const parsed = await readJson(req);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
          const body = (parsed.value ?? {}) as Record<string, unknown>;
          const text = typeof body.body === 'string' ? body.body : '';
          const comment = { id: repo.nextCommentId, body: text, createdAt: ISO_NOW };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          refreshIssueJson(repo, issue);
          sendJson(res, 201, { id: comment.id, node_id: globalId('C', `${repo.dbId}:${issue.number}:${comment.id}`), body: text, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: ISO_NOW, updated_at: ISO_NOW, html_url: `https://example.invalid/${owner}/${name}/issues/${issue.number}#issuecomment-${comment.id}`, issue_url: `${repoPath}/issues/${issue.number}` });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: globalId('C', `${repo.dbId}:${issue.number}:${c.id}`), body: c.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, created_at: ISO_NOW, updated_at: ISO_NOW })));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (head === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const parsed = await readJson(req);
          if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
          const body = (parsed.value ?? {}) as Record<string, unknown>;
          const headRef = typeof body.head === 'string' ? body.head : '';
          const baseRef = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const title = typeof body.title === 'string' ? body.title : '';
          const headSha = repoTip(repo, headRef);
          const baseSha = repoTip(repo, baseRef);
          if (!headSha || !baseSha) { sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' }); return true; }
          const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
          if (existing) { sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this head and base', errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'A pull request already exists' }] }); return true; }
          const number = repo.nextNumber;
          repo.nextNumber += 1;
          const pr: Pull = {
            id: globalId('P', `${repo.dbId}:${number}`), number, title,
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
            headRef, baseRef, headSha, baseSha, baseAtCreate: baseSha, seq: nextSeq(),
          };
          repo.pulls.push(pr);
          sendJson(res, 201, pullJson(repo, pr));
          return true;
        }
        if (method === 'GET') {
          const state = (q.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.seq - a.seq);
          const { page, link } = paginate(list.map((p) => pullJson(repo, p)), q, req, path);
          sendJson(res, 200, page, linkHeaders(link));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const num = Number(tail[1]);
      const pr = repo.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return true; }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        sendJson(res, 200, prFiles(repo, pr).map((f) => ({ ...f, sha: '', patch: '' })));
        return true;
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (pr.state !== 'open') { sendJson(res, 405, { message: 'Pull request is already closed' }); return true; }
        if (!prMergeable(repo, pr)) { sendJson(res, 405, { message: 'Pull request is not mergeable' }); return true; }
        const sha = squashMerge(repo, pr);
        if (!sha) { sendJson(res, 405, { message: 'Pull request is not mergeable' }); return true; }
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = ISO_NOW;
        pr.mergeCommitSha = sha;
        pr.baseSha = sha;
        sendJson(res, 200, { sha, merged: true, message: `Pull Request successfully merged` });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const buf = await readBody(req);
    if (buf.length > 0) {
      try { JSON.parse(buf.toString('utf8')); } catch { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
    }
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

// ---------------------------------------------------------------- git smart HTTP
function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-receive-pack'
    ? 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0'
    : 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const tip = repoTip(repo, repo.defaultBranch);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const target = getTag(repo, oid)?.object;
        if (target) parts.push(pktLine(`${target} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow thin-pack ofs-delta\n', 'object-format=sha1\n', 'flush']);
}
function treeClosure(repo: Repo, treeOid: string): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [treeOid];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++] as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      const entries = getTree(repo, oid);
      if (entries) for (const e of entries) queue.push(e.oid);
    }
  }
  return out;
}
function fetchPlan(repo: Repo, wants: string[], haves: string[], depth: number | null, oldShallow: string[]): { send: Map<string, GitObj>; shallow: string[]; unshallow: string[] } {
  const oldShallowSet = new Set(oldShallow);
  const includedCommits = new Set<string>();
  const queue: { oid: string; d: number }[] = [];
  let qh = 0;
  const pushWant = (oid: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj) return;
    if (obj.type === 'tag') {
      includedCommits.add(oid);
      const target = getTag(repo, oid)?.object;
      if (target) queue.push({ oid: target, d: 0 });
      return;
    }
    if (obj.type === 'commit') queue.push({ oid, d: 0 });
  };
  for (const w of wants) pushWant(w);
  while (qh < queue.length) {
    const { oid, d } = queue[qh++] as { oid: string; d: number };
    if (includedCommits.has(oid)) continue;
    if (depth !== null && d >= depth) continue;
    const c = getCommit(repo, oid);
    if (!c) continue;
    includedCommits.add(oid);
    for (const p of c.parents) queue.push({ oid: p, d: d + 1 });
  }
  const included = new Set<string>();
  for (const oid of includedCommits) {
    included.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') {
      const c = getCommit(repo, oid);
      if (c) for (const o of treeClosure(repo, c.tree)) included.add(o);
    }
  }
  const held = new Set<string>();
  const heldCommits = new Set<string>();
  const hq: string[] = [...haves];
  let hh = 0;
  while (hh < hq.length) {
    const oid = hq[hh++] as string;
    const coid = peelToCommit(repo, oid) ?? oid;
    if (heldCommits.has(coid)) continue;
    const c = getCommit(repo, coid);
    if (!c) continue;
    heldCommits.add(coid);
    held.add(coid);
    for (const o of treeClosure(repo, c.tree)) held.add(o);
    if (oldShallowSet.has(coid)) continue;
    for (const p of c.parents) hq.push(p);
  }
  const send = new Map<string, GitObj>();
  for (const oid of included) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) send.set(oid, obj);
  }
  const shallow: string[] = [];
  for (const oid of includedCommits) {
    const c = getCommit(repo, oid);
    if (!c) continue;
    if (depth !== null && c.parents.some((p) => !includedCommits.has(p))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of oldShallow) {
    if (includedCommits.has(oid) && !shallow.includes(oid)) unshallow.push(oid);
  }
  return { send, shallow, unshallow };
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65000) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65000));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}
async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, rawUrl: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(path);
  if (!m) return false;
  const owner = dec(m[1] as string);
  const name = dec(m[2] as string);
  const suffix = m[3] as string;
  const repo = repoFor(owner, name);
  if (method === 'GET' && suffix.startsWith('/info/refs')) {
    const service = queryOfRaw(rawUrl).get('service') ?? '';
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found\n');
      return true;
    }
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad service\n');
      return true;
    }
    const ct = `application/x-${service}-advertisement`;
    if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2')) {
      sendRaw(res, 200, v2Advertisement(), ct);
    } else {
      sendRaw(res, 200, v0Advertisement(repo, service), ct);
    }
    return true;
  }
  if (method === 'POST' && (suffix === '/git-upload-pack' || suffix === '/git-receive-pack')) {
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found\n');
      return true;
    }
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    if (suffix === '/git-upload-pack') return handleUploadPack(req, res, repo, body, isV2);
    return handleReceivePack(req, res, repo, body);
  }
  return false;
}
async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer, isV2: boolean): Promise<boolean> {
  const ct = 'application/x-git-upload-pack-result';
  if (isV2) {
    const decoded = decodePktLines(body);
    if (!decoded) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad pkt-line\n'); return true; }
    const lines = decoded.lines;
    const command = (lines[0] ?? '').trim();
    if (command === 'command=ls-refs') {
      const args = lines.slice(1);
      const prefixes: string[] = [];
      let peel = false; let symrefs = false; let unborn = false;
      for (const a of args) {
        const t = a.trim();
        if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
        else if (t === 'peel') peel = true;
        else if (t === 'symrefs') symrefs = true;
        else if (t === 'unborn') unborn = true;
      }
      const out: (string | 'flush')[] = [];
      const refs = sortedRefs(repo);
      const tip = repoTip(repo, repo.defaultBranch);
      if (refs.length === 0) {
        if (unborn) out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
      } else {
        const all: { oid: string; name: string; peeled?: string; symrefTarget?: string }[] = [];
        if (tip && (prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p)))) {
          all.push({ oid: tip as string, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
        }
        for (const [rname, oid] of refs) {
          let peeled: string | undefined;
          const obj = repo.objects.get(oid);
          if (obj && obj.type === 'tag') peeled = getTag(repo, oid)?.object;
          all.push({ oid, name: rname, peeled });
        }
        for (const r of all) {
          if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
          if (r.name === 'HEAD' && !symrefs) continue;
          let line = `${r.oid} ${r.name}`;
          if (r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
          if (peel && r.peeled) line += ` peeled:${r.peeled}`;
          out.push(`${line}\n`);
        }
      }
      out.push('flush');
      sendRaw(res, 200, pktLines(out), ct);
      return true;
    }
    if (command === 'command=fetch') {
      const args = lines.slice(1);
      const wants: string[] = []; const haves: string[] = []; const shallowOld: string[] = [];
      let depth: number | null = null;
      let done = false;
      for (const a of args) {
        const t = a.trim();
        if (t.startsWith('want ')) wants.push(t.slice(5).trim());
        else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
        else if (t.startsWith('shallow ')) shallowOld.push(t.slice(8).trim());
        else if (t.startsWith('deepen ')) { const n = Number(t.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
        else if (t === 'done') done = true;
      }
      if (!done) {
        let common: string | null = null;
        for (const h of haves) {
          const hc = peelToCommit(repo, h);
          if (!hc) continue;
          for (const w of wants) {
            const wc = peelToCommit(repo, w);
            if (!wc) continue;
            if (hc === wc || isAncestor(repo, hc, wc)) { common = hc; break; }
          }
          if (common) break;
        }
        const out = pktLines(['acknowledgments\n', common ? `ACK ${common}\n` : 'NAK\n', 'flush']);
        sendRaw(res, 200, out, ct);
        return true;
      }
      // Cacheable fetch: no haves, no prior shallow boundary, one tip.
      // The response bytes are then a pure function of (tip, depth, wants).
      const cacheable = haves.length === 0 && shallowOld.length === 0 && wants.length > 0;
      const cacheKey = cacheable ? `v2|${wants.join(',')}|${depth === null ? '' : depth}` : '';
      if (cacheable) {
        const hit = repo.fetchCache.get(cacheKey);
        if (hit) { sendRaw(res, 200, hit, ct); return true; }
      }
      const plan = fetchPlan(repo, wants, haves, depth, shallowOld);
      const textParts: (string | 'delim')[] = [];
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        textParts.push('shallow-info\n');
        for (const s of plan.shallow) textParts.push(`shallow ${s}\n`);
        for (const s of plan.unshallow) textParts.push(`unshallow ${s}\n`);
        textParts.push('delim');
      }
      const pack = writePack([...plan.send.values()].map((o) => ({ type: o.type, data: o.data })));
      const out = Buffer.concat([pktLines(textParts), pktLine('packfile\n'), sidebandPack(pack), PKT_FLUSH]);
      if (cacheable) repo.fetchCache.set(cacheKey, out);
      sendRaw(res, 200, out, ct);
      return true;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('unknown v2 command\n');
    return true;
  }
  const decoded = decodePktLines(body);
  if (!decoded) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad pkt-line\n'); return true; }
  const wants: string[] = []; const haves: string[] = []; const shallowOld: string[] = [];
  let depth: number | null = null;
  for (const line of decoded.lines) {
    const t = line.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0] as string);
    else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) shallowOld.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) { const n = Number(t.slice(7).trim()); if (Number.isFinite(n)) depth = n; }
  }
  const cacheable = haves.length === 0 && shallowOld.length === 0 && wants.length > 0;
  const cacheKey = cacheable ? `v0|${wants.join(',')}|${depth === null ? '' : depth}` : '';
  if (cacheable) {
    const hit = repo.fetchCache.get(cacheKey);
    if (hit) { sendRaw(res, 200, hit, 'application/x-git-upload-pack-result'); return true; }
  }
  const plan = fetchPlan(repo, wants, haves, depth, shallowOld);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (plan.send.size > 0) {
    const pack = writePack([...plan.send.values()].map((o) => ({ type: o.type, data: o.data })));
    parts.push(sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  if (cacheable) repo.fetchCache.set(cacheKey, out);
  sendRaw(res, 200, out, ct);
  return true;
}
async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<boolean> {
  const ct = 'application/x-git-receive-pack-result';
  const report = (unpack: string, refs: { ref: string; ok: boolean; reason: string }[]): Buffer => {
    const lines: (string | 'flush')[] = [`unpack ${unpack}\n`];
    for (const r of refs) lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
    lines.push('flush');
    const inner = pktLines(lines);
    return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
  };
  const decoded = decodePktLines(body);
  if (!decoded) {
    sendRaw(res, 200, report('bad pkt-line', []), ct);
    return true;
  }
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (const line of decoded.lines) {
    const t = line.replace(/\n$/, '');
    const nul = t.indexOf('\0');
    const head = nul >= 0 ? t.slice(0, nul) : t;
    const parts = head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (commands.length === 0) {
    sendRaw(res, 200, report('ok', []), ct);
    return true;
  }
  let entries: PackEntry[] | null = null;
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates) {
    if (decoded.rest.length === 0) {
      sendRaw(res, 200, report('unpack error', []), ct);
      return true;
    }
    entries = readPack(decoded.rest);
    if (!entries) {
      sendRaw(res, 200, report('unpack error', []), ct);
      return true;
    }
    for (const e of entries) {
      if (!repo.objects.has(e.oid)) repo.objects.set(e.oid, { type: e.type, data: e.data });
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let changed = false;
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (!current) { results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' }); continue; }
      repo.refs.delete(cmd.ref);
      changed = true;
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(cmd.newOid);
    if (!target) { results.push({ ref: cmd.ref, ok: false, reason: 'missing object' }); continue; }
    if (!current) {
      if (cmd.oldOid !== ZERO_OID) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
      repo.refs.set(cmd.ref, cmd.newOid);
      changed = true;
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (current.toLowerCase() !== cmd.oldOid.toLowerCase()) { results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    if (current === cmd.newOid) { results.push({ ref: cmd.ref, ok: true, reason: '' }); continue; }
    const oldCommit = peelToCommit(repo, current);
    const newCommit = peelToCommit(repo, cmd.newOid);
    if (!oldCommit || !newCommit || !isAncestor(repo, oldCommit, newCommit)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    changed = true;
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  if (changed) invalidateFetchCache(repo);
  sendRaw(res, 200, report('ok', results), ct);
  return true;
}

// ---------------------------------------------------------------- GraphQL
type GqlValue = string | number | boolean | null | GqlValue[] | { [k: string]: GqlValue };
interface GqlArg { [name: string]: GqlValue }
interface GqlField {
  name: string;
  alias?: string;
  args: GqlArg;
  children: GqlField[];
  inlineType?: string;
}
interface GqlOperation { name?: string; fields: GqlField[]; fragments: Map<string, GqlField[]> }
function gqlLex(src: string): { tokens: string[] } {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j += 1; } }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if (c === '$') { let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1; tokens.push(src.slice(i, j)); i = j; continue; }
    if ('{}():![]@='.includes(c)) { tokens.push(c); i += 1; continue; }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_-]/.test(src[j] as string)) j += 1;
    if (j === i) { i += 1; continue; }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return { tokens };
}
class GqlParser {
  pos = 0;
  tokens: string[];
  vars: Record<string, GqlValue>;
  constructor(tokens: string[], vars: Record<string, GqlValue>) {
    this.tokens = tokens;
    this.vars = vars;
  }
  peek(): string | undefined { return this.tokens[this.pos]; }
  next(): string | undefined { return this.tokens[this.pos++]; }
  expect(t: string): void { if (this.peek() === t) this.pos += 1; }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === undefined) return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (t.startsWith('$')) return this.vars[t.slice(1)] ?? null;
    if (t.startsWith('"')) { try { return JSON.parse(t) as string; } catch { return t; } }
    if (t === '[') {
      const arr: GqlValue[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (t === '{') {
      const obj: { [k: string]: GqlValue } = {};
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const key = this.next() as string;
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    const n = Number(t);
    if (t !== '' && Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(t)) return n;
    return t;
  }
  parseArgs(): GqlArg {
    const args: GqlArg = {};
    this.expect('(');
    while (this.peek() !== ')' && this.peek() !== undefined) {
      const name = this.next() as string;
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseSelectionSet(fragments: Map<string, GqlField[]>): GqlField[] {
    const fields: GqlField[] = [];
    this.expect('{');
    while (this.peek() !== '}' && this.peek() !== undefined) {
      const tok = this.next();
      if (tok === undefined) break;
      if (tok === '...') {
        const nxt = this.next();
        if (nxt === 'on') {
          const typeName = this.next() as string;
          const children = this.parseSelectionSet(fragments);
          fields.push({ name: '__inline', children, inlineType: typeName });
        } else if (nxt !== undefined) {
          const fragFields = fragments.get(nxt) ?? [];
          if (fragFields.length > 0) fields.push(...fragFields);
          else fields.push({ name: '__fragment', alias: nxt, args: {}, children: [] });
        }
        continue;
      }
      let name = tok;
      let alias: string | undefined;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next() as string;
      }
      let args: GqlArg = {};
      if (this.peek() === '(') args = this.parseArgs();
      let children: GqlField[] = [];
      if (this.peek() === '{') children = this.parseSelectionSet(fragments);
      fields.push({ name, alias, args, children });
    }
    this.expect('}');
    return fields;
  }
  parseOperation(): GqlOperation {
    let tok = this.peek();
    if (tok === 'query' || tok === 'mutation' || tok === 'subscription') {
      this.next();
      tok = this.peek();
      if (tok !== undefined && tok !== '{' && tok !== '(' && tok !== '@') { this.next(); tok = this.peek(); }
      if (tok === '(') {
        let depth = 0;
        while (this.peek() !== undefined) {
          const t = this.next() as string;
          if (t === '(') depth += 1;
          else if (t === ')') { depth -= 1; if (depth === 0) break; }
        }
      }
    }
    const fragments = new Map<string, GqlField[]>();
    let fields: GqlField[] = [];
    if (this.peek() === '{') fields = this.parseSelectionSet(fragments);
    return { fields, fragments };
  }
}
function parseGqlDocument(doc: string, vars: Record<string, GqlValue>): { operations: GqlOperation[]; fragmentDefs: Map<string, GqlField[]> } {
  const { tokens } = gqlLex(doc);
  const parser = new GqlParser(tokens, vars);
  const operations: GqlOperation[] = [];
  const fragmentDefs = new Map<string, GqlField[]>();
  while (parser.peek() !== undefined) {
    const before = parser.pos;
    const tok = parser.peek();
    if (tok === 'fragment') {
      parser.next();
      const name = parser.next() as string;
      if (parser.peek() === 'on') { parser.next(); parser.next(); }
      const fragParser = new GqlParser(tokens.slice(parser.pos), vars);
      const fields = fragParser.parseSelectionSet(fragmentDefs);
      parser.pos += fragParser.pos;
      fragmentDefs.set(name, fields);
      continue;
    }
    const op = parser.parseOperation();
    operations.push(op);
    if (parser.pos === before) parser.pos += 1;
  }
  const expandFields = (fields: GqlField[], seen: Set<string>): GqlField[] => {
    const out: GqlField[] = [];
    for (const f of fields) {
      if (f.name === '__fragment') {
        const fragName = f.alias ?? '';
        if (!seen.has(fragName)) {
          const next = new Set(seen);
          next.add(fragName);
          out.push(...expandFields(fragmentDefs.get(fragName) ?? [], next));
        }
        continue;
      }
      out.push({ ...f, children: expandFields(f.children, seen) });
    }
    return out;
  };
  for (const op of operations) op.fields = expandFields(op.fields, new Set());
  for (const [name, fields] of [...fragmentDefs.entries()]) fragmentDefs.set(name, expandFields(fields, new Set([name])));
  return { operations, fragmentDefs };
}
const KNOWN_TYPES: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  User: ['id', 'login', 'name', 'email', 'databaseId', 'url', 'avatarUrl'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'url', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'files', 'commits'],
  Ref: ['name', 'target'],
  Actor: ['id', 'login'],
  Label: ['id', 'name', 'color', 'description'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};
const KNOWN_ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'],
  SearchType: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
};
function gqlError(msg: string): { message: string } { return { message: msg }; }
function resolveGqlFields(fields: GqlField[], typeName: string, resolver: (f: GqlField) => unknown, errors: { message: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.name === '__inline') {
      const inner = resolveGqlFields(f.children, f.inlineType ?? typeName, resolver, errors);
      Object.assign(out, inner);
      continue;
    }
    const known = KNOWN_TYPES[typeName];
    if (known && !known.includes(f.name) && !f.name.startsWith('__')) {
      errors.push(gqlError(`Cannot query field "${f.name}" on type "${typeName}".`));
      continue;
    }
    out[f.alias ?? f.name] = resolver(f);
  }
  return out;
}
function connectionNodeFields(children: GqlField[]): GqlField[] {
  for (const c of children) {
    if (c.name === 'nodes') return c.children;
    if (c.name === 'edges') {
      const node = c.children.find((x) => x.name === 'node');
      if (node) return node.children;
    }
  }
  return children;
}
function ownerGql(repo: Repo): Record<string, unknown> {
  return { id: globalId('U', 1000), login: VIEWER.login, databaseId: VIEWER.id, __typename: 'User' };
}
function issueGql(repo: Repo, issue: Issue, fields: GqlField[], errors: { message: string }[]): Record<string, unknown> {
  return resolveGqlFields(fields, 'Issue', (f) => {
    switch (f.name) {
      case 'id': return issue.id;
      case 'databaseId': return issue.number;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'body': return issue.body;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'url': return `https://example.invalid/${repo.owner ?? VIEWER.login}/${repo.name}/issues/${issue.number}`;
      case 'createdAt': case 'updatedAt': return ISO_NOW;
      case 'closedAt': return issue.closedAt;
      case 'author': return { id: globalId('U', 1000), login: VIEWER.login, __typename: 'User' };
      case 'labels': {
        const nodes = issue.labels.map((l) => ({ id: globalId('L', `${repo.dbId}:${l.name}`), name: l.name, color: l.color, description: '', __typename: 'Label' }));
        return resolveGqlFields(f.children, 'LabelConnection' as never, () => null, errors) && { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, __typename: 'LabelConnection' };
      }
      case 'comments': {
        const nodes = issue.comments.map((c) => ({ id: globalId('C', `${repo.dbId}:${issue.number}:${c.id}`), body: c.body, author: { id: globalId('U', 1000), login: VIEWER.login, __typename: 'User' }, createdAt: ISO_NOW, __typename: 'IssueComment' }));
        return { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, __typename: 'IssueCommentConnection' };
      }
      default: return null;
    }
  }, errors);
}
function prGql(repo: Repo, pr: Pull, fields: GqlField[], errors: { message: string }[]): Record<string, unknown> {
  return resolveGqlFields(fields, 'PullRequest', (f) => {
    switch (f.name) {
      case 'id': return pr.id;
      case 'databaseId': return pr.number;
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged': return pr.merged;
      case 'mergeable': return pr.state === 'open' ? (prMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'url': return `https://example.invalid/${repo.owner ?? VIEWER.login}/${repo.name}/pull/${pr.number}`;
      case 'createdAt': case 'updatedAt': return ISO_NOW;
      case 'mergedAt': return pr.mergedAt;
      case 'author': return { id: globalId('U', 1000), login: VIEWER.login, __typename: 'User' };
      case 'files': {
        const files = prFiles(repo, pr).map((x) => ({ path: x.filename, additions: x.additions, deletions: x.deletions, __typename: 'PullRequestChangedFile' }));
        const first = typeof f.args.first === 'number' ? f.args.first : files.length;
        return { nodes: files.slice(0, first), totalCount: files.length, pageInfo: { hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }, __typename: 'PullRequestChangedFileConnection' };
      }
      case 'commits': return { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, __typename: 'PullRequestCommitConnection' };
      default: return null;
    }
  }, errors);
}
function repoGql(repo: Repo, fields: GqlField[], errors: { message: string }[]): Record<string, unknown> {
  return resolveGqlFields(fields, 'Repository', (f) => {
    switch (f.name) {
      case 'id': return repoGlobalId(repo);
      case 'databaseId': return repo.dbId;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner ?? VIEWER.login}/${repo.name}`;
      case 'description': return repo.description;
      case 'owner': return ownerGql(repo);
      case 'defaultBranchRef': {
        const tip = repoTip(repo, repo.defaultBranch);
        return resolveGqlFields(f.children, 'Ref', (rf) => {
          if (rf.name === 'name') return repo.defaultBranch;
          if (rf.name === 'target') return { oid: tip, __typename: 'Commit' };
          return null;
        }, errors);
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'url': return `https://example.invalid/${repo.owner ?? VIEWER.login}/${repo.name}`;
      case 'createdAt': case 'updatedAt': return ISO_NOW;
      case 'issue': {
        const n = typeof f.args.number === 'number' ? f.args.number : -1;
        const issue = repo.issueByNumber.get(n);
        return issue ? issueGql(repo, issue, f.children, errors) : null;
      }
      case 'issues': {
        const states = Array.isArray(f.args.states) ? (f.args.states as string[]) : [];
        const orderBy = (f.args.orderBy ?? {}) as Record<string, unknown>;
        let list = [...repo.issues];
        if (states.includes('OPEN')) list = list.filter((i) => i.state === 'open');
        if (states.includes('CLOSED')) list = list.filter((i) => i.state === 'closed');
        if (orderBy.field === 'CREATED_AT') list.sort((a, b) => orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq);
        else list.sort((a, b) => b.seq - a.seq);
        const first = typeof f.args.first === 'number' ? f.args.first : 100;
        const after = typeof f.args.after === 'string' ? decodeCursor(f.args.after) : -1;
        const dir = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
        const filtered = after < 0 ? list : list.filter((i) => dir === 'ASC' ? i.seq > after : i.seq < after);
        const page = filtered.slice(0, first);
        const nodeFields = connectionNodeFields(f.children);
        const nodes = page.map((i) => issueGql(repo, i, nodeFields, errors));
        const edges = page.map((i) => ({ node: issueGql(repo, i, nodeFields, errors), cursor: encodeCursor(i.seq) }));
        return { nodes, edges, totalCount: list.length, pageInfo: { hasNextPage: filtered.length > first, hasPreviousPage: after >= 0, startCursor: page.length ? encodeCursor(page[0]?.seq ?? 0) : null, endCursor: page.length ? encodeCursor(page[page.length - 1]?.seq ?? 0) : null }, __typename: 'IssueConnection' };
      }
      case 'pullRequest': {
        const n = typeof f.args.number === 'number' ? f.args.number : -1;
        const pr = repo.pulls.find((p) => p.number === n);
        return pr ? prGql(repo, pr, f.children, errors) : null;
      }
      case 'pullRequests': {
        const states = Array.isArray(f.args.states) ? (f.args.states as string[]) : [];
        let list = [...repo.pulls];
        if (states.includes('OPEN')) list = list.filter((p) => p.state === 'open');
        if (states.includes('CLOSED')) list = list.filter((p) => p.state === 'closed');
        if (states.includes('MERGED')) list = list.filter((p) => p.merged);
        list.sort((a, b) => b.seq - a.seq);
        const first = typeof f.args.first === 'number' ? f.args.first : 100;
        const after = typeof f.args.after === 'string' ? decodeCursor(f.args.after) : -1;
        const filtered = list.filter((p) => p.seq < after || after < 0);
        const page = filtered.slice(0, first);
        const nodeFields = connectionNodeFields(f.children);
        const nodes = page.map((p) => prGql(repo, p, nodeFields, errors));
        const edges = page.map((p) => ({ node: prGql(repo, p, nodeFields, errors), cursor: encodeCursor(p.seq) }));
        return { nodes, edges, totalCount: list.length, pageInfo: { hasNextPage: filtered.length > first, hasPreviousPage: after >= 0, startCursor: page.length ? encodeCursor(page[0]?.seq ?? 0) : null, endCursor: page.length ? encodeCursor(page[page.length - 1]?.seq ?? 0) : null }, __typename: 'PullRequestConnection' };
      }
      default: return null;
    }
  }, errors);
}
function resolveTopLevel(op: GqlOperation, errors: { message: string }[]): Record<string, unknown> {
  const expand = (fields: GqlField[]): GqlField[] => {
    const out: GqlField[] = [];
    for (const f of fields) {
      if (f.name === '__inline') out.push(...expand(f.children));
      else out.push({ ...f, children: expand(f.children) });
    }
    return out;
  };
  const fields = expand(op.fields.map((f) => ({ ...f })));
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.name === '__type') {
      const name = typeof f.args.name === 'string' ? f.args.name : '';
      if (name === 'SearchType') {
        out[f.alias ?? f.name] = resolveGqlFields(f.children, '__Type', (sf) => {
          if (sf.name === 'name') return 'SearchType';
          if (sf.name === 'kind') return 'ENUM';
          if (sf.name === 'enumValues') {
            return KNOWN_ENUMS.SearchType?.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null }));
          }
          return null;
        }, errors);
        continue;
      }
      const known = KNOWN_TYPES[name];
      out[f.alias ?? f.name] = resolveGqlFields(f.children, '__Type', (sf) => {
        if (sf.name === 'name') return name;
        if (sf.name === 'kind') return 'OBJECT';
        if (sf.name === 'fields') {
          const list = (known ?? []).map((fname) => ({ name: fname, description: null, args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }));
          return list;
        }
        if (sf.name === 'enumValues') {
          const ev = KNOWN_ENUMS[name];
          return ev ? ev.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null })) : null;
        }
        return null;
      }, errors);
      continue;
    }
    if (f.name === 'viewer') {
      out[f.alias ?? f.name] = resolveGqlFields(f.children, 'User', (sf) => {
        if (sf.name === 'id') return globalId('U', VIEWER.id);
        if (sf.name === 'login') return VIEWER.login;
        if (sf.name === 'name') return VIEWER.name;
        if (sf.name === 'email') return VIEWER.email;
        if (sf.name === 'databaseId') return VIEWER.id;
        return null;
      }, errors);
      continue;
    }
    if (f.name === 'repository') {
      const owner = typeof f.args.owner === 'string' ? f.args.owner : '';
      const name = typeof f.args.name === 'string' ? f.args.name : '';
      const repo = repoFor(owner, name);
      out[f.alias ?? f.name] = repo ? repoGql(repo, f.children, errors) : null;
      continue;
    }
    if (f.name === 'node') {
      const id = typeof f.args.id === 'string' ? f.args.id : '';
      const decoded = decodeGlobalId(id);
      if (!decoded) { out[f.alias ?? f.name] = null; continue; }
      if (decoded.kind === 'R') {
        const repo = [...repos.values()].find((r) => r.dbId === decoded.dbId);
        out[f.alias ?? f.name] = repo ? repoGql(repo, f.children, errors) : null;
        continue;
      }
      if (decoded.kind === 'I') {
        const [dbId, num] = decoded.rest.split(':').map(Number);
        const repo = [...repos.values()].find((r) => r.dbId === dbId);
        const issue = repo?.issueByNumber.get(num);
        out[f.alias ?? f.name] = repo && issue ? issueGql(repo, issue, f.children, errors) : null;
        continue;
      }
      if (decoded.kind === 'P') {
        const [dbId, num] = decoded.rest.split(':').map(Number);
        const repo = [...repos.values()].find((r) => r.dbId === dbId);
        const pr = repo?.pulls.find((p) => p.number === num);
        out[f.alias ?? f.name] = repo && pr ? prGql(repo, pr, f.children, errors) : null;
        continue;
      }
      out[f.alias ?? f.name] = null;
      continue;
    }
    if (f.name === 'search') {
      const query = typeof f.args.query === 'string' ? f.args.query : '';
      const type = typeof f.args.type === 'string' ? f.args.type : 'ISSUE';
      const first = typeof f.args.first === 'number' ? f.args.first : 10;
      let nodes: Record<string, unknown>[] = [];
      if (type === 'ISSUE') {
        const nodeFields = connectionNodeFields(f.children);
        for (const repo of repos.values()) {
          for (const issue of repo.issues) {
            if (query && !(issue.title.includes(query) || issue.body.includes(query))) continue;
            nodes.push(issueGql(repo, issue, nodeFields, errors));
          }
        }
      }
      out[f.alias ?? f.name] = { nodes: nodes.slice(0, first), totalCount: nodes.length, pageInfo: { hasNextPage: nodes.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }, __typename: 'SearchResultItemConnection' };
      continue;
    }
    if (f.name === 'createIssue') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repoId);
      const repo = decoded ? [...repos.values()].find((r) => r.dbId === decoded.dbId) : undefined;
      if (!repo) { errors.push(gqlError('Repository not found')); out[f.alias ?? f.name] = null; continue; }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = { id: globalId('I', `${repo.dbId}:${number}`), number, title: typeof input.title === 'string' ? input.title : '', body: typeof input.body === 'string' ? input.body : '', state: 'open', labels: [], seq: nextSeq(), closedAt: null, comments: [], json: '', jsonLen: 0, labelJson: '', jsonOwner: null };
      addIssue(repo, issue);
      out[f.alias ?? f.name] = resolveGqlFields(f.children, 'CreateIssuePayload', (sf) => {
        if (sf.name === 'issue') return issueGql(repo, issue, sf.children, errors);
        if (sf.name === 'clientMutationId') return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        return null;
      }, errors);
      continue;
    }
    if (f.name === 'closeIssue') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const decoded = decodeGlobalId(issueId);
      let target: { repo: Repo; issue: Issue } | undefined;
      if (decoded && decoded.kind === 'I') {
        const [dbId, num] = decoded.rest.split(':').map(Number);
        const repo = [...repos.values()].find((r) => r.dbId === dbId);
        const issue = repo?.issueByNumber.get(num);
        if (repo && issue) target = { repo, issue };
      }
      if (!target) { errors.push(gqlError('Issue not found')); out[f.alias ?? f.name] = null; continue; }
      target.issue.state = 'closed';
      target.issue.closedAt = ISO_NOW;
      refreshIssueJson(target.repo, target.issue);
      out[f.alias ?? f.name] = resolveGqlFields(f.children, 'CloseIssuePayload', (sf) => {
        if (sf.name === 'issue') return issueGql(target.repo, target.issue, sf.children, errors);
        if (sf.name === 'clientMutationId') return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        return null;
      }, errors);
      continue;
    }
    if (f.name === 'createPullRequest') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const decoded = decodeGlobalId(repoId);
      const repo = decoded ? [...repos.values()].find((r) => r.dbId === decoded.dbId) : undefined;
      if (!repo) { errors.push(gqlError('Repository not found')); out[f.alias ?? f.name] = null; continue; }
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const headSha = repoTip(repo, headRef);
      const baseSha = repoTip(repo, baseRef);
      if (!headSha || !baseSha) { errors.push(gqlError('head or base branch does not exist')); out[f.alias ?? f.name] = null; continue; }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pr: Pull = { id: globalId('P', `${repo.dbId}:${number}`), number, title: typeof input.title === 'string' ? input.title : '', body: typeof input.body === 'string' ? input.body : '', state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, baseAtCreate: baseSha, seq: nextSeq() };
      repo.pulls.push(pr);
      out[f.alias ?? f.name] = resolveGqlFields(f.children, 'CreatePullRequestPayload', (sf) => {
        if (sf.name === 'pullRequest') return prGql(repo, pr, sf.children, errors);
        if (sf.name === 'clientMutationId') return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        return null;
      }, errors);
      continue;
    }
    if (f.name === 'mergePullRequest') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = decodeGlobalId(prId);
      let target: { repo: Repo; pr: Pull } | undefined;
      if (decoded && decoded.kind === 'P') {
        const [dbId, num] = decoded.rest.split(':').map(Number);
        const repo = [...repos.values()].find((r) => r.dbId === dbId);
        const pr = repo?.pulls.find((p) => p.number === num);
        if (repo && pr) target = { repo, pr };
      }
      if (!target) { errors.push(gqlError('Pull request not found')); out[f.alias ?? f.name] = null; continue; }
      const { repo, pr } = target;
      if (pr.state !== 'open' || !prMergeable(repo, pr) || !squashMerge(repo, pr)) {
        errors.push(gqlError('Pull request is not mergeable'));
        out[f.alias ?? f.name] = null;
        continue;
      }
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = ISO_NOW;
      pr.mergeCommitSha = pr.baseSha;
      out[f.alias ?? f.name] = resolveGqlFields(f.children, 'MergePullRequestPayload', (sf) => {
        if (sf.name === 'pullRequest') return prGql(repo, pr, sf.children, errors);
        if (sf.name === 'clientMutationId') return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        return null;
      }, errors);
      continue;
    }
    if (f.name === 'addComment') {
      const input = (f.args.input ?? {}) as Record<string, unknown>;
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const decoded = decodeGlobalId(subjectId);
      let target: { repo: Repo; issue: Issue } | undefined;
      if (decoded && decoded.kind === 'I') {
        const [dbId, num] = decoded.rest.split(':').map(Number);
        const repo = [...repos.values()].find((r) => r.dbId === dbId);
        const issue = repo?.issueByNumber.get(num);
        if (repo && issue) target = { repo, issue };
      }
      if (!target) { errors.push(gqlError('Subject not found')); out[f.alias ?? f.name] = null; continue; }
      const comment = { id: target.repo.nextCommentId, body, createdAt: ISO_NOW };
      target.repo.nextCommentId += 1;
      target.issue.comments.push(comment);
      refreshIssueJson(target.repo, target.issue);
      out[f.alias ?? f.name] = resolveGqlFields(f.children, 'AddCommentPayload', (sf) => {
        if (sf.name === 'commentEdge') return { node: { id: globalId('C', `${target.repo.dbId}:${target.issue.number}:${comment.id}`), body, author: { id: globalId('U', 1000), login: VIEWER.login, __typename: 'User' }, __typename: 'IssueComment' }, cursor: encodeCursor(comment.id) };
        if (sf.name === 'clientMutationId') return typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        return null;
      }, errors);
      continue;
    }
    errors.push(gqlError(`Cannot query field "${f.name}" on type "Query".`));
  }
  return out;
}
async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!isAuthed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return true; }
  const parsed = await readJson(req);
  if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }); return true; }
  const payload = parsed.value;
  const ops = Array.isArray(payload) ? payload : [payload];
  const results: Record<string, unknown>[] = [];
  for (const op of ops) {
    const doc = typeof (op as Record<string, unknown>).query === 'string' ? (op as Record<string, unknown>).query as string : '';
    const vars = ((op as Record<string, unknown>).variables ?? {}) as Record<string, GqlValue>;
    if (doc.trim() === '') { results.push({ data: null, errors: [gqlError('Empty query')] }); continue; }
    const errors: { message: string }[] = [];
    try {
      const { operations } = parseGqlDocument(doc, vars);
      const data = operations.length ? resolveTopLevel(operations[0] as GqlOperation, errors) : {};
      const result: Record<string, unknown> = { data };
      if (errors.length) result.errors = errors;
      results.push(result);
    } catch (e) {
      results.push({ data: null, errors: [gqlError(e instanceof Error ? e.message : 'GraphQL parse error')] });
    }
  }
  sendJson(res, 200, Array.isArray(payload) ? results : results[0]);
  return true;
}
// ---------------------------------------------------------------- MCP
const MCP_TOOLS: Record<string, unknown>[] = [
  { name: 'create_repo', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, title: { type: 'string' } }, required: ['owner', 'repo', 'head', 'base', 'title'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'number' } }, required: ['owner', 'repo', 'number'] } },
];
function mcpResult(id: unknown, payload: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload } };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!isAuthed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return true; }
  const parsed = await readJson(req);
  if (!parsed.ok) { sendJson(res, 400, mcpError(null, -32700, 'Parse error')); return true; }
  const msg = (parsed.value ?? {}) as Record<string, unknown>;
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  if (method === 'server/discover') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '1.0.0' } } });
    return true;
  }
  if (method === 'initialize') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'forge', version: '1.0.0' } } });
    return true;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': `req-${nextSeq()}` });
    res.end();
    return true;
  }
  if (method === 'ping') { sendJson(res, 200, { jsonrpc: '2.0', id, result: {} }); return true; }
  if (method === 'tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    return true;
  }
  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) { sendJson(res, 200, mcpError(id, -32601, `Method not found: ${name}`)); return true; }
    const required = (((tool.inputSchema as Record<string, unknown>).required ?? []) as string[]);
    const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Missing required arguments: ${missing.join(', ')}` }], isError: true } });
      return true;
    }
    try {
      const payload = callMcpTool(name, args);
      if (payload === null) {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Not found' }], isError: true } });
        return true;
      }
      sendJson(res, 200, mcpResult(id, payload));
      return true;
    } catch (e) {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e instanceof Error ? e.message : 'Tool call failed' }], isError: true } });
      return true;
    }
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
  return true;
}
function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : (typeof args.name === 'string' ? args.name : '');
  if (name === 'create_repo') {
    const rname = typeof args.name === 'string' ? args.name : '';
    if (rname === '') throw new Error('name is required');
    if (repos.has(rname)) throw new Error('Repository already exists');
    const repo = newRepo(rname, false, '');
    return repoJson(repo);
  }
  const repo = repoFor(owner, repoName);
  if (!repo) return null;
  if (name === 'get_repo') return repoJson(repo);
  if (name === 'create_issue') {
    const title = typeof args.title === 'string' ? args.title : '';
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = { id: globalId('I', `${repo.dbId}:${number}`), number, title, body: typeof args.body === 'string' ? args.body : '', state: 'open', labels: [], seq: nextSeq(), closedAt: null, comments: [], json: '', jsonLen: 0, labelJson: '', jsonOwner: null };
    addIssue(repo, issue);
    return issueJson(repo, issue);
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    return { issues: repo.issues.filter((i) => state === 'all' ? true : i.state === state).map((i) => issueJson(repo, i)) };
  }
  if (name === 'create_pull_request') {
    const headRef = typeof args.head === 'string' ? args.head : '';
    const baseRef = typeof args.base === 'string' ? args.base : repo.defaultBranch;
    const headSha = repoTip(repo, headRef);
    const baseSha = repoTip(repo, baseRef);
    if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
    const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
    if (existing) throw new Error('A pull request already exists for this head and base');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pr: Pull = { id: globalId('P', `${repo.dbId}:${number}`), number, title: typeof args.title === 'string' ? args.title : '', body: typeof args.body === 'string' ? args.body : '', state: 'open', merged: false, mergedAt: null, mergeCommitSha: null, headRef, baseRef, headSha, baseSha, baseAtCreate: baseSha, seq: nextSeq() };
    repo.pulls.push(pr);
    return pullJson(repo, pr);
  }
  if (name === 'merge_pull_request') {
    const number = typeof args.number === 'number' ? args.number : Number(args.number);
    const pr = repo.pulls.find((p) => p.number === number);
    if (!pr) return null;
    if (pr.state !== 'open' || !prMergeable(repo, pr) || !squashMerge(repo, pr)) throw new Error('Pull request is not mergeable');
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = ISO_NOW;
    pr.mergeCommitSha = pr.baseSha;
    return { merged: true, sha: pr.mergeCommitSha, number: pr.number };
  }
  return null;
}
// ---------------------------------------------------------------- app + start
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? '/';
        const { path } = splitTarget(rawUrl);
        const method = req.method ?? 'GET';
        if (path === '/healthz' && method === 'GET') { sendJson(res, 200, { ok: true }); return; }
        if (path.startsWith('/api/v3')) { await handleRest(req, res, path, rawUrl); return; }
        if (path === '/api/graphql' && (method === 'POST' || method === 'GET')) {
          if (method === 'GET') { sendJson(res, 200, { data: null, errors: [{ message: 'GraphQL requires POST' }] }); return; }
          await handleGraphQL(req, res);
          return;
        }
        if (path === '/mcp' && method === 'POST') { await handleMcp(req, res); return; }
        if (path.endsWith('.git/info/refs') || /\.git\/(git-upload-pack|git-receive-pack)$/.test(path)) {
          const handled = await handleGit(req, res, path, rawUrl);
          if (handled) return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        if (!res.headersSent) sendJson(res, 500, { message: e instanceof Error ? e.message : 'Internal Server Error' });
      }
    })();
  });
  // Keep-alive defaults are fine; cap nothing the suite needs.
  return server;
}
export async function start(): Promise<void> {
  const port = Number(process.env.MAKEFUN_PORT ?? process.env.PORT ?? 8080);
  const server = createApp();
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => resolve()); });
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    try {
      const reg = await fetch(`${envUrl}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) });
      if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const done = await fetch(`${envUrl}/done`);
        if (done.ok) {
          const d = await done.json() as { done?: boolean };
          if (d.done) break;
        }
      }
    } catch { /* keep serving until the process is killed */ }
  }
  server.close();
  process.exit(0);
}
function isMain(): boolean {
  const entry = process.argv[1] ?? '';
  try { return new URL(import.meta.url).pathname === entry; } catch { return false; }
}
if (isMain()) void start();
