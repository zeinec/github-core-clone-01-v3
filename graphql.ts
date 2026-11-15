/*
 * Implements the GraphQL operation subset used by the forge compatibility layer.
 * Each named operation returns the response shape expected by its caller.
 */
import { allocateGlobalId, learnOrCheckOwner } from './store.ts';
import {
  addIssueComment,
  closeIssueRecord,
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
  pullFilesFor,
  pullIsMergeable,
} from './issues.ts';

const issueFields = ['id', 'number', 'title', 'state', 'body'];
const pullFields = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const repositoryFields = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
];

function operationName(query: unknown): string | null {
  if (typeof query !== 'string') {
    return null;
  }
  const withoutComments = query.replace(/#.*$/gm, ' ');
  const match = withoutComments.match(/\b(?:query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/);
  return match ? match[1] : null;
}

function globalId(kind: string, owner: string, repo: string, number: number): string {
  return allocateGlobalId(kind, owner, repo, number);
}

function decodeGlobalId(id: unknown): { kind: string; owner: string; repo: string; number: number } | null {
  if (typeof id !== 'string') {
    return null;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = decoded.match(/^([^:]+):([^/]+)\/([^:]+):(\d+)$/);
  if (!match) {
    return null;
  }
  const number = Number(match[4]);
  if (!Number.isSafeInteger(number)) {
    return null;
  }
  return { kind: match[1], owner: match[2], repo: match[3], number };
}

function repository(store: any, name: unknown, owner?: string): any | null {
  if (typeof name !== 'string') {
    return null;
  }
  const found = store.repositories.get(name);
  if (!found) {
    return null;
  }
  if (typeof owner === 'string' && !learnOrCheckOwner(store, owner)) {
    return null;
  }
  return found;
}

function findById(store: any, id: unknown, kind: string): { repo: any; decoded: { kind: string; owner: string; repo: string; number: number } } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== kind || !learnOrCheckOwner(store, decoded.owner)) {
    return null;
  }
  const repo = repository(store, decoded.repo, decoded.owner);
  return repo ? { repo, decoded } : null;
}

function issueState(issue: any): string {
  return String(issue.state).toUpperCase();
}

function pullState(pull: any): string {
  if (pull.merged === true) {
    return 'MERGED';
  }
  return String(pull.state).toLowerCase() === 'open' ? 'OPEN' : 'CLOSED';
}

function issueId(owner: string, repo: any, number: number): string {
  return globalId('Issue', owner, repo.name, number);
}

function pullId(owner: string, repo: any, number: number): string {
  return globalId('PullRequest', owner, repo.name, number);
}

function reply(data: any, errors?: any[]): any {
  return { status: 200, body: errors ? { data, errors } : { data } };
}

function issueFor(repo: any, number: number): any | null {
  return repo.issues.find((issue: any) => issue.number === number) ?? null;
}

function pullFor(repo: any, number: number): any | null {
  return repo.pull_requests.find((pull: any) => pull.number === number) ?? null;
}

function runOne(input: any, request: any): any {
  const name = operationName(request?.query);
  if (!name) {
    return { status: 400, body: { errors: [{ message: 'Missing or malformed GraphQL operation' }] } };
  }
  const vars = request.variables && typeof request.variables === 'object' ? request.variables : {};
  const store = input.store;
  const owner = String(vars.owner ?? input.owner ?? '');
  const repoName = vars.name ?? vars.repo ?? input.repo;
  const repo = () => repository(store, repoName, vars.owner === undefined ? undefined : owner);

  switch (name) {
    case 'ViewerLogin':
      return reply({ viewer: { login: store.owner || 'user' } });
    case 'RepositoryFields': {
      const found = repo();
      if (!found) {
        return reply({ repository: null });
      }
      return reply({ repository: {
        id: globalId('Repository', owner || store.owner, found.name, found.id),
        databaseId: found.id,
        name: found.name,
        owner: { login: owner || store.owner },
        defaultBranchRef: found.default_branch ? { name: found.default_branch } : null,
        viewerPermission: 'ADMIN',
        hasIssuesEnabled: true,
      } });
    }
    case 'Issue_fields':
      return reply({ Issue: { name: 'Issue', fields: issueFields.map((field) => ({ name: field })) } });
    case 'PullRequestAndRepositoryFields':
      return reply({
        PullRequest: { name: 'PullRequest', fields: pullFields.map((field) => ({ name: field })) },
        Repository: { name: 'Repository', fields: repositoryFields.map((field) => ({ name: field })) },
      });
    case 'SearchType_enumValues':
      return reply({ SearchType: { name: 'SearchType', enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'].map((value) => ({ name: value })) } });
    case 'OpenIssues': {
      const found = repo();
      if (!found) {
        return reply({ repository: null });
      }
      const nodes = [...found.issues]
        .filter((issue) => issueState(issue) === 'OPEN')
        .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.number - left.number)
        .slice(0, Math.max(0, Number(vars.first ?? 20)))
        .map((issue) => ({ number: issue.number, title: issue.title, state: issueState(issue), id: issueId(owner || store.owner, found, issue.number) }));
      return reply({ repository: { issues: { nodes } } });
    }
    case 'IssueByNumber': {
      const found = repo();
      if (!found) {
        return reply({ repository: null });
      }
      const issue = issueFor(found, Number(vars.number));
      return reply({ repository: { issue: issue ? {
        number: issue.number,
        title: issue.title,
        state: issueState(issue),
        id: issueId(owner || store.owner, found, issue.number),
        body: issue.body,
      } : null } });
    }
    case 'IssueCreate': {
      const inputData = vars.input ?? {};
      const target = findById(store, inputData.repositoryId, 'Repository');
      if (!target) {
        return reply({ createIssue: { issue: null } }, [{ message: 'Repository not found' }]);
      }
      try {
        const issue = createIssueRecord(store, target.repo, target.decoded.owner, String(inputData.title ?? ''), String(inputData.body ?? ''), []);
        return reply({ createIssue: { issue: { number: issue.number, id: issueId(target.decoded.owner, target.repo, issue.number) } } });
      } catch (error: any) {
        return reply({ createIssue: { issue: null } }, [{ message: error?.message ?? 'Unable to create issue' }]);
      }
    }
    case 'IssueClose': {
      const target = findById(store, vars.input?.issueId, 'Issue');
      const issue = target ? closeIssueRecord(store, target.repo, target.decoded.number) : null;
      if (issue && target) {
        return reply({ closeIssue: { issue: { number: issue.number, id: issueId(target.decoded.owner, target.repo, issue.number), state: 'CLOSED' } } });
      }
      return reply({ closeIssue: { issue: null } }, [{ message: 'Issue not found' }]);
    }
    case 'PullRequests': {
      const found = repo();
      if (!found) {
        return reply({ repository: null });
      }
      const nodes = [...found.pull_requests]
        .filter((pull) => pullState(pull) === 'OPEN')
        .sort((left, right) => left.number - right.number)
        .slice(0, Math.max(0, Number(vars.first ?? 20)))
        .map((pull) => ({ number: pull.number, headRefName: pull.head_branch, baseRefName: pull.base_branch, mergeable: pullIsMergeable(store, found, pull) ? 'MERGEABLE' : 'CONFLICTING', state: 'OPEN' }));
      return reply({ repository: { pullRequests: { nodes } } });
    }
    case 'PullRequestFiles': {
      const found = repo();
      if (!found) {
        return reply({ repository: null });
      }
      const pull = pullFor(found, Number(vars.number));
      const nodes = pull ? pullFilesFor(store, found, pull).slice(0, 10).map((file: any) => {
        const status = String(file.status ?? file.changeType ?? 'modified').toUpperCase();
        const changeType = status === 'ADDED' ? 'ADDED' : status === 'DELETED' ? 'DELETED' : 'MODIFIED';
        return { path: file.filename ?? file.path, additions: file.additions, deletions: file.deletions, changeType };
      }) : [];
      return reply({ repository: { pullRequest: pull ? { number: pull.number, files: { nodes } } : null } });
    }
    case 'PullRequestId': {
      const found = repo();
      if (!found) {
        return reply({ repository: null });
      }
      const pull = pullFor(found, Number(vars.number));
      return reply({ repository: { pullRequest: pull ? { id: pullId(owner || store.owner, found, pull.number), number: pull.number } : null } });
    }
    case 'PullRequestCreate': {
      const data = vars.input ?? {};
      const target = findById(store, data.repositoryId, 'Repository');
      if (!target) {
        return reply({ createPullRequest: { pullRequest: null } }, [{ message: 'Repository not found' }]);
      }
      try {
        const pull = createPullRecord(store, target.repo, target.decoded.owner, String(data.title ?? ''), '', String(data.headRefName ?? ''), String(data.baseRefName ?? ''));
        return reply({ createPullRequest: { pullRequest: { number: pull.number, id: pullId(target.decoded.owner, target.repo, pull.number), state: 'OPEN', headRefName: pull.head_branch, baseRefName: pull.base_branch } } });
      } catch (error: any) {
        return reply({ createPullRequest: { pullRequest: null } }, [{ message: error?.message ?? 'Unable to create pull request' }]);
      }
    }
    case 'MergePullRequest': {
      const target = findById(store, vars.input?.pullRequestId, 'PullRequest');
      if (!target) {
        return reply({ mergePullRequest: { pullRequest: null } }, [{ message: 'Pull request not found' }]);
      }
      const pull = pullFor(target.repo, target.decoded.number);
      if (!pull) {
        return reply({ mergePullRequest: { pullRequest: null } }, [{ message: 'Pull request not found' }]);
      }
      try {
        mergePullRecord(store, target.repo, target.decoded.owner, pull.number, 'squash');
        return reply({ mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } } });
      } catch (error: any) {
        return reply({ mergePullRequest: { pullRequest: null } }, [{ message: error?.message ?? 'Unable to merge pull request' }]);
      }
    }
    case 'AddComment': {
      const target = findById(store, vars.input?.subjectId, 'Issue');
      const comment = target ? addIssueComment(store, target.repo, target.decoded.number, String(vars.input?.body ?? '')) : null;
      if (comment && target) {
        return reply({ addComment: { commentEdge: { node: { id: globalId('IssueComment', target.decoded.owner, target.repo.name, comment.id), body: comment.body } } } });
      }
      return reply({ addComment: { commentEdge: null } }, [{ message: 'Issue not found' }]);
    }
    case 'ViewerInvalidField': {
      const query = String(request.query ?? '');
      const field = query.match(/\bviewer\s*\{\s*login\s+([_A-Za-z][_0-9A-Za-z]*)/)?.[1] ?? 'invalidField';
      return reply({ viewer: { login: store.owner || 'user' } }, [{ message: "Field '" + field + "' doesn't exist on type 'User'" }]);
    }
    case 'NodeRepository': {
      const decoded = decodeGlobalId(vars.id);
      if (!decoded || decoded.kind !== 'Repository' || !learnOrCheckOwner(store, decoded.owner)) {
        return reply({ node: null });
      }
      const found = repository(store, decoded.repo, decoded.owner);
      return reply({ node: found ? { id: vars.id, name: found.name, nameWithOwner: decoded.owner + '/' + found.name } : null });
    }
    case 'IssuesPage': {
      const found = repo();
      if (!found) {
        return reply({ repository: null });
      }
      const all = [...found.issues].sort((left, right) => left.number - right.number);
      let start = 0;
      if (vars.after !== null && vars.after !== undefined) {
        try {
          const cursor = Number(Buffer.from(String(vars.after), 'base64').toString('utf8'));
          const index = all.findIndex((issue) => issue.number > cursor);
          start = index < 0 ? all.length : index;
        } catch {
          start = 0;
        }
      }
      const count = Math.max(0, Number(vars.first ?? 20));
      const page = all.slice(start, start + count);
      return reply({ repository: { issues: {
        nodes: page.map((issue) => ({ number: issue.number })),
        pageInfo: {
          hasNextPage: start + page.length < all.length,
          endCursor: page.length ? Buffer.from(String(page[page.length - 1].number)).toString('base64') : null,
        },
      } } });
    }
    default:
      return { status: 400, body: { errors: [{ message: 'Unknown GraphQL operation ' + name }] } };
  }
}

export function handleGraphql(input: any): any {
  if (Array.isArray(input.json)) {
    return { status: 200, body: input.json.map((request: any) => runOne(input, request).body) };
  }
  return runOne(input, input.json);
}
