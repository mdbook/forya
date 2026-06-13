FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app
# Build provenance (0.5.4): CI passes the commit SHA via `--build-arg BUILD_SHA`;
# baked as a runtime ENV so config.ts can surface it in the DEBUG_PLAYBACK overlay
# (`build=<sha8>`). Empty for a plain local build. Diagnostic only — never affects
# behaviour; the overlay that reads it is itself dark by default.
ARG BUILD_SHA=""
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 VIDEO_DIR=/srv/videos FEED_NAME=feed BUILD_SHA=$BUILD_SHA
# ffmpeg/ffprobe for the optional poster + metadata subsystem (0.5). Only ever
# spawned when DATA_DIR is set; without it the feature is fully dark (the binary
# is then just dead weight — acceptable for one image across all configs). ffmpeg
# floats within the alpine branch — do NOT apk-pin it (alpine keeps only the
# latest build per branch, so a pin breaks when the repo rolls); the digest-pinned
# base above is what gives reproducibility. Resolved at build: ffmpeg 8.0.1.
RUN apk add --no-cache ffmpeg && mkdir -p /data && chown node:node /data
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# /srv/videos = the read-only source. /data = forya's OPTIONAL writable cache for
# generated posters/metadata (DATA_DIR, 0.5) — a fresh named volume inherits
# /data's `node` ownership; a bind mount is the operator's to chown 1000:1000.
# DATA_DIR is intentionally NOT set here: the feature is OFF by default, so the
# stock `docker run -v lib:/srv/videos:ro` behaves exactly as before.
VOLUME ["/srv/videos", "/data"]
EXPOSE 3000
USER node
CMD ["node", "build"]
