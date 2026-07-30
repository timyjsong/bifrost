# Coverage, file by file

The headline is in the [README](../README.md#tests): `bun test --coverage` reports 89%,
and measured against the whole tree it is closer to 52%. This file is the distribution
behind those two numbers, kept out of the README because the detail is worth having and
not worth putting in front of someone deciding whether to keep reading.

## Why there are two numbers

Bun only instruments files a test actually imports. **37 source files totalling about
7,700 lines are imported by no test at all**, so they never enter the denominator. The
89% describes the instrumented subset; the 52% is that subset's covered lines measured
against every line of first-party source.

The single largest absence is `server/index.ts` — 1,437 lines holding every API handler,
loaded by nothing. Also entirely absent: the Web Push delivery path
(`alerts/manager.ts`, `push.ts`, `vapid.ts`), `drive/drafts.ts`, `drive/slash.ts`,
`auth/cli.ts`, and all 21 React modules.

## Where it is strong

Concentrated where the security and correctness decisions live:

| Module | Lines |
| --- | --- |
| `server/auth/guard.ts`, `server/auth/tokens.ts` | 100% |
| `server/derive.ts` | 100% |
| `server/files/confine.ts` | 96% |
| `server/collectors/projects.ts` | 96% |
| `server/spawn/{spawn,originate,resume,restart}.ts` | at or near 100% |
| pure web view-models (`selectors`, `cardModel`, `format`, `keymap`) | at or near 100% |

## Where it thins out

Worth naming rather than leaving you to find them:

| Module | Lines | Note |
| --- | --- | --- |
| `server/collectors/sessions.ts` | ~55% | the largest file any test loads, and the one behind the transcript-plus-`/proc` claim |
| `server/spawn/memgate.ts` | 75% | |
| `server/collectors/system.ts` | 34% | |
| `web/src/lib/drive.ts` | 33% | mostly network plumbing |
| `web/src/lib/push.ts` | 27% | |
| `web/src/lib/api.ts` | ~3% | |

**`server/index.ts` still has no tests that load it, and there are no component tests at
all** — the HTTP layer is verified by hand against a running instance, and presentation
by eye.

## What closed since the last revision

`server/collectors/projects.ts` went from no test file to 96%, tested against real
directories and real `git` rather than a mocked spawn.

`server/collectors/system.ts` roughly doubled. What was untested there was never the
shelling out but the parsing of what came back, so those parses were lifted out pure and
tested against the shapes that actually break naive parsers: a process whose `comm`
contains spaces and parentheses, IPv6 listeners that must not be split on the wrong
colon, counters that appear to run backwards across a suspend. The remainder of that file
is process invocation, which is integration territory and deliberately not faked.

The route table is extracted and tested. An earlier README said pulling it out of
`server/index.ts` — then 1,600 lines of inline path matching — was the next thing,
because it is what makes route tests writable. Matching is now a pure function over a
table (`server/routes/table.ts`), and the surface itself is data in `server/routes/api.ts`
that imports nothing from the server, so it can be asserted without booting one; handlers
are supplied as a `Record<RouteName, Handler>`, which turns "declared a route, forgot the
handler" from a 404 into a compile error. The same pass collapsed three near-identical
picker orchestrations into one and put the closed-loop TUI navigation under test —
including that a dropped keypress is recovered, which is the entire reason that loop is
closed rather than counted.

Two honest limits on that. The route *table* is tested and the route *handlers* are not:
they still live inline in `server/index.ts`, which no test imports, so what is covered is
the matching and the shape of the surface, not the bodies. And the surface-as-data is not
the whole surface: the table holds 30 route entries, while seven further paths — push and
alerts — remain a small if-chain in `alerts/manager.ts`, reached before the table and
invisible to the surface test.

## What is honestly next

Component tests. There are none, which is why the React hooks warnings in `web/` are
still warnings: the compiler-era rules flag real patterns there, but rewriting working
state logic with no safety net trades one risk for another. `web/eslint.config.js`
records which of those warnings were reviewed and fixed and which are deliberate.

The pattern overall is that the *decisions* are tested and the *plumbing* mostly isn't.
That is a defensible place to be while shipping, and an indefensible place to stay.
