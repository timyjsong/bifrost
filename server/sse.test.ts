import { test, expect, beforeEach } from "bun:test";
import { addClient, removeClient, clientCount, sweep, _reset, type SSEClient } from "./sse";

function fakeClient(token: string | null) {
  return {
    token,
    closed: false,
    pinged: false,
    write(chunk: string) {
      if (chunk.startsWith(":")) this.pinged = true;
    },
    close() {
      this.closed = true;
    },
  };
}

beforeEach(() => _reset());

test("sweep drops a client whose token no longer verifies, keeps valid ones", async () => {
  const good = fakeClient("good");
  const revoked = fakeClient("revoked");
  addClient(good);
  addClient(revoked);
  await sweep(async (t) => t === "good");
  expect(revoked.closed).toBe(true);
  expect(good.closed).toBe(false);
  expect(good.pinged).toBe(true); // surviving clients still get the heartbeat
  expect(clientCount()).toBe(1);
});

test("sweep removes a client that throws on write", async () => {
  const broken = {
    token: "good",
    close() {},
    write() {
      throw new Error("connection gone");
    },
  } as SSEClient;
  addClient(broken);
  await sweep(async () => true);
  expect(clientCount()).toBe(0);
});

test("addClient / removeClient / clientCount", () => {
  const c = fakeClient("x");
  addClient(c);
  expect(clientCount()).toBe(1);
  removeClient(c);
  expect(clientCount()).toBe(0);
});
