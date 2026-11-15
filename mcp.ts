// This module adapts forge operations to the MCP JSON-RPC 2.0 protocol.
// It keeps transport validation and tool dispatch local to the endpoint.
import {
  issueTimestamp,
  allocateRepositoryId,
  allocateGlobalId,
  learnOrCheckOwner,
} from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
} from './issues.ts';

const REVISION = '2026-07-28';

const toolDefinitions = [
  {
    name: 'create_repo',
    description: 'Create a repository in the authenticated forge.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        owner: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an open issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List repository issues, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request between repository branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const toolAliases: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

const toolsByName = new Map<string, string>();

for (const definition of toolDefinitions) {
  toolsByName.set(definition.name, definition.name);
  for (const alias of toolAliases[definition.name]) {
    toolsByName.set(alias, definition.name);
  }
}

function rpcError(id: string | number | null, code: number, message: string) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

function rpcSuccess(id: string | number | null, result: unknown) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

function reply(status: number, body: unknown, headers?: Record<string, string>) {
  return {
    status,
    body,
    ...(headers ? { headers } : {}),
  };
}

function validRevision(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function repositoryView(repo: any, owner: string) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: owner + '/' + repo.name,
    private: !!repo.private,
    description: repo.description ?? '',
    default_branch: repo.default_branch ?? 'main',
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issueView(issue: any, owner: string, repoName: string) {
  return {
    number: issue.number,
    id: allocateGlobalId('Issue', owner, repoName, issue.number),
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state ?? 'open',
    labels: (issue.labels ?? []).map((label: any) => ({
      name: typeof label === 'string' ? label : label.name,
    })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullView(pull: any, owner: string, repoName: string) {
  return {
    number: pull.number,
    id: allocateGlobalId('PullRequest', owner, repoName, pull.number),
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state ?? 'open',
    merged: !!pull.merged,
    merged_at: pull.merged_at ?? null,
    merge_commit_sha: pull.merge_commit_id ?? null,
    head: { ref: pull.head_branch, sha: pull.head_tip },
    base: { ref: pull.base_branch, sha: pull.base_tip },
  };
}

function toolResult(payload: unknown, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function failure(message: string) {
  return toolResult({ message }, true);
}

function findRepository(store: any, name: string) {
  return store.repositories?.get(name);
}

function ownerFor(args: Record<string, any>, input: any): string | null {
  return typeof args.owner === 'string' ? args.owner : input.store.owner ?? input.owner;
}

function checkOwner(store: any, owner: string | null) {
  try {
    return learnOrCheckOwner(store, owner);
  } catch {
    return false;
  }
}

function callTool(nameArg: unknown, argsValue: unknown, input: any) {
  const rawName = typeof nameArg === 'string' ? nameArg : '';
  const normalizedName = rawName.replace(/^github__/i, '').toLowerCase();
  const name = toolsByName.get(normalizedName);

  if (!name) {
    return rpcError(null, -32602, 'Unknown tool: ' + rawName);
  }

  const args = argsValue && typeof argsValue === 'object' && !Array.isArray(argsValue)
    ? argsValue as Record<string, any>
    : {};
  const spec = toolDefinitions.find((definition) => definition.name === name)!;
  const missing = spec.inputSchema.required.find((key) => args[key] === undefined || args[key] === null || args[key] === '');

  if (missing) {
    return rpcSuccess(null, toolResult({ message: 'Missing required argument: ' + missing }, true));
  }

  const owner = ownerFor(args, input);

  try {
    if (name === 'create_repo') {
      if (typeof args.owner === 'string' && !checkOwner(input.store, owner)) {
        return rpcSuccess(null, failure('Unknown owner: ' + owner));
      }

      const repoName = String(args.name);
      if (findRepository(input.store, repoName)) {
        return rpcSuccess(null, failure('Repository already exists: ' + repoName));
      }

      const stamp = issueTimestamp();
      const record = {
        name: repoName,
        description: args.description ?? '',
        private: args.private ?? false,
        default_branch: 'main',
        created_at: stamp,
        updated_at: stamp,
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
      input.store.repositories.set(repoName, record);
      return rpcSuccess(null, toolResult(repositoryView(record, owner ?? '')));
    }

    if (typeof args.owner === 'string' && !checkOwner(input.store, owner)) {
      return rpcSuccess(null, failure('Unknown owner: ' + owner));
    }

    const repoName = String(args.repo ?? '');
    if (name === 'get_repo' && !checkOwner(input.store, owner)) {
      return rpcSuccess(null, failure('Unknown owner: ' + owner));
    }

    const repo = findRepository(input.store, repoName);
    if (name === 'get_repo') {
      return rpcSuccess(null, repo ? toolResult(repositoryView(repo, owner ?? '')) : failure('Not Found'));
    }

    if (!repo) {
      return rpcSuccess(null, failure('Not Found'));
    }

    if (name === 'create_issue') {
      const issue = createIssueRecord(input.store, repo, owner, String(args.title), String(args.body ?? ''), []);
      return rpcSuccess(null, toolResult(issueView(issue, owner ?? '', repoName)));
    }

    if (name === 'list_issues') {
      const state = args.state ?? 'open';
      const issues = (repo.issues ?? [])
        .filter((issue: any) => state === 'all' || (issue.state ?? 'open') === state)
        .map((issue: any) => issueView(issue, owner ?? '', repoName));
      return rpcSuccess(null, toolResult({ issues, count: issues.length }));
    }

    if (name === 'create_pull_request') {
      const pull = createPullRecord(
        input.store,
        repo,
        owner,
        String(args.title),
        String(args.body ?? ''),
        String(args.head),
        String(args.base),
      );
      return rpcSuccess(null, toolResult(pullView(pull, owner ?? '', repoName)));
    }

    if (name === 'merge_pull_request') {
      const pullNumber = Number(args.pull_number);
      const merged = mergePullRecord(input.store, repo, owner, pullNumber, 'squash');
      if (!merged.merged) {
        return rpcSuccess(null, failure(merged.message ?? 'Pull request is not mergeable'));
      }

      return rpcSuccess(null, toolResult({
        merged: true,
        sha: merged.sha,
        merge_commit_sha: merged.merge_commit_sha,
        number: pullNumber,
        state: 'closed',
      }));
    }

    return rpcError(null, -32601, 'Unknown method: ' + name);
  } catch (error: any) {
    return rpcSuccess(null, failure(error?.message ?? 'Request failed'));
  }
}

function handleOne(value: any, input: any): { response?: any; headers?: Record<string, string>; status?: number } {
  const validObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const hasId = validObject && Object.prototype.hasOwnProperty.call(value, 'id');
  const hasParams = validObject && Object.prototype.hasOwnProperty.call(value, 'params');
  const validParams = validObject
    && value.params !== null
    && typeof value.params === 'object';
  const validId = !hasId || typeof value.id === 'string' || typeof value.id === 'number';

  if (!validObject || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !hasParams || !validParams || !validId) {
    const id = hasId ? value.id : null;
    return { response: rpcError(id, -32600, 'Invalid Request') };
  }

  if (!hasId) {
    return { status: 202 };
  }

  const id = value.id;
  const params = value.params;

  if (value.method === 'server/discover') {
    return {
      response: rpcSuccess(id, {
        protocolVersion: REVISION,
        supportedVersions: [REVISION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      }),
    };
  }

  if (value.method === 'initialize') {
    return {
      response: rpcSuccess(id, {
        protocolVersion: validRevision(params.protocolVersion) ? params.protocolVersion : REVISION,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      }),
      headers: { 'Mcp-Session-Id': 'mcp-session-1' },
    };
  }

  if (value.method === 'notifications/initialized') {
    return { status: 202 };
  }

  if (value.method === 'tools/list') {
    return { response: rpcSuccess(id, { tools: toolDefinitions }) };
  }

  if (value.method === 'tools/call') {
    const result = callTool(params.name, params.arguments, input);
    return { response: { ...result, id } };
  }

  return { response: rpcError(id, -32601, 'Unknown method: ' + value.method) };
}

export function handleMcp(input: any) {
  let parsed: any;

  try {
    parsed = JSON.parse(input.body.toString('utf8'));
  } catch {
    return reply(400, rpcError(null, -32700, 'Parse error: invalid JSON'));
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return reply(200, rpcError(null, -32600, 'Invalid Request'));
    }

    const responses: any[] = [];
    const sessionHeaders: Record<string, string> = {};

    for (const item of parsed) {
      const result = handleOne(item, input);
      if (result.headers) {
        Object.assign(sessionHeaders, result.headers);
      }
      if (result.response) {
        responses.push(result.response);
      }
    }

    if (responses.length > 0) {
      return reply(200, responses, Object.keys(sessionHeaders).length > 0 ? sessionHeaders : undefined);
    }

    return reply(202, null);
  }

  const result = handleOne(parsed, input);
  if (result.status === 202) {
    return reply(202, null);
  }

  return reply(200, result.response ?? rpcError(null, -32600, 'Invalid Request'), result.headers);
}
