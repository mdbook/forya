# Contributing

Thanks for helping out. forya is a SvelteKit app (Svelte 5, TypeScript, Node adapter).

## Setup

You need Node 24 and npm.

```bash
git clone https://github.com/mdbook/forya
cd forya
npm ci
VIDEO_DIR=/path/to/some/videos npm run dev
```

The dev server prints its address (Vite's default is <http://localhost:5173>).

## Checks

Run these before you open a pull request. They are the same checks CI runs.

```bash
npm run check
npm run lint
npm run format:check
npm test
```

`npm run format` fixes formatting. `npm run build` creates `build/`, and `node build` runs it.

## Pull requests

- Keep changes small and focused, and add a test when you change behavior.
- HTTP Range handling in `/api/media/<name>` is the reason this app exists. If you touch media serving, run `tests/range.test.ts`.
- forya must never write to the video folder. It may only write under `DATA_DIR`.
- If you change a user-facing setting, update [docs/configuration.md](docs/configuration.md).
- Releases bump `version` in `package.json` and `VERSION` together, with a `CHANGELOG.md` entry.
