/**
 * Issue and pull request records, merge planning, and GitHub-compatible routes.
 * Repository state remains in the shared in-memory store.
 */
import { allocateGlobalId, fetchObject, issueTimestamp, type Store } from './store.ts';
import {
  buildTreeFromFiles,
  commitAncestors,
  createCommitObject,
  diffTrees,
  flattenTree,
  parseCommitBytes,
  resolveRefName,
} from './git.ts';

type Repository = Store['repositories'] extends Map<string, infer Value> ? Value : never;
type IssueRecord = Repository['issues'][number];
type PullRecord = Repository['pull_requests'][number];
type RouteInput = {
  store: Store;
  owner: string;
  repo: string;
  method: string;
  path: string;
  segments?: string[];
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Buffer;
  json?: any;
  baseUrl: string;
};
type RouteReply = { status: number; headers?: Record<string, string>; body: any };
type Commit = ReturnType<typeof parseCommitBytes>;
type FileMap = Map<string, Buffer>;

function issueByNumber(repository: Repository, number: number): IssueRecord | null {
  return repository.issues.find((issue) => issue.number === Number(number)) ?? null;
}

function pullByNumber(repository: Repository, number: number): PullRecord | null {
  return repository.pull_requests.find((pull) => pull.number === Number(number)) ?? null;
}

function labelsOf(issue: IssueRecord): { name: string }[] {
  return issue.labels.map((name) => ({ name }));
}

function stamp(): string {
  return issueTimestamp();
}

function loginFor(store: Store, owner: string): string {
  return store.owner || owner;
}

function seconds(iso: string): string {
  return `${Math.floor(new Date(iso).getTime() / 1000)} +0000`;
}

function identity(store: Store, owner: string): { login: string; email: string } {
  const login = loginFor(store, owner);
  return { login, email: `${login}@example.invalid` };
}

function errorWithStatus(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

export function createIssueRecord(
  store: Store,
  repository: Repository,
  owner: string,
  title: string | null,
  body: string | null | undefined,
  labelNames: unknown = [],
): IssueRecord {
  if (title === null || title === '') {
    throw errorWithStatus(422, 'title is required');
  }
  const names = Array.isArray(labelNames) ? labelNames : [];
  for (const name of names) {
    if (!repository.labels.has(name)) {
      throw errorWithStatus(422, `label does not exist: ${name}`);
    }
  }
  const now = stamp();
  const issue = {
    number: repository.next_issue_number++,
    title,
    body: body ?? '',
    state: 'open' as const,
    labels: [...names],
    comments: [],
    created_at: now,
    updated_at: now,
  };
  repository.issues.push(issue);
  return issue;
}

export function closeIssueRecord(
  store: Store,
  repository: Repository,
  number: number,
): IssueRecord | null {
  const issue = issueByNumber(repository, number);
  if (!issue) {
    return null;
  }
  issue.state = 'closed';
  issue.updated_at = stamp();
  return issue;
}

export function addIssueComment(
  store: Store,
  repository: Repository,
  number: number,
  body: string | null | undefined,
): { id: number; body: string } | null {
  const issue = issueByNumber(repository, number);
  if (!issue) {
    return null;
  }
  const comment = { id: repository.next_comment_id++, body: body ?? '' };
  issue.comments.push(comment);
  return comment;
}

export function formatIssue(issue: IssueRecord, owner: string, repositoryName: string): Record<string, any> {
  return {
    url: `/api/v3/repos/${owner}/${repositoryName}/issues/${issue.number}`,
    id: allocateGlobalId('Issue', owner, repositoryName, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: labelsOf(issue),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function commitFor(store: Store, id: string): Commit | null {
  const object = fetchObject(store, id);
  if (!object || object.kind !== 'commit') {
    return null;
  }
  return parseCommitBytes(object.bytes);
}

function filesForTips(store: Store, baseTip: string, headTip: string): unknown[] {
  const base = commitFor(store, baseTip);
  const head = commitFor(store, headTip);
  if (!base || !head) {
    return [];
  }
  return diffTrees(store, base.tree, head.tree);
}

export function createPullRecord(
  store: Store,
  repository: Repository,
  owner: string,
  title: string | null,
  body: string | null | undefined,
  headBranch: string,
  baseBranch: string,
): PullRecord {
  const headTip = resolveRefName(store, repository, headBranch);
  const baseTip = resolveRefName(store, repository, baseBranch);
  if (!headTip || !baseTip) {
    throw errorWithStatus(422, 'head or base branch was not found');
  }
  if (title === null || title === '') {
    throw errorWithStatus(422, 'title is required');
  }
  const pull: PullRecord = {
    number: repository.next_pull_number++,
    title,
    body: body ?? '',
    head_branch: headBranch,
    head_tip: headTip,
    base_branch: baseBranch,
    base_tip: baseTip,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_id: null,
    files: filesForTips(store, baseTip, headTip),
  };
  repository.pull_requests.push(pull);
  return pull;
}

export function pullFilesFor(store: Store, repository: Repository, pull: PullRecord): unknown[] {
  if (!pull.files) {
    pull.files = filesForTips(store, pull.base_tip, pull.head_tip);
  }
  return pull.files;
}

function filesForTree(store: Store, commit: Commit | null): FileMap {
  if (!commit || !commit.tree) {
    return new Map();
  }
  return new Map(flattenTree(store, commit.tree).map((file) => [file.path, file.bytes]));
}

function bytesEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left.equals(right);
}

function mergePlan(
  store: Store,
  repository: Repository,
  pull: PullRecord,
): { conflict: true } | { conflict: false; files: FileMap; baseTip: string } {
  const headTip = pull.head_tip;
  const baseTip = resolveRefName(store, repository, repository.default_branch) || pull.base_tip;
  const baseCommit = commitFor(store, baseTip);
  const headCommit = commitFor(store, headTip);
  if (!baseCommit || !headCommit) {
    return { conflict: true };
  }
  const baseAncestors = commitAncestors(store, [baseTip]);
  const pending = [headTip];
  const visited = new Set<string>();
  let ancestorId = baseTip;
  while (pending.length > 0) {
    const candidateId = pending.shift() as string;
    if (visited.has(candidateId)) {
      continue;
    }
    visited.add(candidateId);
    if (baseAncestors.has(candidateId)) {
      ancestorId = candidateId;
      break;
    }
    const candidate = commitFor(store, candidateId);
    if (candidate) {
      pending.push(...candidate.parents);
    }
  }
  const ancestorFiles = filesForTree(store, commitFor(store, ancestorId));
  const baseFiles = filesForTree(store, baseCommit);
  const headFiles = filesForTree(store, headCommit);
  const allPaths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  const mergedFiles: FileMap = new Map();
  for (const path of allPaths) {
    const before = ancestorFiles.get(path);
    const ours = baseFiles.get(path);
    const theirs = headFiles.get(path);
    if (bytesEqual(ours, before)) {
      if (theirs !== undefined) {
        mergedFiles.set(path, theirs);
      }
    } else if (bytesEqual(theirs, before) || bytesEqual(ours, theirs)) {
      if (ours !== undefined) {
        mergedFiles.set(path, ours);
      }
    } else {
      return { conflict: true };
    }
  }
  return { conflict: false, files: mergedFiles, baseTip };
}

export function pullIsMergeable(store: Store, repository: Repository, pull: PullRecord): boolean {
  return pull.state === 'open' && !mergePlan(store, repository, pull).conflict;
}

export function mergePullRecord(
  store: Store,
  repository: Repository,
  owner: string,
  number: number,
  mergeMethod = 'squash',
): { merged: true; sha: string; merge_commit_sha: string; message: string } {
  const pull = pullByNumber(repository, number);
  if (!pull) {
    throw errorWithStatus(404, 'pull request not found');
  }
  if (mergeMethod !== 'squash') {
    throw errorWithStatus(405, 'only squash merges are supported');
  }
  if (pull.merged || pull.state !== 'open') {
    throw errorWithStatus(405, 'pull request is not open');
  }
  const plan = mergePlan(store, repository, pull);
  if (plan.conflict) {
    throw errorWithStatus(405, 'Pull request is not mergeable');
  }
  const tree = buildTreeFromFiles(store, plan.files);
  const branchTip = resolveRefName(store, repository, repository.default_branch);
  if (!branchTip) {
    throw errorWithStatus(405, 'default branch was not found');
  }
  const author = identity(store, owner);
  const time = seconds(stamp());
  const sha = createCommitObject(
    store,
    tree,
    [branchTip],
    author.login,
    author.email,
    time,
    author.login,
    author.email,
    time,
    `Merge pull request #${pull.number}: ${pull.title}\n`,
  );
  repository.branches.set(repository.default_branch, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = stamp();
  pull.merge_commit_id = sha;
  return {
    merged: true,
    sha,
    merge_commit_sha: sha,
    message: 'Pull request successfully merged',
  };
}

export function formatPull(
  pull: PullRecord,
  owner: string,
  repositoryName: string,
  store?: Store,
  repository?: Repository,
): Record<string, any> {
  const mergeable = store && repository ? pullIsMergeable(store, repository, pull) : false;
  return {
    url: `/api/v3/repos/${owner}/${repositoryName}/pulls/${pull.number}`,
    id: allocateGlobalId('PullRequest', owner, repositoryName, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_id,
    mergeable,
    head: { ref: pull.head_branch, sha: pull.head_tip },
    base: { ref: pull.base_branch, sha: pull.base_tip },
  };
}

function parseRouteData(input: RouteInput): any {
  if (typeof input.json === 'function') {
    return input.json();
  }
  if (input.json && typeof input.json === 'object') {
    return input.json;
  }
  return JSON.parse(input.body?.toString('utf8') || '{}');
}

function errorReply(error: any): RouteReply {
  return {
    status: error?.status || 500,
    body: { message: error?.message || 'Internal Server Error' },
  };
}

function routeNotFound(message: string): RouteReply {
  return { status: 404, body: { message } };
}

function routeIssueRequest(
  input: RouteInput,
  repository: Repository,
  owner: string,
  repositoryName: string,
  tail: string[],
  method: string,
  data: any,
): RouteReply | null {
  if (tail.length === 1 && method === 'POST') {
    const issue = createIssueRecord(input.store, repository, owner, data.title, data.body, data.labels || []);
    return { status: 201, body: { ...formatIssue(issue, owner, repositoryName), labels: labelsOf(issue) } };
  }
  if (tail.length === 1 && method === 'GET') {
    const state = input.query.state;
    const issues = repository.issues.filter((issue) => state === 'all' || issue.state === (state || 'open'));
    if (input.query.sort === 'created') {
      const direction = input.query.direction === 'asc' ? 1 : -1;
      issues.sort((left, right) => direction * (left.created_at.localeCompare(right.created_at) || left.number - right.number));
    } else {
      issues.sort((left, right) => left.number - right.number);
    }
    return { status: 200, body: issues.map((issue) => formatIssue(issue, owner, repositoryName)) };
  }
  if (tail.length < 2) {
    return null;
  }
  const number = Number.parseInt(tail[1], 10);
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  const issue = issueByNumber(repository, number);
  if (!issue) {
    return routeNotFound('Issue not found');
  }
  if (tail.length === 2 && method === 'GET') {
    return { status: 200, body: formatIssue(issue, owner, repositoryName) };
  }
  if (tail.length === 2 && method === 'PATCH') {
    if (data.state === 'closed') {
      closeIssueRecord(input.store, repository, number);
      if (data.title !== undefined) issue.title = data.title;
      if (data.body !== undefined) issue.body = data.body;
      return { status: 200, body: formatIssue(issue, owner, repositoryName) };
    }
    if (data.title !== undefined) issue.title = data.title;
    if (data.body !== undefined) issue.body = data.body;
    if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
    issue.updated_at = stamp();
    return { status: 200, body: formatIssue(issue, owner, repositoryName) };
  }
  if (tail.length === 3 && tail[2] === 'comments' && method === 'GET') {
    return { status: 200, body: issue.comments };
  }
  if (tail.length === 3 && tail[2] === 'comments' && method === 'POST') {
    return { status: 201, body: addIssueComment(input.store, repository, number, data.body) };
  }
  return null;
}

function branchName(value: any): string {
  return typeof value === 'string' ? value : value?.ref;
}

function routePullRequest(
  input: RouteInput,
  repository: Repository,
  owner: string,
  repositoryName: string,
  tail: string[],
  method: string,
  data: any,
): RouteReply | null {
  if (tail.length === 1 && method === 'POST') {
    const pull = createPullRecord(
      input.store,
      repository,
      owner,
      data.title,
      data.body,
      branchName(data.head),
      branchName(data.base),
    );
    return { status: 201, body: formatPull(pull, owner, repositoryName, input.store, repository) };
  }
  if (tail.length === 1 && method === 'GET') {
    const state = input.query.state || 'open';
    const pulls = repository.pull_requests.filter((pull) => state === 'all' || pull.state === state);
    return {
      status: 200,
      body: pulls.map((pull) => formatPull(pull, owner, repositoryName, input.store, repository)),
    };
  }
  if (tail.length < 2) {
    return null;
  }
  const number = Number.parseInt(tail[1], 10);
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  const pull = pullByNumber(repository, number);
  if (!pull) {
    return routeNotFound('Pull request not found');
  }
  if (tail.length === 2 && method === 'GET') {
    return { status: 200, body: formatPull(pull, owner, repositoryName, input.store, repository) };
  }
  if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
    return { status: 200, body: pullFilesFor(input.store, repository, pull) };
  }
  if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
    return { status: 200, body: mergePullRecord(input.store, repository, owner, number, data.merge_method || 'squash') };
  }
  return null;
}

export function handleIssueRoutes(input: RouteInput): RouteReply | null {
  const { store, owner, repo: repositoryName, method } = input;
  const parts = input.segments || [];
  if (
    parts.length < 5 ||
    parts[0] !== 'api' ||
    parts[1] !== 'v3' ||
    parts[2] !== 'repos' ||
    parts[3] !== owner ||
    parts[4] !== repositoryName
  ) {
    return null;
  }
  const repository = store.repositories.get(repositoryName);
  if (!repository) {
    return routeNotFound('Not Found');
  }
  const tail = parts.slice(5);
  let data: any;
  try {
    data = parseRouteData(input);
  } catch {
    return null;
  }
  try {
    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'GET') {
        const labels = [...repository.labels.values()].map(({ name, color }) => ({ name, color }));
        return { status: 200, body: labels };
      }
      if (method === 'POST') {
        if (!data.name) {
          throw errorWithStatus(422, 'name is required');
        }
        const label = { name: data.name, color: data.color || 'ededed' };
        repository.labels.set(label.name, label);
        return { status: 201, body: label };
      }
      return null;
    }
    if (tail[0] === 'issues') {
      return routeIssueRequest(input, repository, owner, repositoryName, tail, method, data);
    }
    if (tail[0] === 'pulls') {
      return routePullRequest(input, repository, owner, repositoryName, tail, method, data);
    }
    return null;
  } catch (error) {
    return errorReply(error);
  }
}
