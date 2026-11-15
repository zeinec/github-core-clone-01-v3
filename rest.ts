/**
 * GitHub-compatible REST routes for repository discovery and Git contents.
 * Handlers return null when another router should handle the request.
 */
import {
  allocateGlobalId,
  allocateRepositoryId,
  fetchObject,
  hashObject,
  issueTimestamp,
  storeObject,
  type Repository,
  type Store,
} from './store.ts';
import {
  buildTreeFromFiles,
  createCommitObject,
  flattenTree,
  parseCommitBytes,
  readBlobAtRef,
  resolveRefName,
} from './git.ts';

type RestInput = {
  store: Store;
  owner: string;
  repo: string;
  method: string;
  path: string;
  segments: string[];
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Buffer;
  json?: any;
  baseUrl: string;
};

type Reply = {
  status: number;
  headers?: Record<string, string>;
  body: any;
};

type TreeEntry = {
  path: string;
  oid: string;
  bytes: Buffer;
};

function errorReply(status: number, message: string): Reply {
  return { status, body: { message } };
}

function repoObject(store: Store, repository: Repository, inputOwner: string): Record<string, unknown> {
  const login = store.owner || inputOwner || '';
  const fullName = login ? `${login}/${repository.name}` : repository.name;
  const htmlUrl = `https://github.com/${login}/${repository.name}`;
  const openIssues = repository.issues.filter((issue) => issue.state === 'open').length;

  return {
    id: repository.id,
    node_id: allocateGlobalId('Repository', login, repository.name, repository.id),
    name: repository.name,
    full_name: fullName,
    owner: { login, id: 1, type: 'User' },
    private: repository.private,
    description: repository.description,
    default_branch: repository.default_branch,
    created_at: repository.created_at,
    updated_at: repository.updated_at,
    html_url: htmlUrl,
    clone_url: `${htmlUrl}.git`,
    git_url: `git://github.com/${login}/${repository.name}.git`,
    ssh_url: `git@github.com:${login}/${repository.name}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function handleUserRepos(input: RestInput): Promise<Reply | null> {
  if (input.path !== '/api/v3/user/repos') {
    return null;
  }

  if (input.method === 'GET') {
    const requestedPerPage = parsePositiveInteger(input.query.per_page, 30);
    const perPage = Math.min(100, Math.max(1, requestedPerPage));
    const requestedPage = parsePositiveInteger(input.query.page, 1);
    const page = Math.max(1, requestedPage);
    const repositories = Array.from(input.store.repositories.values());
    const start = (page - 1) * perPage;
    const pageRepositories = repositories.slice(start, start + perPage);
    const headers: Record<string, string> = {};

    if (start + perPage < repositories.length) {
      const nextUrl = new URL(input.path, input.baseUrl);
      nextUrl.searchParams.set('per_page', String(perPage));
      nextUrl.searchParams.set('page', String(page + 1));
      headers.Link = `<${nextUrl.toString()}>; rel="next"`;
    }

    return {
      status: 200,
      headers,
      body: pageRepositories.map((repository) => repoObject(input.store, repository, input.owner)),
    };
  }

  if (input.method !== 'POST') {
    return null;
  }

  const body = input.json ?? {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';

  if (!name) {
    return errorReply(422, 'name is required');
  }
  if (input.store.repositories.has(name)) {
    return errorReply(422, 'Repository already exists');
  }

  const timestamp = issueTimestamp();
  const repository: Repository = {
    name,
    description: typeof body.description === 'string' ? body.description : '',
    private: typeof body.private === 'boolean' ? body.private : false,
    default_branch: 'main',
    created_at: timestamp,
    updated_at: timestamp,
    branches: new Map<string, string>(),
    tags: new Map<string, string>(),
    issues: [],
    next_issue_number: 1,
    pull_requests: [],
    next_pull_number: 1,
    labels: new Map(),
    next_comment_id: 1,
    id: allocateRepositoryId(),
  };

  input.store.repositories.set(name, repository);
  return { status: 201, body: repoObject(input.store, repository, input.owner) };
}

function parseIdentity(identity: string, login: string): { identity: Record<string, string>; user: { login: string } } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(identity);
  const epochSeconds = match ? Number(match[3]) : 0;
  const date = new Date(epochSeconds * 1000).toISOString();
  const parsed = {
    name: match?.[1] ?? '',
    email: match?.[2] ?? '',
    date,
  };

  return { identity: parsed, user: { login } };
}

function getCommitEntries(store: Store, commitId: string): TreeEntry[] {
  const object = fetchObject(store, commitId);
  if (!object || object.kind !== 'commit') {
    return [];
  }

  const commit = parseCommitBytes(object.bytes);
  return flattenTree(store, commit.tree);
}

function listDirectoryEntries(store: Store, entries: TreeEntry[], path: string): Record<string, unknown>[] {
  const prefix = path ? `${path}/` : '';
  const children = new Map<string, { entry?: TreeEntry; nested: Map<string, Buffer> }>();

  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) {
      continue;
    }

    const remainder = entry.path.slice(prefix.length);
    const separator = remainder.indexOf('/');
    const name = separator < 0 ? remainder : remainder.slice(0, separator);
    if (!name) {
      continue;
    }

    let child = children.get(name);
    if (!child) {
      child = { nested: new Map<string, Buffer>() };
      children.set(name, child);
    }

    if (separator < 0) {
      child.entry = entry;
    } else {
      child.nested.set(remainder.slice(separator + 1), entry.bytes);
    }
  }

  const result: Record<string, unknown>[] = [];
  for (const [name, child] of children) {
    if (child.entry) {
      result.push({
        type: 'file',
        name,
        path: prefix + name,
        sha: child.entry.oid,
        size: child.entry.bytes.length,
      });
    } else {
      result.push({
        type: 'dir',
        name,
        path: prefix + name,
        sha: buildTreeFromFiles(store, child.nested),
        size: 0,
      });
    }
  }

  return result;
}

function getContentsReply(input: RestInput, repository: Repository, path: string): Reply {
  const tip = resolveRefName(input.store, repository, input.query.ref || repository.default_branch);
  if (!tip) {
    return errorReply(404, 'Not Found');
  }

  const bytes = readBlobAtRef(input.store, repository, tip, path);
  if (bytes) {
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: bytes.toString('base64'),
        sha: hashObject('blob', bytes),
        size: bytes.length,
        name: path.split('/').pop() ?? '',
        path,
      },
    };
  }

  const entries = getCommitEntries(input.store, tip);
  const prefix = path ? `${path}/` : '';
  if (path && !entries.some((entry) => entry.path.startsWith(prefix))) {
    return errorReply(404, 'Not Found');
  }

  return { status: 200, body: listDirectoryEntries(input.store, entries, path) };
}

function updateContents(input: RestInput, repository: Repository, path: string): Reply {
  if (!path) {
    return errorReply(400, 'A file path is required');
  }

  const body = input.json ?? {};
  const branch = typeof body.branch === 'string' ? body.branch : repository.default_branch;
  const tip = repository.branches.get(branch) ?? null;
  if (!tip && repository.branches.size > 0) {
    return errorReply(404, 'Branch not found');
  }

  const entries = tip ? getCommitEntries(input.store, tip) : [];
  const existing = entries.find((entry) => entry.path === path);
  if (input.method === 'DELETE' && !existing) {
    return errorReply(404, 'Not Found');
  }
  if (body.sha !== undefined && (!existing || body.sha !== existing.oid)) {
    return errorReply(409, 'sha does not match');
  }

  const files = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  let bytes: Buffer | undefined;

  if (input.method === 'PUT') {
    if (typeof body.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content)) {
      return errorReply(400, 'Invalid base64 content');
    }
    bytes = Buffer.from(body.content, 'base64');
    files.set(path, bytes);
  } else {
    files.delete(path);
  }

  const tree = buildTreeFromFiles(input.store, files);
  const stamp = issueTimestamp();
  const epoch = Math.floor(Date.parse(stamp) / 1000);
  const authorStamp = `${epoch} +0000`;
  const login = input.store.owner || input.owner || '';
  const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
  const commit = createCommitObject(
    input.store,
    tree,
    tip ? [tip] : [],
    login,
    `${login}@example.invalid`,
    authorStamp,
    login,
    `${login}@example.invalid`,
    authorStamp,
    message,
  );

  repository.branches.set(branch, commit);
  repository.updated_at = stamp;

  if (input.method === 'DELETE') {
    return { status: 200, body: { commit: { sha: commit } } };
  }

  return {
    status: existing ? 200 : 201,
    body: {
      content: {
        name: path.split('/').pop() ?? '',
        path,
        sha: storeObject(input.store, 'blob', bytes ?? Buffer.alloc(0)),
        size: (bytes ?? Buffer.alloc(0)).length,
        type: 'file',
        encoding: 'base64',
        content: (bytes ?? Buffer.alloc(0)).toString('base64'),
      },
      commit: { sha: commit },
    },
  };
}

export async function handleRepoRoutes(input: RestInput): Promise<Reply | null> {
  if (!input.path.startsWith('/api/v3/repos/') || input.segments.length < 5) {
    return null;
  }

  const name = input.segments[4];
  const tail = input.segments.slice(5);
  const repository = input.store.repositories.get(name);
  if (!repository) {
    return errorReply(404, 'Not Found');
  }

  if (tail.length === 0) {
    if (input.method === 'GET') {
      return { status: 200, body: repoObject(input.store, repository, input.owner) };
    }
    if (input.method === 'PATCH') {
      if (typeof input.json?.description === 'string') {
        repository.description = input.json.description;
      }
      repository.updated_at = issueTimestamp();
      return { status: 200, body: repoObject(input.store, repository, input.owner) };
    }
    if (input.method === 'DELETE') {
      input.store.repositories.delete(name);
      return { status: 204, body: null };
    }
    return null;
  }

  if (tail.length === 1 && tail[0] === 'branches' && input.method === 'GET') {
    const branches = Array.from(repository.branches, ([branchName, sha]) => ({
      name: branchName,
      commit: { sha },
      protected: false,
    }));
    return { status: 200, body: branches };
  }

  if (tail.length === 1 && tail[0] === 'commits' && input.method === 'GET') {
    let tip = resolveRefName(input.store, repository, input.query.sha || repository.default_branch);
    if (!tip && /^[0-9a-fA-F]{40}$/.test(input.query.sha ?? '')) {
      tip = input.query.sha;
    }
    if (!tip) {
      return { status: 200, body: [] };
    }

    const commits: Record<string, unknown>[] = [];
    const queue = [tip];
    const seen = new Set<string>();
    const login = input.store.owner || input.owner;

    for (let index = 0; index < queue.length; index += 1) {
      const oid = queue[index];
      if (seen.has(oid)) {
        continue;
      }
      seen.add(oid);
      const object = fetchObject(input.store, oid);
      if (!object || object.kind !== 'commit') {
        continue;
      }

      const commit = parseCommitBytes(object.bytes);
      const author = parseIdentity(commit.author, login);
      const committer = parseIdentity(commit.committer, login);
      commits.push({
        sha: oid,
        commit: {
          message: commit.message,
          author: author.identity,
          committer: committer.identity,
        },
        author: author.user,
        committer: committer.user,
        parents: commit.parents.map((parent) => ({ sha: parent })),
      });
      queue.push(...commit.parents);
    }

    return { status: 200, body: commits };
  }

  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && input.method === 'POST') {
    const ref = input.json?.ref;
    const sha = input.json?.sha;
    if (typeof ref !== 'string' || !ref.startsWith('refs/heads/') || typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) || !fetchObject(input.store, sha)) {
      return errorReply(422, 'Invalid ref or sha');
    }

    const branch = ref.slice('refs/heads/'.length);
    if (repository.branches.has(branch)) {
      return errorReply(422, 'Reference already exists');
    }
    repository.branches.set(branch, sha);
    return { status: 201, body: { ref, object: { sha } } };
  }

  if (tail[0] !== 'contents') {
    return null;
  }

  const path = tail.slice(1).join('/');
  if (input.method === 'GET') {
    return getContentsReply(input, repository, path);
  }
  if (input.method === 'PUT' || input.method === 'DELETE') {
    return updateContents(input, repository, path);
  }

  return null;
}
