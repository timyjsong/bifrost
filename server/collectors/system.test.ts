/**
 * `collectors/system.ts` sat at ~18% covered, and the README's coverage
 * paragraph names it. What was untested was not the shelling out — it was the
 * PARSING of what came back, which is where the bugs live: /proc and `ss` emit
 * fields that a naive split gets wrong, and the tmux 3.6 outage was exactly that
 * failure in the sibling parser. So the pure parses were lifted out (same move
 * as parseTmuxSessions/parseTmuxPanes) and are exercised here against the
 * hostile shapes, not just the tidy ones.
 */
import { describe, expect, test } from "bun:test";
import {
  cpuPctBetween,
  parseCpuSample,
  parseJiffies,
  parsePorts,
  parseTmuxPanes,
  parseTmuxSessions,
} from "./system";

describe("parseJiffies — /proc/<pid>/stat", () => {
  // Fields after comm, 1-indexed from state: state(3) ppid(4) pgrp(5) session(6)
  // tty(7) tpgid(8) flags(9) minflt(10) cminflt(11) majflt(12) cmajflt(13)
  // utime(14) stime(15) -> indexes 11 and 12 of the post-comm split.
  const line = (comm: string, utime = 100, stime = 50) =>
    `1234 (${comm}) S 1 1 1 0 -1 4194304 900 0 2 0 ${utime} ${stime} 0 0 20 0 1 0 999`;

  test("sums utime and stime", () => {
    expect(parseJiffies(line("bun"))).toBe(150);
  });

  // A process can name itself anything. Splitting the line on spaces, or finding
  // the FIRST closing paren, lands on the wrong fields and yields nonsense CPU.
  test("survives a comm containing spaces and parentheses", () => {
    expect(parseJiffies(line("my (weird) proc"))).toBe(150);
    expect(parseJiffies(line("a) b) c"))).toBe(150);
  });

  test("different values sum correctly", () => {
    expect(parseJiffies(line("bun", 7, 3))).toBe(10);
    expect(parseJiffies(line("bun", 0, 0))).toBe(0);
  });

  test("garbage yields undefined rather than NaN", () => {
    expect(parseJiffies("")).toBeUndefined();
    expect(parseJiffies("no parens here")).toBeUndefined();
    expect(parseJiffies("1 (x) S 1 2 3")).toBeUndefined(); // too few fields
  });
});

describe("parsePorts — `ss -tlnpH`", () => {
  const row = (local: string, proc = "bun", pid = 42) =>
    `LISTEN 0      511          ${local}         0.0.0.0:*    users:(("${proc}",pid=${pid},fd=20))`;

  test("reads the address, port and owning process", () => {
    const [p] = parsePorts(row("127.0.0.1:4444"));
    expect(p).toEqual({ addr: "127.0.0.1", port: 4444, process: "bun" });
  });

  // The address is split on the LAST colon precisely so IPv6 survives.
  test("an IPv6 listener keeps its address intact", () => {
    const [p] = parsePorts(row("[::]:8080"));
    expect(p.addr).toBe("[::]");
    expect(p.port).toBe(8080);

    const [q] = parsePorts(row("[fe80::1%eth0]:443"));
    expect(q.addr).toBe("[fe80::1%eth0]");
    expect(q.port).toBe(443);
  });

  test("a listener with no owning process still reports the port", () => {
    const [p] = parsePorts("LISTEN 0 128 0.0.0.0:22 0.0.0.0:*");
    expect(p).toEqual({ addr: "0.0.0.0", port: 22, process: undefined });
  });

  // ss lists one row per socket; two rows for the same addr:port would render
  // as a duplicate entry in the dashboard.
  test("duplicate addr:port rows collapse to one", () => {
    const out = parsePorts([row("0.0.0.0:80"), row("0.0.0.0:80", "nginx", 9)].join("\n"));
    expect(out).toHaveLength(1);
    expect(out[0].process).toBe("bun"); // first wins
  });

  test("rows come back in port order regardless of input order", () => {
    const out = parsePorts(
      [row("0.0.0.0:8080"), row("0.0.0.0:22"), row("0.0.0.0:443")].join("\n"),
    );
    expect(out.map((p) => p.port)).toEqual([22, 443, 8080]);
  });

  test("blank, short and malformed lines are skipped, not crashed on", () => {
    expect(parsePorts("")).toEqual([]);
    expect(parsePorts("\n\n")).toEqual([]);
    expect(parsePorts("LISTEN 0 128")).toEqual([]); // too few columns
    expect(parsePorts("LISTEN 0 128 no-colon-here 0.0.0.0:*")).toEqual([]);
    expect(parsePorts(row("0.0.0.0:notaport"))).toEqual([]);
  });
});

describe("CPU utilisation from /proc/stat", () => {
  const stat = (...f: number[]) => `cpu  ${f.join(" ")}\ncpu0 1 2 3 4\n`;

  test("busy excludes idle and iowait", () => {
    // user nice system idle iowait irq softirq
    const s = parseCpuSample(stat(100, 0, 50, 800, 50, 0, 0));
    expect(s.total).toBe(1000);
    expect(s.busy).toBe(150); // 1000 - (800 idle + 50 iowait)
  });

  test("the first sample has nothing to compare against", () => {
    expect(cpuPctBetween(null, { busy: 10, total: 100 })).toBeUndefined();
  });

  test("utilisation is the ratio of the busy delta to the total delta", () => {
    const prev = { busy: 100, total: 1000 };
    expect(cpuPctBetween(prev, { busy: 150, total: 1100 })).toBe(50);
    expect(cpuPctBetween(prev, { busy: 100, total: 1100 })).toBe(0);
    expect(cpuPctBetween(prev, { busy: 200, total: 1100 })).toBe(100);
  });

  test("a tick where the counters did not advance reports nothing", () => {
    const prev = { busy: 100, total: 1000 };
    expect(cpuPctBetween(prev, { busy: 100, total: 1000 })).toBeUndefined();
  });

  // Counters can appear to move backwards across a suspend or a CPU hotplug;
  // a negative or >100 reading would render as a broken gauge.
  test("out-of-range readings clamp to 0..100 instead of rendering broken", () => {
    expect(cpuPctBetween({ busy: 500, total: 1000 }, { busy: 100, total: 1100 })).toBe(0);
    expect(cpuPctBetween({ busy: 0, total: 1000 }, { busy: 500, total: 1100 })).toBe(100);
  });

  test("a backwards total is treated as no reading, not a negative one", () => {
    expect(cpuPctBetween({ busy: 100, total: 2000 }, { busy: 150, total: 1000 })).toBeUndefined();
  });
});

// The tmux 3.6 outage: `-F` output arrived with control characters replaced by
// `_`, so a tab-separated format became one unsplittable field, every lookup
// returned nothing, and the dashboard silently decided the box had no tmux.
describe("tmux parsers still refuse the shape that caused the 3.6 outage", () => {
  test("a colon-separated session row parses", () => {
    const out = parseTmuxSessions("atlas-web:1:1700000000\nledger-api:2:1700000001\n");
    expect(out.map((s) => s.name)).toEqual(["atlas-web", "ledger-api"]);
  });

  test("a tab-mangled row yields nothing rather than a bogus row", () => {
    // What 3.6 actually returned: the tab became `_`.
    expect(parseTmuxSessions("atlas-web_1_1700000000\n")).toEqual([]);
  });

  // Format is `#{pane_tty}:#{session_name}:#{session_attached}`.
  test("pane rows map tty to session, and count attached clients", () => {
    const out = parseTmuxPanes("/dev/pts/3:atlas-web:0\n/dev/pts/4:ledger-api:1\n");
    expect(out[0]).toEqual({ tty: "/dev/pts/3", session: "atlas-web", attached: false });
    expect(out[1]).toEqual({ tty: "/dev/pts/4", session: "ledger-api", attached: true });
  });

  test("a tab-mangled pane row is dropped rather than half-parsed", () => {
    expect(parseTmuxPanes("/dev/pts/3_atlas-web_0\n")).toEqual([]);
  });
});
