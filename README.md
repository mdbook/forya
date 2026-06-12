# forya

An iOS-first vertical video feed (TikTok-style) that serves both the UI and the
video bytes — with correct HTTP Range support — from one self-contained Docker
image. SvelteKit (adapter-node) + Svelte 5 + TypeScript.

> **Scaffold in progress.** This repository is being built milestone by
> milestone. The full public README — quickstart, env table, the `/srv/videos`
> contract, and the auth/multi-feed notes — lands with milestone 05. See
> `SPEC.md` in the project workspace for the architecture.

## Quick dev

```bash
npm install
npm run dev        # dev server
npm run build      # production build (adapter-node) → ./build
node build         # run the built server
```

`GET /api/healthz` → `ok`.

## License

MIT (added in milestone 05).
