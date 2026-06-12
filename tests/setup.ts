// Runs before test modules import (vitest setupFiles), so src/lib/server/config.ts
// captures these when it reads $env/dynamic/private at module-eval time.
import path from 'node:path';

process.env.VIDEO_DIR = path.join(process.cwd(), 'tests', '.tmp-videos');
process.env.FEED_NAME = 'testfeed';
process.env.IGNORE_HIDDEN = 'true';
