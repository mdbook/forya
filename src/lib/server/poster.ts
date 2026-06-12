// ffmpeg poster (thumbnail) generation (0.5/M3). Same shape as probe.ts: an
// injectable `PosterRunner` (mocked in tests → CI needs no ffmpeg), GENERATION is
// the M4 worker's job (OFF any request path), and the request path only READS the
// cache. Posters are cached as JPEG under DATA_DIR/posters keyed name+mtime;
// nothing here spawns/writes when the DATA_DIR feature is off.
import { execFile } from 'node:child_process';
import { config } from './config';
import { cacheEnabled, readCache, writeCache } from './dataCache';

/** Runs ffmpeg to extract one JPEG frame from `filePath`, resolving its bytes. */
export type PosterRunner = (filePath: string) => Promise<Buffer>;

const POSTER_TIMEOUT_MS = 30_000;
const POSTER_SECONDS = 0.5; // grab a frame ~0.5s in to skip black intros

/** Default runner: ffmpeg → one mjpeg frame to stdout. Worker-only — never a
 *  request hot path. */
export const ffmpegPosterRunner: PosterRunner = (filePath) =>
	new Promise((resolve, reject) => {
		execFile(
			'ffmpeg',
			[
				'-ss',
				String(POSTER_SECONDS),
				'-i',
				filePath,
				'-frames:v',
				'1',
				'-f',
				'image2',
				'-c:v',
				'mjpeg',
				'-'
			],
			{ timeout: POSTER_TIMEOUT_MS, maxBuffer: 8 << 20, encoding: 'buffer' },
			(err, stdout) => (err ? reject(err) : resolve(stdout as Buffer))
		);
	});

/** Pure: a plausible COMPLETE JPEG? (SOI `FFD8` … EOI `FFD9`.) Used to never
 *  cache/serve a truncated or non-image payload. */
export function isJpeg(b: Buffer): boolean {
	return (
		b.length > 3 &&
		b[0] === 0xff &&
		b[1] === 0xd8 &&
		b[b.length - 2] === 0xff &&
		b[b.length - 1] === 0xd9
	);
}

/** Read a cached poster, or null (disabled / missing / not-a-valid-JPEG).
 *  Cache-READ-only — never spawns ffmpeg. */
export async function readPoster(
	name: string,
	mtimeMs: number,
	dataDir: string = config.dataDir
): Promise<Buffer | null> {
	const buf = await readCache('posters', name, mtimeMs, 'jpg', dataDir);
	return buf && isJpeg(buf) ? buf : null;
}

/** Generate + cache a poster (spawns ffmpeg via `runner`). The M4 worker calls
 *  this OFF any request path. Returns true on success. No-op/false when disabled
 *  or when ffmpeg fails/yields a non-JPEG. */
export async function generatePoster(
	name: string,
	mtimeMs: number,
	filePath: string,
	runner: PosterRunner = ffmpegPosterRunner,
	dataDir: string = config.dataDir
): Promise<boolean> {
	if (!cacheEnabled(dataDir)) return false;
	let bytes: Buffer;
	try {
		bytes = await runner(filePath); // the only throwing step (spawn/timeout)
	} catch {
		return false;
	}
	if (!isJpeg(bytes)) return false; // validate BEFORE publishing
	await writeCache('posters', name, mtimeMs, 'jpg', bytes, isJpeg, dataDir);
	return true;
}
