// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md:
// the command line, the output and exit codes, safe paths, format detection, line
// matching at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE
// blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it
// as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- files, lines and breaks (SPEC section 3) ----

interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- matching lines (SPEC section 5) ----

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

function occurrences(fileLines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(fileLines[i + j]!, tier) !== norm(o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), or null. */
function findTier(fileLines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const pos = occurrences(fileLines, o, t, from);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

function leadingWs(s: string): string {
  return /^[ \t]*/.exec(s)![0];
}

/** Replace O at `pos` by N. nCtx[j] marks a context line: it is written as the
 *  file's own matched line. At tier 2 every other line of N is re-indented. */
function applyReplace(fileLines: string[], o: string[], n: string[], nCtx: boolean[], nToO: number[], pos: number, tier: number): string[] {
  const out = fileLines.slice(0, pos);
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  for (let j = 0; j < n.length; j++) {
    if (nCtx[j]) {
      out.push(fileLines[pos + nToO[j]]!);
    } else if (tier === 2) {
      const line = n[j]!;
      if (line === '' || /^[ \t]+$/.test(line) || !line.startsWith(p)) out.push(line);
      else out.push(f + line.slice(p.length));
    } else {
      out.push(n[j]!);
    }
  }
  out.push(...fileLines.slice(pos + o.length));
  return out;
}

interface BodyEntry {
  kind: string;
  text: string;
  backslash: boolean;
  rawBlank: boolean;
}

/** Split body entries into old lines O and new lines N, with the context map. */
function buildON(entries: BodyEntry[]): { o: string[]; n: string[]; nCtx: boolean[]; nToO: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: boolean[] = [];
  const nToO: number[] = [];
  for (const e of entries) {
    if (e.kind === ' ') {
      nToO.push(o.length);
      o.push(e.text);
      n.push(e.text);
      nCtx.push(true);
    } else if (e.kind === '-') {
      o.push(e.text);
    } else if (e.kind === '+') {
      n.push(e.text);
      nCtx.push(false);
      nToO.push(-1);
    }
  }
  return { o, n, nCtx, nToO };
}

// ---- unified diffs (SPEC section 6) ----

interface Hunk {
  a: number;
  entries: BodyEntry[];
  o: string[];
  n: string[];
  nCtx: boolean[];
  nToO: number[];
  lastCtxPlusBackslash: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

function parseHunkHeader(line: string, lineNo: number): number {
  const m = HUNK_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}

function finishHunk(raw: string[]): Hunk {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '') end--;
  const body = raw.slice(0, end);
  const entries: BodyEntry[] = [];
  for (const line of body) {
    if (line.startsWith('\\')) {
      if (entries.length > 0) entries[entries.length - 1]!.backslash = true;
      continue;
    }
    if (line === '') entries.push({ kind: ' ', text: '', backslash: false, rawBlank: true });
    else entries.push({ kind: line[0]!, text: line.slice(1), backslash: false, rawBlank: false });
  }
  const { o, n, nCtx, nToO } = buildON(entries);
  let lastCtxPlusBackslash = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k]!;
    if (e.kind === ' ' || e.kind === '+') { lastCtxPlusBackslash = e.backslash; break; }
  }
  return { a: 0, entries, o, n, nCtx, nToO, lastCtxPlusBackslash };
}

function applyHunk(model: FileModel, hunk: Hunk, d: number, strict: boolean, failPath: string): { model: FileModel; delta: number } {
  if (hunk.o.length > 0) {
    const found = findTier(model.lines, hunk.o, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = hunk.a - 1 + d;
    let pos = found.positions[0]!;
    let best = Math.abs(pos - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < best) { best = dist; pos = p; }
    }
    const newLines = applyReplace(model.lines, hunk.o, hunk.n, hunk.nCtx, hunk.nToO, pos, found.tier);
    const runsToEnd = pos + hunk.o.length === model.lines.length;
    const final = runsToEnd ? !hunk.lastCtxPlusBackslash : model.final;
    return { model: { br: model.br, lines: newLines, final }, delta: hunk.n.length - hunk.o.length };
  }
  const insertAt = Math.min(Math.max(hunk.a + d, 0), model.lines.length);
  const newLines = [...model.lines.slice(0, insertAt), ...hunk.n, ...model.lines.slice(insertAt)];
  const final = insertAt === model.lines.length ? !hunk.lastCtxPlusBackslash : model.final;
  return { model: { br: model.br, lines: newLines, final }, delta: hunk.n.length };
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  lonePlus: string | null;
  isCreateFlag: boolean;
  isDeleteFlag: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    pairOld: null, pairNew: null, diffOld: null, diffNew: null,
    renameOld: null, renameNew: null, lonePlus: null,
    isCreateFlag: false, isDeleteFlag: false, hunks: [],
  };
}

function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseDiffGit(line: string, lineNo: number): [string, string] {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line.trimEnd());
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld ?? sec.renameOld ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.lonePlus ?? sec.renameNew ?? sec.diffNew;
  const isCreate = sec.isCreateFlag || oldPath === '/dev/null';
  const isDelete = sec.isDeleteFlag || newPath === '/dev/null';
  return (tree) => {
    if (isCreate) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusBackslash = false;
      for (const h of sec.hunks) {
        for (const e of h.entries) {
          if (e.kind === '+') { plus.push(e.text); lastPlusBackslash = e.backslash; }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBackslash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let model = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyHunk(model, h, d, strict, oldPath);
        model = r.model;
        d += r.delta;
      }
      tree.now.set(newPath, joinFile(model));
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const p = oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let model = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(model, h, d, strict, p);
      model = r.model;
      d += r.delta;
    }
    tree.now.set(p, joinFile(model));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let headerDone = false;
  let curHunk: { a: number; raw: string[] } | null = null;
  const inBody = (): boolean => curHunk !== null;
  const endBody = (): void => {
    if (curHunk !== null && cur !== null) {
      const h = finishHunk(curHunk.raw);
      h.a = curHunk.a;
      cur.hunks.push(h);
    }
    curHunk = null;
  };
  const isDiffLine = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const isPairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const no = i + 1;
    if (inBody()) {
      if (isDiffLine(line) || isPairAt(i) || line.startsWith('@@')) {
        endBody();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        curHunk!.raw.push(line);
        i++;
        continue;
      }
      endBody();
      i++;
      continue;
    }
    if (isDiffLine(line)) {
      const [x, y] = parseDiffGit(line, no);
      cur = newSection();
      cur.diffOld = x;
      cur.diffNew = y;
      sections.push(cur);
      headerDone = false;
      i++;
      continue;
    }
    if (isPairAt(i)) {
      if (cur !== null && !headerDone) {
        if (cur.pairOld === null) {
          cur.pairOld = stripPrefix(headerPath(line));
          cur.pairNew = stripPrefix(headerPath(lines[i + 1]!));
        }
        i += 2;
        continue;
      }
      cur = newSection();
      cur.pairOld = stripPrefix(headerPath(line));
      cur.pairNew = stripPrefix(headerPath(lines[i + 1]!));
      sections.push(cur);
      headerDone = false;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      curHunk = { a: parseHunkHeader(line, no), raw: [] };
      headerDone = true;
      i++;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${no + 1}`);
      if (line.startsWith('+++ ')) {
        if (cur.pairNew === null && cur.lonePlus === null) cur.lonePlus = stripPrefix(headerPath(line));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.pairOld === null && cur.renameOld === null) cur.renameOld = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (cur.pairNew === null && cur.renameNew === null) cur.renameNew = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) { cur.isCreateFlag = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { cur.isDeleteFlag = true; i++; continue; }
      i++;
      continue;
    }
    i++;
  }
  endBody();
  return sections.map((s) => sectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const out = applyReplace(model.lines, oldLines, newLines, newLines.map(() => false), newLines.map(() => -1), pos, found.tier);
    tree.now.set(path, out.length === 0 ? '' : out.join(model.br) + (model.final ? model.br : ''));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
        path = prevPath;
      }
      let eq = -1;
      let k = i + 1;
      while (k < lines.length) {
        const t = lines[k]!.trimEnd();
        if (t === '=======') { eq = k; break; }
        if (t === '>>>>>>> REPLACE') break;
        k++;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let r = -1;
      for (let m = eq + 1; m < lines.length; m++) {
        if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') { r = m; break; }
      }
      if (r < 0) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, r), strict));
      prevPath = path;
      prevEnd = r + 1;
      i = r + 1;
      continue;
    }
    i++;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string | null;
  entries: BodyEntry[];
  eof: boolean;
}

function v4aAddEdit(p: string, ls: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
  };
}

function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

function v4aUpdateEdit(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let model = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundAt: number | null = null;
        const maxTier = strict ? 0 : 2;
        for (let t = 0; t <= maxTier && foundAt === null; t++) {
          for (let idx = cursor; idx < model.lines.length; idx++) {
            if (norm(model.lines[idx]!, t) === norm(ch.anchor, t)) { foundAt = idx; break; }
          }
        }
        if (foundAt === null) throw new Fail('no-match', p);
        cursor = foundAt + 1;
      }
      const { o, n, nCtx, nToO } = buildON(ch.entries);
      if (o.length === 0) {
        const insertAt = ch.eof ? model.lines.length : cursor;
        const newLines = [...model.lines.slice(0, insertAt), ...n, ...model.lines.slice(insertAt)];
        model = { br: model.br, lines: newLines, final: model.final };
        cursor = insertAt + n.length;
      } else {
        const found = findTier(model.lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', p);
        let positions = found.positions;
        if (ch.eof) positions = positions.filter((pos) => pos + o.length === model.lines.length);
        if (positions.length === 0) throw new Fail('no-match', p);
        const pos = positions[0]!;
        const newLines = applyReplace(model.lines, o, n, nCtx, nToO, pos, found.tier);
        model = { br: model.br, lines: newLines, final: model.final };
        cursor = pos + n.length;
      }
    }
    const text = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(p, null);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    const no = i + 1;
    if (blank(line)) { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const ls: string[] = [];
      const lsBlank: boolean[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) { ls.push(l.slice(1)); lsBlank.push(false); }
        else if (l === '') { ls.push(''); lsBlank.push(true); }
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (ls.length > 0 && ls[ls.length - 1] === '' && lsBlank[lsBlank.length - 1]) { ls.pop(); lsBlank.pop(); }
      edits.push(v4aAddEdit(p, ls));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (blank(l)) { i++; continue; }
        if (isSectionStart(l)) break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(p));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateLine = no;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) { chunks.push(cur); cur = null; }
      };
      while (i < last) {
        const l = lines[i]!;
        const ln = i + 1;
        if (isSectionStart(l)) break;
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${ln}`);
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, entries: [], eof: false };
          i++;
          continue;
        }
        if (cur === null && chunks.length > 0) {
          // Only reachable after a chunk was closed by *** End of File:
          // a body line is not the start of a new chunk (SPEC §8).
          if (l === '') { i++; continue; }
          if (l[0] === ' ' || l[0] === '-' || l[0] === '+') throw new Exit2(`error: parse ${ln}`);
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) cur = { anchor: null, entries: [], eof: false };
          if (l === '') cur.entries.push({ kind: ' ', text: '', backslash: false, rawBlank: true });
          else cur.entries.push({ kind: l[0]!, text: l.slice(1), backslash: false, rawBlank: l.trim() === '' });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      closeChunk();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.entries.length > 0 && lastChunk.entries[lastChunk.entries.length - 1]!.rawBlank) {
          lastChunk.entries.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  return edits;
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const rows: { key: string; text: string }[] = [];
  for (const [p, c] of changed) {
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const oldC = changed.get(oldP);
    const newC = changed.get(newP);
    if (oldC !== undefined && newC !== undefined && oldC.was !== null && oldC.now === null && newC.was === null && newC.now !== null) {
      const oi = rows.findIndex((r) => r.text === `D ${oldP}`);
      const ni = rows.findIndex((r) => r.text === `A ${newP}`);
      if (oi >= 0 && ni >= 0) {
        rows.splice(Math.max(oi, ni), 1);
        rows.splice(Math.min(oi, ni), 1);
        rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
