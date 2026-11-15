/**
 * Fetch responses end with one flush and never include a response-end packet:
 * the transport supplies that delimiter and rejects one sent by the server.
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { fetchObject, hashObject, storeObject, type Store } from './store.ts';

/**
 * Git smart HTTP primitives and request handlers for the forge.
 * Packet framing stays byte-oriented so pack payloads are never decoded as text.
 */
type GitObject = { kind: string; bytes: Buffer };
type Repository = Store['repositories'] extends Map<string, infer Value> ? Value : never;
type Reply = { status: number; headers: Record<string, string>; body: Buffer };
type Packet = { type: 'data' | 'flush' | 'delimiter' | 'response-end'; payload?: Buffer };
type TreeFile = { path: string; mode: string; oid: string; bytes: Buffer };
const ZERO_OID = '0000000000000000000000000000000000000000';

export function parseCommitBytes(bytes: Buffer): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const text = bytes.toString('utf8');
  const separator = text.indexOf('\n\n');
  const header = separator < 0 ? text : text.slice(0, separator);
  const message = separator < 0 ? '' : text.slice(separator + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    if (line.startsWith('parent ')) parents.push(line.slice(7));
    if (line.startsWith('author ')) author = line.slice(7);
    if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function createCommitObject(store: Store, tree: string, parents: string[], authorName: string, authorEmail: string, authorTime: string, committerName: string, committerEmail: string, committerTime: string, message: string): string {
  const lines = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${authorName} <${authorEmail}> ${authorTime}`, `committer ${committerName} <${committerEmail}> ${committerTime}`, '', message];
  return storeObject(store, 'commit', Buffer.from(lines.join('\n')));
}

type MutableTree = { files: Map<string, string>; directories: Map<string, MutableTree> };

export function buildTreeFromFiles(store: Store, files: Map<string, Buffer> | Record<string, Buffer>): string {
  const root: MutableTree = { files: new Map(), directories: new Map() };
  const entries = files instanceof Map ? files.entries() : Object.entries(files);
  for (const [path, bytes] of entries) {
    const parts = path.split('/').filter(Boolean);
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      if (!directory.directories.has(part)) directory.directories.set(part, { files: new Map(), directories: new Map() });
      directory = directory.directories.get(part)!;
    }
    if (parts.length > 0) directory.files.set(parts[parts.length - 1], storeObject(store, 'blob', bytes));
  }
  const writeTree = (directory: MutableTree): string => {
    const entries: { mode: string; name: string; oid: string; directory: boolean }[] = [];
    for (const [name, oid] of directory.files) entries.push({ mode: '100644', name, oid, directory: false });
    for (const [name, child] of directory.directories) entries.push({ mode: '40000', name, oid: writeTree(child), directory: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name + (left.directory ? '/' : '')), Buffer.from(right.name + (right.directory ? '/' : ''))));
    const chunks: Buffer[] = [];
    for (const entry of entries) chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, 'hex'));
    return storeObject(store, 'tree', Buffer.concat(chunks));
  };
  return writeTree(root);
}

export function flattenTree(store: Store, treeId: string): TreeFile[] {
  const files: TreeFile[] = [];
  const walk = (oid: string, prefix: string): void => {
    const object = fetchObject(store, oid);
    if (!object || object.kind !== 'tree') return;
    let offset = 0;
    while (offset < object.bytes.length) {
      const space = object.bytes.indexOf(32, offset);
      const nul = object.bytes.indexOf(0, space + 1);
      if (space < 0 || nul < 0 || nul + 21 > object.bytes.length) break;
      const mode = object.bytes.subarray(offset, space).toString();
      const name = object.bytes.subarray(space + 1, nul).toString();
      const childOid = object.bytes.subarray(nul + 1, nul + 21).toString('hex');
      const path = prefix ? `${prefix}/${name}` : name;
      if (mode === '40000' || mode === '040000') walk(childOid, path);
      else {
        const blob = fetchObject(store, childOid);
        if (blob) files.push({ path, mode, oid: childOid, bytes: blob.bytes });
      }
      offset = nul + 21;
    }
  };
  walk(treeId, '');
  return files;
}

function lineCounts(bytes: Buffer): Map<string, number> {
  const lines = bytes.toString('utf8').split('\n');
  if (bytes.length > 0 && bytes[bytes.length - 1] === 10) lines.pop();
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

export function diffTrees(store: Store, base: string, head: string): { filename: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; changes: number }[] {
  const before = new Map(flattenTree(store, base).map((file) => [file.path, file.bytes]));
  const after = new Map(flattenTree(store, head).map((file) => [file.path, file.bytes]));
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changes: { filename: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; changes: number }[] = [];
  for (const filename of paths) {
    const left = before.get(filename);
    const right = after.get(filename);
    if (left && right && left.equals(right)) continue;
    let additions = 0;
    let deletions = 0;
    if (left && right) {
      const oldLines = lineCounts(left);
      const newLines = lineCounts(right);
      for (const [line, count] of newLines) additions += Math.max(0, count - (oldLines.get(line) ?? 0));
      for (const [line, count] of oldLines) deletions += Math.max(0, count - (newLines.get(line) ?? 0));
      if (additions === 0 && deletions === 0) additions = deletions = 1;
    } else if (right) additions = lineCounts(right).values().reduce((sum, count) => sum + count, 0);
    else if (left) deletions = lineCounts(left).values().reduce((sum, count) => sum + count, 0);
    const status = !left ? 'added' : !right ? 'deleted' : 'modified';
    changes.push({ filename, status, additions, deletions, changes: additions + deletions });
  }
  return changes;
}

export function commitAncestors(store: Store, tips: string[], maxGeneration = Number.POSITIVE_INFINITY): Set<string> {
  const found = new Set<string>();
  const queue = tips.map((oid) => ({ oid, depth: 0 }));
  for (let index = 0; index < queue.length; index += 1) {
    const { oid, depth } = queue[index];
    if (found.has(oid) || depth > maxGeneration) continue;
    const object = fetchObject(store, oid);
    if (!object || object.kind !== 'commit') continue;
    found.add(oid);
    if (depth < maxGeneration) for (const parent of parseCommitBytes(object.bytes).parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return found;
}

export function isFastForward(store: Store, oldTip: string, newTip: string): boolean {
  return oldTip === ZERO_OID || oldTip === newTip || commitAncestors(store, [newTip]).has(oldTip);
}

export function resolveRefName(store: Store, repo: Repository, refName: string): string | null {
  if (refName === 'HEAD') return repo.branches.get(repo.default_branch) ?? null;
  let oid: string | undefined;
  if (refName.startsWith('refs/heads/')) oid = repo.branches.get(refName.slice(11));
  else if (refName.startsWith('refs/tags/')) oid = repo.tags.get(refName.slice(10));
  else oid = repo.branches.get(refName) ?? repo.tags.get(refName);
  if (!oid) return null;
  let object = fetchObject(store, oid);
  while (object?.kind === 'tag') {
    const target = /^object ([0-9a-f]{40})/m.exec(object.bytes.toString());
    if (!target) break;
    oid = target[1];
    object = fetchObject(store, oid);
  }
  return oid;
}

export function listRepositoryRefs(repo: Repository): { oid: string; ref: string; peeled?: string }[] {
  const refs: { oid: string; ref: string; peeled?: string }[] = [];
  for (const [name, oid] of repo.branches) refs.push({ oid, ref: `refs/heads/${name}` });
  for (const [name, oid] of repo.tags) refs.push({ oid, ref: `refs/tags/${name}` });
  refs.push({ oid: repo.branches.get(repo.default_branch) ?? ZERO_OID, ref: 'HEAD' });
  return refs;
}

export function readBlobAtRef(store: Store, repo: Repository, branchOrCommit: string, filePath: string): Buffer | null {
  let oid = resolveRefName(store, repo, branchOrCommit);
  if (!oid && /^[0-9a-f]{40}$/.test(branchOrCommit)) oid = branchOrCommit;
  if (!oid) return null;
  let object = fetchObject(store, oid);
  while (object?.kind === 'tag') {
    const target = /^object ([0-9a-f]{40})/m.exec(object.bytes.toString());
    if (!target) return null;
    oid = target[1];
    object = fetchObject(store, oid);
  }
  if (object?.kind === 'commit') oid = /^tree ([0-9a-f]{40})/m.exec(object.bytes.toString())?.[1] ?? '';
  return flattenTree(store, oid).find((file) => file.path === filePath)?.bytes ?? null;
}

export function encodePacket(payload: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = bytes.length + 4;
  if (length > 65520) throw new Error('pkt-line exceeds maximum length');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0')), bytes]);
}

export function decodePackets(bytes: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString();
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    offset += 4;
    if (length === 0) packets.push({ type: 'flush' });
    else if (length === 1) packets.push({ type: 'delimiter' });
    else if (length === 2) packets.push({ type: 'response-end' });
    else if (length < 4 || offset + length - 4 > bytes.length) { offset -= 4; break; }
    else { packets.push({ type: 'data', payload: bytes.subarray(offset, offset + length - 4) }); offset += length - 4; }
  }
  return { packets, rest: bytes.subarray(offset) };
}

export function sideband(pack: Buffer): Buffer {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) packets.push(encodePacket(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + 65515)])));
  packets.push(Buffer.from('0000'));
  return Buffer.concat(packets);
}

const KIND_TO_TYPE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_TO_KIND: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function encodePack(objects: GitObject[]): Buffer {
  const chunks: Buffer[] = [Buffer.from('PACK'), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  chunks[2].writeUInt32BE(objects.length);
  for (const object of objects) {
    const kind = KIND_TO_TYPE[object.kind];
    if (!kind) continue;
    let size = object.bytes.length;
    let first = ((kind << 4) | (size & 15)) & 0x7f;
    size = Math.floor(size / 16);
    const header = [first];
    if (size > 0) header[0] |= 0x80;
    while (size > 0) { let byte = size & 0x7f; size = Math.floor(size / 128); if (size > 0) byte |= 0x80; header.push(byte); }
    chunks.push(Buffer.from(header), deflateSync(object.bytes));
  }
  const content = Buffer.concat(chunks);
  return Buffer.concat([content, createHash('sha1').update(content).digest()]);
}

function readVarint(bytes: Buffer, state: { offset: number }): { type: number; size: number } {
  const first = bytes[state.offset++];
  let size = first & 15;
  let shift = 4;
  let current = first;
  while (current & 0x80) { current = bytes[state.offset++]; size += (current & 127) * 2 ** shift; shift += 7; }
  return { type: (first >> 4) & 7, size };
}

function inflateAt(bytes: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(bytes.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function deltaSize(delta: Buffer, state: { offset: number }): number {
  let size = 0;
  let shift = 0;
  let byte: number;
  do { byte = delta[state.offset++]; size += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
  return size;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const state = { offset: 0 };
  const sourceSize = deltaSize(delta, state);
  const targetSize = deltaSize(delta, state);
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  while (state.offset < delta.length) {
    const opcode = delta[state.offset++];
    if (opcode & 128) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (opcode & (1 << bit)) copyOffset += delta[state.offset++] * 2 ** (8 * bit);
      for (let bit = 4; bit < 7; bit += 1) if (opcode & (1 << bit)) copySize += delta[state.offset++] * 2 ** (8 * (bit - 4));
      chunks.push(base.subarray(copyOffset, copyOffset + (copySize || 65536)));
    } else if (opcode > 0) { chunks.push(delta.subarray(state.offset, state.offset + opcode)); state.offset += opcode; }
    else throw new Error('invalid delta opcode');
  }
  const result = Buffer.concat(chunks);
  if (result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export function readPack(store: Store, pack: Buffer): boolean {
  try {
    if (pack.length < 32 || pack.subarray(0, 4).toString() !== 'PACK') return false;
    const trailer = pack.subarray(-20);
    if (!createHash('sha1').update(pack.subarray(0, -20)).digest().equals(trailer)) return false;
    const count = pack.readUInt32BE(8);
    const trailerOffset = pack.length - 20;
    const state = { offset: 12 };
    const entries: { offset: number; type: number; bytes: Buffer; baseOffset?: number; baseOid?: string; size: number }[] = [];
    for (let index = 0; index < count; index += 1) {
      const entryOffset = state.offset;
      const header = readVarint(pack, state);
      const entry: { offset: number; type: number; bytes: Buffer; baseOffset?: number; baseOid?: string; size: number } = { offset: entryOffset, type: header.type, bytes: Buffer.alloc(0), size: header.size };
      if (header.type === 6) {
        let byte = pack[state.offset++];
        let distance = byte & 127;
        while (byte & 128) { byte = pack[state.offset++]; distance = (distance + 1) * 128 + (byte & 127); }
        entry.baseOffset = entryOffset - distance;
      } else if (header.type === 7) { entry.baseOid = pack.subarray(state.offset, state.offset + 20).toString('hex'); state.offset += 20; }
      const inflated = inflateAt(pack.subarray(0, trailerOffset), state.offset);
      if (inflated.data.length !== header.size) return false;
      entry.bytes = inflated.data;
      state.offset = inflated.next;
      entries.push(entry);
    }
    const resolved = new Map<string, GitObject>();
    const byOffset = new Map(entries.map((entry) => [entry.offset, entry]));
    const resolve = (entry: typeof entries[number]): GitObject => {
      const kind = TYPE_TO_KIND[entry.type];
      if (kind) return { kind, bytes: entry.bytes };
      // Find a reference-delta base by its object id.
      let base: GitObject | undefined;
      if (entry.type === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        base = baseEntry ? resolve(baseEntry) : undefined;
      } else if (entry.baseOid) {
        // A reference-delta base is already resolved in the pack or lives in the store.
        base = resolved.get(entry.baseOid);
        if (!base) base = fetchObject(store, entry.baseOid);
      }
      if (!base) throw new Error('missing delta base');
      return { kind: base.kind, bytes: applyDelta(base.bytes, entry.bytes) };
    };
    for (const entry of entries) {
      const object = resolve(entry);
      const oid = storeObject(store, object.kind, object.bytes);
      resolved.set(oid, object);
    }
    return true;
  } catch { return false; }
}

function packetReply(body: Buffer, contentType: string, status = 200): Reply {
  return { status, headers: { 'content-type': contentType }, body };
}

function jsonNotFound(): Reply {
  return { status: 404, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
}

function findRepository(store: Store, owner: string, repo: string): Repository | undefined {
  const direct = store.repositories.get(`${owner}/${repo}`) as Repository | undefined;
  if (direct) return direct;
  return [...store.repositories.values()].find((candidate) => candidate.name === repo) as Repository | undefined;
}

function refsWithPeels(store: Store, repo: Repository): { oid: string; ref: string; peeled?: string }[] {
  return listRepositoryRefs(repo).map((entry) => {
    const object = fetchObject(store, entry.oid);
    if (object?.kind !== 'tag') return entry;
    const peeled = resolveRefName(store, repo, entry.ref);
    return peeled ? { ...entry, peeled } : entry;
  });
}

export function handleInfoRefs(input: { store: Store; owner: string; repo: string; body: Buffer; query: Record<string, string>; headers: Record<string, string> }): Reply {
  const repository = findRepository(input.store, input.owner, input.repo);
  const service = input.query.service;
  if (!repository || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) return jsonNotFound();
  const contentType = `application/x-${service}-advertisement`;
  const refs = refsWithPeels(input.store, repository);
  if (service === 'git-upload-pack' && input.headers['git-protocol']?.includes('version=2')) {
    const lines = ['version 2', 'ls-refs=unborn peel symrefs ref-prefix', 'fetch=shallow', 'agent=git-core-clone/1.0', 'object-format=sha1'];
    return packetReply(Buffer.concat([...lines.map(encodePacket), Buffer.from('0000')]), contentType);
  }
  const capabilities = service === 'git-upload-pack' ? `side-band-64k symref=HEAD:refs/heads/${repository.default_branch} agent=git-core-clone/1.0` : `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${repository.default_branch} agent=git-core-clone/1.0`;
  const chunks: Buffer[] = [encodePacket(`# service=${service}`), Buffer.from('0000')];
  if (refs.length === 1 && refs[0].ref === 'HEAD' && refs[0].oid === ZERO_OID) chunks.push(encodePacket(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}`), Buffer.from([0]), Buffer.from(capabilities)])));
  else {
    for (const entry of refs) {
      if (entry.ref === 'HEAD') continue;
      const line = `${entry.oid} ${entry.ref}`;
      chunks.push(encodePacket(Buffer.concat([Buffer.from(line), chunks.length === 2 ? Buffer.from([0, ...Buffer.from(capabilities)]) : Buffer.alloc(0)])));
      if (entry.peeled) chunks.push(encodePacket(`${entry.peeled} ${entry.ref}^{}`));
    }
    if (refs.length === 0) chunks.push(encodePacket(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}`), Buffer.from([0]), Buffer.from(capabilities)])));
  }
  chunks.push(Buffer.from('0000'));
  return packetReply(Buffer.concat(chunks), contentType);
}

function walkObjects(store: Store, oid: string, output: Map<string, GitObject>, shallow: Set<string>, depth: number, maxDepth: number): void {
  if (output.has(oid) || depth > maxDepth) return;
  const object = fetchObject(store, oid);
  if (!object) return;
  output.set(oid, object);
  if (object.kind === 'commit') {
    const commit = parseCommitBytes(object.bytes);
    walkObjects(store, commit.tree, output, shallow, depth, maxDepth);
    if (!shallow.has(oid)) for (const parent of commit.parents) walkObjects(store, parent, output, shallow, depth + 1, maxDepth);
  } else if (object.kind === 'tree') {
    let offset = 0;
    while (offset < object.bytes.length) {
      const space = object.bytes.indexOf(32, offset);
      const nul = object.bytes.indexOf(0, space + 1);
      if (space < 0 || nul < 0 || nul + 21 > object.bytes.length) break;
      const mode = object.bytes.subarray(offset, space).toString();
      const childOid = object.bytes.subarray(nul + 1, nul + 21).toString('hex');
      if (mode === '40000' || mode === '040000') {
        walkObjects(store, childOid, output, shallow, depth, maxDepth);
      } else {
        const blob = fetchObject(store, childOid);
        if (blob) output.set(childOid, blob);
      }
      offset = nul + 21;
    }
  }
}

function commandLines(packets: Packet[]): string[] {
  return packets.filter((packet) => packet.type === 'data').map((packet) => packet.payload!.toString().replace(/\n$/, ''));
}

export function handleUploadPack(input: { store: Store; owner: string; repo: string; body: Buffer; query: Record<string, string>; headers: Record<string, string> }): Reply {
  const repository = findRepository(input.store, input.owner, input.repo);
  if (!repository) return jsonNotFound();
  const { packets } = decodePackets(input.body);
  const lines = commandLines(packets);
  const command = lines.find((line) => line.startsWith('command='));
  if (!command) return packetReply(Buffer.from('0000'), 'application/x-git-upload-pack-result');
  if (command === 'command=ls-refs') {
    const args = lines.slice(lines.indexOf(command) + 1);
    const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice(11));
    const out: Buffer[] = [];
    const refs = refsWithPeels(input.store, repository);
    if (!repository.branches.has(repository.default_branch)) {
      const suffix = args.includes('symrefs') ? ' symref-target:refs/heads/' + repository.default_branch : '';
      out.push(encodePacket(`unborn HEAD${suffix}`));
    }
    // Advertise HEAD as a symref so clients can learn the default branch.
    for (const ref of refs) {
      if (prefixes.length > 0 && !prefixes.some((prefix) => ref.ref.startsWith(prefix))) continue;
      let value = `${ref.oid} ${ref.ref}`;
      if (ref.ref === 'HEAD' && args.includes('symrefs')) value += ` symref-target:refs/heads/${repository.default_branch}`;
      if (args.includes('peel') && ref.peeled) value += ` peeled:${ref.peeled}`;
      out.push(encodePacket(value));
    }
    out.push(Buffer.from('0000'));
    return packetReply(Buffer.concat(out), 'application/x-git-upload-pack-result');
  }
  if (command !== 'command=fetch') return packetReply(Buffer.from('0000'), 'application/x-git-upload-pack-result');
  // End every fetch text line with a newline because the kit matches headers exactly that way.
  // When done is set, send no acknowledgment section; the client jumps straight to the packfile.
  const args = lines.slice(lines.indexOf(command) + 1);
  const wants = args.filter((line) => line.startsWith('want ')).map((line) => line.slice(5));
  const haves = args.filter((line) => line.startsWith('have ')).map((line) => line.slice(5));
  const shallow = new Set(args.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8)));
  const deepen = Number(args.find((line) => line.startsWith('deepen '))?.slice(7) ?? 0);
  const done = args.includes('done');
  const acked = haves.filter((have) => wants.some((want) => commitAncestors(input.store, [want]).has(have)));
  const ackLines = ['acknowledgments', ...(acked.length ? acked.map((oid) => `ACK ${oid}`) : ['NAK']), ...(done && acked.length ? ['ready'] : [])];
  const ackTerminator = done && acked.length ? '0001' : '0000';
  const ackSection = Buffer.concat([...ackLines.map((line) => encodePacket(`${line}\n`)), Buffer.from(ackTerminator)]);
  const missing = wants.length === 0 || wants.some((oid) => !fetchObject(input.store, oid));
  if (missing) return packetReply(!done && haves.length ? ackSection : Buffer.from('0000'), 'application/x-git-upload-pack-result');
  const wantedObjects = new Map<string, GitObject>();
  // Deepening crosses the client's old shallow boundary, with depth limiting the extra commits.
  const wantedShallow = deepen > 0 ? new Set<string>() : shallow;
  for (const want of wants) walkObjects(input.store, want, wantedObjects, wantedShallow, 0, deepen > 0 ? deepen - 1 : Number.POSITIVE_INFINITY);
  const haveObjects = new Map<string, GitObject>();
  for (const have of haves) walkObjects(input.store, have, haveObjects, shallow, 0, Number.POSITIVE_INFINITY);
  for (const oid of haveObjects.keys()) wantedObjects.delete(oid);
  // Ready ends acknowledgments with a delimiter; otherwise they end with a flush.
  // Sections follow one another directly, without inserted separator packets.
  // Send shallow information and the pack only after the client sends done.
  const sections: Buffer[] = [];
  if (!done && haves.length) sections.push(ackSection);
  if (done && deepen > 0) {
    const shallowLines = ['shallow-info'];
    for (const [oid] of wantedObjects) {
      const object = fetchObject(input.store, oid);
      if (object?.kind === 'commit') { const commit = parseCommitBytes(object.bytes); if (commit.parents.length && commitAncestors(input.store, wants, deepen - 1).has(oid)) shallowLines.push(`shallow ${oid}`); }
    }
    sections.push(Buffer.concat([...shallowLines.map((line) => encodePacket(`${line}\n`)), Buffer.from('0000')]));
  }
  if (done && wantedObjects.size) sections.push(Buffer.concat([encodePacket('packfile\n'), sideband(encodePack([...wantedObjects.values()]))]));
  return packetReply(Buffer.concat(sections), 'application/x-git-upload-pack-result');
}

export function handleReceivePack(input: { store: Store; owner: string; repo: string; body: Buffer; query: Record<string, string>; headers: Record<string, string> }): Reply {
  const repository = findRepository(input.store, input.owner, input.repo);
  if (!repository) return jsonNotFound();
  const decoded = decodePackets(input.body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let sidebandEnabled = false;
  for (const packet of decoded.packets) {
    if (packet.type === 'flush') break;
    if (packet.type !== 'data') continue;
    const line = packet.payload!.toString().replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const command = nul < 0 ? line : line.slice(0, nul);
    const capabilities = nul < 0 ? '' : line.slice(nul + 1);
    const [oldOid, newOid, ref] = command.split(' ');
    if (capabilities.split(' ').includes('side-band-64k')) sidebandEnabled = true;
    commands.push({ oldOid, newOid, ref });
  }
  const pack = decoded.rest;
  const unpackOk = pack.length === 0 || readPack(input.store, pack);
  const report = [`unpack ${unpackOk ? 'ok' : 'error'}`];
  for (const command of commands) {
    let target: Map<string, string> | undefined;
    let name = '';
    if (command.ref.startsWith('refs/heads/')) { target = repository.branches; name = command.ref.slice(11); }
    else if (command.ref.startsWith('refs/tags/')) { target = repository.tags; name = command.ref.slice(10); }
    let error = '';
    const current = target?.get(name);
    if (!unpackOk) error = 'unpacker error';
    else if (!target) error = 'invalid ref';
    else if (command.oldOid === ZERO_OID && current) error = 'already exists';
    else if (command.newOid === ZERO_OID && !current) error = 'no such ref';
    else if (command.oldOid !== ZERO_OID && current !== command.oldOid) error = 'no such ref';
    // Deletions have no new commit ancestry to check; matching the old ref is sufficient.
    else if (command.oldOid !== ZERO_OID && command.newOid !== ZERO_OID && !isFastForward(input.store, command.oldOid, command.newOid)) error = 'non-fast-forward';
    if (error) report.push(`ng ${command.ref} ${error}`);
    else { if (command.newOid === ZERO_OID) target!.delete(name); else target!.set(name, command.newOid); report.push(`ok ${command.ref}`); }
  }
  const reportPackets = Buffer.concat([...report.map((line) => encodePacket(`${line}\n`)), Buffer.from('0000')]);
  const body = sidebandEnabled ? sideband(reportPackets) : reportPackets;
  return packetReply(body, 'application/x-git-receive-pack-result');
}
