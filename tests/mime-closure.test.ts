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

/** Matches a scanner acceptance regex and captures its `\.(a|b|c)` extension alternation.
 *  The `\.` anchor is what selects the extension group rather than the id/index groups — NOT
 *  position. (`exec` returns the FIRST match; today every one of these regexes contains exactly
 *  one `\.(`, so first and last coincide. If one ever gained a second, the ALTERNATION-COUNT
 *  assertion below fails rather than this quietly picking the wrong group.) */
const EXT_ALTERNATION = /\\\.\(([a-z0-9|]+)\)/gi;

/** Pull the `(a|b|c)` extension alternation out of a named regex literal in the source. */
function extsFromRegex(constName: string): string[] {
	const line = SRC.split('\n').find((l) => l.includes(`const ${constName}`));
	if (!line) throw new Error(`${constName} not found in videos.ts — did it get renamed?`);
	const all = [...line.matchAll(EXT_ALTERNATION)];
	if (all.length === 0) throw new Error(`no extension alternation found in ${constName}: ${line}`);
	if (all.length > 1)
		throw new Error(
			`${constName} has ${all.length} \\.( ) groups — this parser assumes exactly one and would ` +
				`silently pick the first. Disambiguate the regex or teach the parser which group is the ext.`
		);
	return all[0][1].split('|').map((e) => `.${e.toLowerCase()}`);
}

/** DISCOVER every acceptance regex in videos.ts, rather than trusting the list below.
 *
 *  This closes the loop over the loop (review #2288). Parsing extensions out of the source stops
 *  THOSE from drifting — but the set of SOURCES was still hand-restated, which is the very shape
 *  rejected for `pickFit`'s defaulted arg: enumerated cases covered, an unenumerated SIXTH regex
 *  completely invisible. Proven, not supposed: adding a new `_RE` accepting unmapped extensions
 *  left the suite green, and deleting one from the list below silently dropped its coverage. The
 *  vacuous-green guard cannot catch either — it checks that each LISTED source yielded
 *  extensions, and has no way to see a source that was never listed. So: discover, then assert
 *  the discovered set EQUALS the enumerated one. A new acceptance regex now fails loudly, by name. */
function discoverExtRegexNames(): string[] {
	return SRC.split('\n')
		.map((l) => /^const ([A-Za-z0-9_]+)\s*=\s*\/(?=.*\\\.\([a-z0-9|]+\))/i.exec(l.trim())?.[1])
		.filter((n): n is string => !!n)
		.sort();
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
	// THE GUARD OVER THE LIST. Everything else here checks the sources we named; this checks that
	// we named all of them. A new acceptance regex in videos.ts fails HERE, by name, instead of
	// sailing through green with unmapped extensions — and a source deleted from the list above
	// fails too, so coverage cannot be quietly removed.
	it('the enumerated regex sources are ALL of them (a new/removed acceptance regex fails here)', () => {
		const enumerated = Object.keys(SCANNER_EXT_SOURCES)
			.filter((k) => k !== 'VIDEO_EXTENSIONS') // imported as a real value, not parsed
			.sort();
		expect(
			discoverExtRegexNames(),
			"videos.ts acceptance regexes and this test's list have diverged. If a regex was ADDED, " +
				'add it to SCANNER_EXT_SOURCES (and give its extensions a MIME_BY_EXT entry). If one was ' +
				'REMOVED, drop it here. Never "fix" this by deleting the assertion — it is the only thing ' +
				'stopping a new scanner route from serving unmapped media as octet-stream under nosniff.'
		).toEqual(enumerated);
	});

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
