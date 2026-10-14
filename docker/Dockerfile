# Runtime image. CI builds the server bundles (`vp pack`) and the web app
# (`vp build`) first; this only copies them, so the image needs no
# node_modules and no compiler.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    PORT=3000 \
    MIGRATIONS_DIR=/app/drizzle \
    BLOB_DIR=/data/blobs \
    WEB_DIST=/app/web

COPY apps/server/dist/ ./
COPY apps/web/dist/ ./web/
COPY packages/server/drizzle/ ./drizzle/
# Encrypted attachments. Mount a volume here and back it up with the
# database, as docs/operations.md describes.
RUN mkdir -p /data/blobs && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 3000
# Alpine has no curl or wget by default; Node's fetch is enough.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# The server applies pending migrations itself, under the lock it holds while
# it runs, so a restore can't come between them (see docs/operations.md).
CMD ["node", "server.mjs"]
