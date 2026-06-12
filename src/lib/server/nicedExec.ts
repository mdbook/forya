// Spawn a child at low CPU/IO priority so background ffmpeg/ffprobe never
// competes with serving (0.5/M4). `nice -n 19` is a busybox applet (always in
// alpine). `ionice -c3` (idle IO class) is BEST-EFFORT — if it isn't in the image
// we degrade to nice-only rather than hard-error (ionice is ~a no-op for our
// CIFS/network reads anyway, per infra). Availability is probed once and cached.
import { execFile, type ExecFileOptions } from 'node:child_process';

let ioniceProbe: Promise<boolean> | null = null;

/** Is `ionice` runnable here? Probed once, cached. Never throws. */
function hasIonice(): Promise<boolean> {
	if (!ioniceProbe) {
		ioniceProbe = new Promise<boolean>((resolve) => {
			execFile('ionice', ['-c3', 'true'], (err) => resolve(!err));
		});
	}
	return ioniceProbe;
}

/**
 * Run `bin args` at low priority, resolving its stdout. `nice` execs the target
 * (so the resulting process IS `bin` — a timeout/kill reaches ffmpeg directly).
 * Pass `encoding: 'buffer'` for binary stdout (poster frames).
 */
export async function nicedExecFile(
	bin: string,
	args: string[],
	options: ExecFileOptions & { encoding?: 'buffer' }
): Promise<Buffer | string> {
	const prefix = (await hasIonice()) ? ['-n', '19', 'ionice', '-c3', bin] : ['-n', '19', bin];
	return new Promise<Buffer | string>((resolve, reject) => {
		execFile('nice', [...prefix, ...args], options, (err, stdout) =>
			err ? reject(err) : resolve(stdout as Buffer | string)
		);
	});
}
