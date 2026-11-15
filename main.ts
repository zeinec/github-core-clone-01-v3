/**
 * Starts the forge server and coordinates its lifetime with the make.fun environment.
 * The environment selects the available port and signals when the run is complete.
 */
import { createServer } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;

if (!envUrl) {
  process.exit(1);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function postPort(url: string, port: number): Promise<void> {
  const base = url.endsWith('/') ? url : `${url}/`;
  let delay = 250;

  while (true) {
    try {
      const response = await fetch(new URL('register', base), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30000),
      });

      if (response.status === 200 || response.status === 409) {
        return;
      }

      if (response.status === 400 || response.status === 405) {
        throw new Error(`register rejected (${response.status})`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register rejected')) {
        throw error;
      }
    }

    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function pollDone(url: string): Promise<void> {
  const base = url.endsWith('/') ? url : `${url}/`;
  let delay = 250;

  while (true) {
    try {
      const response = await fetch(new URL('done', base), {
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const value: unknown = await response.json();

        if (
          typeof value === 'object'
          && value !== null
          && 'done' in value
          && value.done === true
        ) {
          return;
        }
      }
    } catch {
      // Retry network failures and invalid responses.
    }

    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function run(): Promise<void> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = (): void => {
      server.off('error', handleError);
      resolve();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(0, '0.0.0.0');
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a port');
  }

  process.stdout.write(`listening on ${address.port}\n`);
  await postPort(envUrl, address.port);
  await pollDone(envUrl);
  await closeServer(server);
  process.exit(0);
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unexpected error';
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
