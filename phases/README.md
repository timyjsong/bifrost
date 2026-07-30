# Design docs

Each build in Bifrost was specced before it was written, and the spec was the
contract: acceptance criteria agreed up front, then built against, then reviewed.
These are those specs, kept because the reasoning is the interesting part — what
was considered and rejected, where the risk was thought to be, and which
assumptions turned out to be wrong once the thing was live.

| Doc | Build | Status |
| --- | --- | --- |
| [00-auth.md](00-auth.md) | Auth / security | Built & converged |
| [01-drive-existing.md](01-drive-existing.md) | Drive existing sessions | Built & converged |
| [02-start-restart.md](02-start-restart.md) | Originate & recycle sessions | Built; review cycle open |

They were written as working documents, not as public writing, and they are
published close to as-written. The edits made before publishing were narrow:
references to files that stay private were removed, and a few paths and hostnames
were replaced with placeholders. Nothing was added with hindsight — where a spec
guessed wrong, the original wording stands and the correction sits beside it
(`00-auth.md` carries an as-built section for exactly this reason; `02` records
its pre-build spike evidence the same way).

One consequence worth flagging: these read like internal notes, because that is
what they are. The status line at the top of each is the honest state of that
build, including where a review cycle is still open.
