// Optional on-disk cache for forya's GENERATED artifacts (posters in 0.5/M3,
// metadata in 0.5/M2). The WHOLE feature is gated on `config.dataDir`:
//
//   - `DATA_DIR` unset  → `config.dataDir === ''` → every function here is an
//     inert no-op that touches the filesystem ZERO times — even if a writable
//     `/data` volume happens to be mounted. Containment keys on the ENV VAR,
//     never on whether the dir exists. (tests/dataCache.test.ts proves this.)
//   - `DATA_DIR` set    → forya reads/writes its cache UNDER that dir only, never
//     the `:ro` VIDEO_DIR.
//
// The path derivation is pure (takes `dataDir` explicitly) so it's unit-testable
// in isolation, mirroring forya's resolveRange/pool/pickFit discipline.
// Writes are atomic (tmp + rename) and validated before publish, so a crash or a
// half/zero-byte artifact is never served. Nothing here ever throws — a cache
// miss/failure simply degrades to "regenerate next time".
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';

/** Cache subdirectories under `dataDir`. */
export type CacheKind = 'posters' | 'meta';

/** Feature on? Keys SOLELY on the (env-derived) config — never on fs state. */
export function cacheEnabled(dataDir: string = config.dataDir): boolean {
	return dataDir !== '';
}

/**
 * Resolve the on-disk path for a cached artifact, or `null` when the feature is
 * disabled (`dataDir === ''`). Pure. The filename is a hex encoding of the
 * source `name` (path-safe, can't contain separators) plus the source `mtimeMs`
 * (so a changed source self-invalidates, like the 0.3.2 scan cache) plus `ext`.
 * The result is asserted to stay under `dataDir/kind` (defence in depth).
 */
export function cachePath(
	dataDir: string,
	kind: CacheKind,
	name: string,
	mtimeMs: number,
	ext: string
): string | null {
	if (dataDir === '') return null;
	const safe = Buffer.from(name, 'utf8').toString('hex');
	const file = `${safe}.${Math.floor(mtimeMs)}.${ext}`;
	const dir = path.resolve(dataDir, kind);
	const full = path.join(dir, file);
	if (path.dirname(full) !== dir) return null; // never escape dataDir/kind
	return full;
}

let tmpSeq = 0;

/**
 * Read a cached artifact, or `null` (disabled / missing / empty / unreadable).
 * Never throws; makes ZERO fs calls when disabled.
 */
export async function readCache(
	kind: CacheKind,
	name: string,
	mtimeMs: number,
	ext: string,
	dataDir: string = config.dataDir
): Promise<Buffer | null> {
	const full = cachePath(dataDir, kind, name, mtimeMs, ext);
	if (!full) return null;
	try {
		const buf = await fsp.readFile(full);
		return buf.length > 0 ? buf : null; // 0-byte ⇒ treat as missing (corrupt)
	} catch {
		return null;
	}
}

/**
 * Atomically write an artifact (tmp + rename) under `dataDir`, after an optional
 * `validate`. No-op (ZERO fs calls) when disabled; never writes an empty buffer;
 * never throws. Writes ONLY under `dataDir`, never the `:ro` source.
 */
export async function writeCache(
	kind: CacheKind,
	name: string,
	mtimeMs: number,
	ext: string,
	bytes: Buffer,
	validate?: (b: Buffer) => boolean,
	dataDir: string = config.dataDir
): Promise<void> {
	const full = cachePath(dataDir, kind, name, mtimeMs, ext);
	if (!full) return; // disabled → touch nothing
	if (bytes.length === 0) return; // never publish an empty artifact
	if (validate && !validate(bytes)) return; // validate-before-serve gate
	const dir = path.dirname(full);
	const tmp = `${full}.tmp.${process.pid}.${tmpSeq++}`;
	try {
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(tmp, bytes);
		await fsp.rename(tmp, full); // atomic publish
	} catch {
		// Best-effort cache: clean up a stray tmp, then degrade to regenerate-later.
		try {
			await fsp.rm(tmp, { force: true });
		} catch {
			/* ignore */
		}
	}
}
