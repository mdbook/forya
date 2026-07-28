// MIME closure — every extension the SCANNER accepts must have a MIME_BY_EXT entry.
//
// WHY THIS EXISTS (review #2273, deferred post-ship from the 0.15.0 chain). `mimeFromExt`
// falls back to `application/octet-stream`, and since 0.15.0 the serve path also emits
// `X-Content-Type-Options: nosniff`. Those two are individually correct and jointly sharp:
// before nosniff a browser could sniff an unmapped type and render it anyway, so a missing
// MIME entry was survivable. It no longer is. Add an extension to the scanner — a new video
// container, a new frame format — without adding it here and that media serves as
// octet-stream with sniffing forbidden, so it SILENTLY STOPS RENDERING. No error, no log,
// no failing test; the item just appears broken in the feed.
//
// The scanner's accepted set and the MIME table are in the same file but are NOT wired to
// each other, so nothing makes them agree. This test is that wiring.
//
// It reads the extensions OUT OF THE SOURCE rather than restating them. A hardcoded list
// here would itself go stale the moment someone edits a regex — which is the exact failure
// mode this whole file exists to prevent, and it would fail silently in the reassuring
// direction (green while the invariant broke). Parsing the source means the test cannot
// drift from the thing it pins: change the regex, and this test either sees the new
// extension or fails to parse and says so.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mimeFromExt, VIDEO_EXTENSIONS } from '../src/lib/server/videos';

const SRC = fs.readFileSync(path.join(process.cwd(), 'src/lib/server/videos.ts'), 'utf8');

/** Pull the `(a|b|c)` extension alternation out of a named regex literal in the source. */
function extsFromRegex(constName: string): string[] {
	const line = SRC.split('\n').find((l) => l.includes(`const ${constName}`));
	if (!line) throw new Error(`${constName} not found in videos.ts — did it get renamed?`);
	// The LAST parenthesised alternation on the line is the extension group in every one of
	// these regexes (`…\.(jpg|jpeg|png)$/i`). Anchoring on `\.` keeps it off the id/index groups.
	const m = /\\\.\(([a-z0-9|]+)\)/i.exec(line);
	if (!m) throw new Error(`no extension alternation found in ${constName}: ${line}`);
	return m[1].split('|').map((e) => `.${e.toLowerCase()}`);
}

// Every route by which a file can become a served FeedItem/MediaFrame.
const SCANNER_EXT_SOURCES = {
	VIDEO_EXTENSIONS: [...VIDEO_EXTENSIONS] as string[],
	FRAME_RE: extsFromRegex('FRAME_RE'),
	SINGLE_IMAGE_RE: extsFromRegex('SINGLE_IMAGE_RE'),
	NESTED_FRAME_RE: extsFromRegex('NESTED_FRAME_RE'),
	AUDIO_RE: extsFromRegex('AUDIO_RE')
};

describe('MIME closure — scanner-accepted extensions all have a content-type', () => {
	// Guards the guard: if the parse silently returned nothing, every closure assertion below
	// would vacuously pass and this file would be decorative.
	it('actually parsed extensions out of every source (not vacuously green)', () => {
		for (const [name, exts] of Object.entries(SCANNER_EXT_SOURCES)) {
			expect(exts.length, `${name} parsed no extensions`).toBeGreaterThan(0);
			for (const e of exts) expect(e, `${name} produced a malformed ext`).toMatch(/^\.[a-z0-9]+$/);
		}
	});

	for (const [name, exts] of Object.entries(SCANNER_EXT_SOURCES)) {
		it(`${name}: every accepted extension maps to a real content-type`, () => {
			for (const ext of exts) {
				const mime = mimeFromExt(`x${ext}`);
				expect(
					mime,
					`${ext} is accepted by ${name} but has NO MIME_BY_EXT entry — with nosniff set it ` +
						`would serve as octet-stream and silently fail to render. Add it to MIME_BY_EXT.`
				).not.toBe('application/octet-stream');
			}
		});
	}

	it('a genuinely unknown extension still falls back to octet-stream', () => {
		// The fallback itself is correct and must stay — the bug is only ever a scanner-accepted
		// extension reaching it. `safeMediaPath`/the scanner keep unknown files out of the feed.
		expect(mimeFromExt('x.sh')).toBe('application/octet-stream');
		expect(mimeFromExt('noextension')).toBe('application/octet-stream');
	});

	it('the parse is case-insensitive in the same way the scanner is', () => {
		// Every scanner regex carries /i and mimeFromExt lowercases, so an uppercase file on disk
		// must resolve identically — otherwise `.JPG` would serve as octet-stream under nosniff.
		expect(mimeFromExt('X.JPG')).toBe(mimeFromExt('x.jpg'));
		expect(mimeFromExt('X.MP4')).toBe(mimeFromExt('x.mp4'));
	});
});
