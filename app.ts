import { createServer as createHttpServer } from 'node:http';
import { createStore, nextRequestId, learnOrCheckOwner } from './store.ts';
import { isAuthenticated } from './auth.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { handleUserRepos, handleRepoRoutes } from './rest.ts';
import { handleIssueRoutes } from './issues.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** Connects the forge's HTTP routes to the shared in-memory store. */
function readRequestBody(request: AsyncIterable<Buffer | string>): Promise<Buffer> {
  return (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  })();
}

function buildHeaders(rawHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value === undefined) {
      continue;
    }
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function buildQuery(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    query[name] = value;
  }
  return query;
}

function isGitRoute(segments: string[]): boolean {
  const isInfoRefs = segments.length === 4
    && segments[1].endsWith('.git')
    && segments[2] === 'info'
    && segments[3] === 'refs';
  const isGitService = segments.length === 3
    && segments[1].endsWith('.git')
    && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack');
  return isInfoRefs || isGitService;
}

function errorReply(status: number, message: string): { status: number; body: { message: string } } {
  return { status, body: { message } };
}

export function createApp() {
  const store = createStore();
  return createHttpServer(async (request, response) => {
    const requestId = nextRequestId();
    try {
      const body = await readRequestBody(request);
      const host = request.headers.host || '127.0.0.1';
      const url = new URL(request.url || '/', 'http://' + host);
      const path = url.pathname;
      const method = request.method || 'GET';
      const headers = buildHeaders(request.headers);
      const query = buildQuery(url);
      const segments = path.split('/').filter(Boolean);
      const isGit = isGitRoute(segments);
      const isRepoApi = segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos';
      const owner = isRepoApi ? (segments[3] || '') : isGit ? (segments[0] || '') : '';
      const repo = isGit
        ? segments[1].slice(0, -'.git'.length)
        : isRepoApi ? (segments[4] || '') : '';
      const input = {
        store,
        owner,
        repo,
        method,
        path,
        segments,
        query,
        headers,
        body,
        json: undefined as unknown,
        baseUrl: 'http://' + host,
      };
      function send(reply: { status: number; headers?: Record<string, string>; body?: unknown }): void {
        const responseHeaders: Record<string, string> = {
          ...(reply.headers || {}),
          'X-GitHub-Request-Id': String(requestId),
        };
        let payload: Buffer;
        if (Buffer.isBuffer(reply.body)) {
          payload = reply.body;
        } else if (reply.body === null || reply.body === undefined) {
          payload = Buffer.alloc(0);
        } else {
          payload = Buffer.from(JSON.stringify(reply.body) + '\n');
          if (!Object.keys(responseHeaders).some((name) => name.toLowerCase() === 'content-type')) {
            responseHeaders['Content-Type'] = 'application/json; charset=utf-8';
          }
        }
        responseHeaders['Content-Length'] = String(payload.length);
        response.writeHead(reply.status, responseHeaders);
        response.end(payload);
      }

      if (method === 'GET' && path === '/healthz') {
        send({ status: 200, body: { ok: true } });
        return;
      }

      if (isGit) {
        if (!learnOrCheckOwner(store, segments[0])) {
          send(errorReply(404, 'Not Found'));
          return;
        }
        const gitInput = {
          store,
          owner: segments[0],
          repo: segments[1].slice(0, -'.git'.length),
          body,
          query,
          headers,
        };
        const reply = segments[2] === 'git-upload-pack'
          ? handleUploadPack(gitInput)
          : segments[2] === 'git-receive-pack'
            ? handleReceivePack(gitInput)
            : handleInfoRefs(gitInput);
        send(reply);
        return;
      }

      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        send({
          status: 200,
          headers: { 'X-OAuth-Scopes': 'repo, read:org' },
          body: {
            current_user_url: input.baseUrl + '/api/v3/user',
            rate_limit_url: input.baseUrl + '/api/v3/rate_limit',
          },
        });
        return;
      }

      if (method === 'GET' && path === '/api/v3/meta') {
        send({ status: 200, body: { installed_version: '1.0.0' } });
        return;
      }

      if ((path === '/api/graphql' || path === '/mcp') && method === 'POST') {
        if (!isAuthenticated(headers)) {
          send(errorReply(401, 'Requires authentication'));
          return;
        }
        if (path === '/api/graphql' && body.length > 0) {
          try {
            input.json = JSON.parse(body.toString('utf8'));
          } catch {
            send(errorReply(400, 'Invalid JSON'));
            return;
          }
        }
        const reply = path === '/mcp' ? await handleMcp(input) : await handleGraphql(input);
        send(reply || errorReply(404, 'Not Found'));
        return;
      }

      if (path.startsWith('/api/v3/')) {
        if (!isAuthenticated(headers)) {
          send(errorReply(401, 'Requires authentication'));
          return;
        }
        if (isRepoApi && owner !== '' && !learnOrCheckOwner(store, owner)) {
          send(errorReply(404, 'Not Found'));
          return;
        }
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && body.length > 0) {
          try {
            input.json = JSON.parse(body.toString('utf8'));
          } catch {
            send(errorReply(400, 'Invalid JSON'));
            return;
          }
        }
        if (method === 'GET' && path === '/api/v3/user') {
          send({ status: 200, body: { login: store.owner || 'user', id: 1, type: 'User' } });
          return;
        }
        const handlers = path === '/api/v3/user/repos'
          ? [handleUserRepos]
          : path.startsWith('/api/v3/repos/')
            ? [handleRepoRoutes, handleIssueRoutes]
            : [];
        for (const handler of handlers) {
          const reply = await handler(input);
          if (reply !== null) {
            send(reply);
            return;
          }
        }
        send(errorReply(404, 'Not Found'));
        return;
      }

      send(errorReply(404, 'Not Found'));
    } catch {
      const payload = Buffer.from(JSON.stringify({ message: 'Internal Server Error' }) + '\n');
      response.writeHead(500, {
        'X-GitHub-Request-Id': String(requestId),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(payload.length),
      });
      response.end(payload);
    }
  });
}

export { createApp as createServer };
