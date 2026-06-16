/**
 * SSE client registry + broadcast + the revocation sweep. Pulled out of index.ts
 * so the sweep — the security-relevant bit — is unit-testable without standing up
 * the server. Each client is tagged with the device token it connected under; the
 * heartbeat re-verifies that token and drops the client if it's been revoked,
 * which bounds revocation latency on a LIVE stream to one heartbeat (the gate only
 * covers new requests; an already-open stream was authed at connect time).
 */
export interface SSEClient {
  write: (chunk: string) => void;
  close: () => void;
  token: string | null;
}

const clients = new Set<SSEClient>();

export function addClient(c: SSEClient): void {
  clients.add(c);
}
export function removeClient(c: SSEClient): void {
  clients.delete(c);
}
export function clientCount(): number {
  return clients.size;
}

/** Push a pre-formatted SSE frame to every connected client. */
export function broadcast(frame: string): void {
  if (clients.size === 0) return;
  for (const c of clients) {
    try {
      c.write(frame);
    } catch {
      clients.delete(c);
    }
  }
}

/**
 * Heartbeat + revocation sweep: ping each live client so proxies don't reap the
 * connection, and drop any whose token no longer verifies (revoked since connect).
 * `verify` is injected so the sweep is testable against the real token store.
 */
export async function sweep(
  verify: (token: string | null) => Promise<boolean>,
): Promise<void> {
  for (const c of clients) {
    if (!(await verify(c.token))) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
      clients.delete(c);
      continue;
    }
    try {
      c.write(`: ping\n\n`);
    } catch {
      clients.delete(c);
    }
  }
}

/** Test-only: drop all registered clients. */
export function _reset(): void {
  clients.clear();
}
