/**
 * Shared in-memory state and deterministic identifiers for the forge.
 * Repository construction defaults are applied by the repository callers.
 */
import { createHash } from 'node:crypto';

export type GitObjectKind = 'blob' | 'tree' | 'commit' | 'tag';

export type GitObject = {
  kind: GitObjectKind;
  bytes: Buffer;
};

export type Issue = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: unknown[];
  created_at: string;
  updated_at: string;
};

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  head_branch: string;
  head_tip: string;
  base_branch: string;
  base_tip: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_id: string | null;
  files: unknown[];
};

export type Label = {
  name: string;
  colour: string;
  description: string;
};

export type Repository = {
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  branches: Map<string, string>;
  tags: Map<string, string>;
  issues: Issue[];
  next_issue_number: number;
  pull_requests: PullRequest[];
  next_pull_number: number;
  labels: Map<string, Label>;
  next_comment_id: number;
  id: number;
};

export type Store = {
  repositories: Map<string, Repository>;
  objects: Map<string, GitObject>;
  owner: string | null;
};

let issueTimestampCallCount = 0;
let requestIdCounter = 1;
let repositoryIdCounter = 100000;

function getIssueTimestampBase(): number {
  const configuredTimestamp = process.env.MAKEFUN_TRIAL_NOW;

  if (configuredTimestamp !== undefined) {
    const parsedTimestamp = Date.parse(configuredTimestamp);

    if (Number.isFinite(parsedTimestamp)) {
      return parsedTimestamp;
    }
  }

  return Date.parse('2026-01-01T00:00:00.000Z');
}

const issueTimestampBase = getIssueTimestampBase();

export function createStore(): Store {
  return {
    repositories: new Map<string, Repository>(),
    objects: new Map<string, GitObject>(),
    owner: null,
  };
}

export function hashObject(kind: GitObjectKind, bytes: Buffer): string {
  const header = Buffer.from(`${kind} ${bytes.length}\0`, 'ascii');
  const hash = createHash('sha1');

  hash.update(header);
  hash.update(bytes);

  return hash.digest('hex');
}

export function storeObject(store: Store, kind: GitObjectKind, bytes: Buffer): string {
  const objectId = hashObject(kind, bytes);
  const storedBytes = Buffer.from(bytes);

  store.objects.set(objectId, {
    kind,
    bytes: storedBytes,
  });

  return objectId;
}

export function fetchObject(store: Store, id: string): GitObject | undefined {
  return store.objects.get(id);
}

export function allocateGlobalId(
  kind: string,
  owner: string,
  repository: string,
  number: number,
): string {
  const value = `${kind}:${owner}/${repository}:${number}`;
  return Buffer.from(value, 'ascii').toString('base64url');
}

export function issueTimestamp(): string {
  const timestamp = issueTimestampBase + issueTimestampCallCount * 1000;
  issueTimestampCallCount += 1;

  return new Date(timestamp).toISOString();
}

export function nextRequestId(): string {
  const requestId = `MF-${requestIdCounter}`;
  requestIdCounter += 1;

  return requestId;
}

export function learnOrCheckOwner(store: Store, owner: string): boolean {
  if (store.owner === null) {
    store.owner = owner;
    return true;
  }

  return store.owner === owner;
}

export function allocateRepositoryId(): number {
  const repositoryId = repositoryIdCounter;
  repositoryIdCounter += 1;

  return repositoryId;
}
