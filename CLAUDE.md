# CLAUDE.md

All agent guidance for this repository lives in [`AGENTS.md`](./AGENTS.md). Read
it before starting any work. It covers scope (owns the image + app; runtime
config lives in `/docker`, auth and the video files are out of scope), the
reading order (AGENTS → handoff → `videos.ts` → `Feed.svelte`), the
version-bump rule (`package.json` + `VERSION` together, CHANGELOG, main →
`:latest` / dev → `:dev`), commit/push policy, and the load-bearing constraints.

**30-second gotcha:** **HTTP Range support in the `/api/media/[name]` endpoint is
the whole reason this app exists** — iOS won't play or seek without correct
`206` + `Content-Range` + `Accept-Ranges`. Don't regress it. The byte math lives
in `src/lib/server/videos.ts` and is guarded by `tests/range.test.ts`; never
collapse a Range request into a full `200`.

If anything here diverges from `AGENTS.md`, `AGENTS.md` is the source of truth.
