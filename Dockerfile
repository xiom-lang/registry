# XIOM Package Registry -- Docker image
# Build: docker build -t xiom-registry .
# Run:   docker run --name xiom-registry \
#          -p 127.0.0.1:3000:3000 \
#          -v xiom-registry-data:/app/data \
#          -v xiom-registry-packages:/app/packages \
#          -v "$PWD/tokens.json:/run/secrets/xiom-tokens.json:ro" \
#          -e TOKENS_FILE=/run/secrets/xiom-tokens.json \
#          xiom-registry
FROM node:20-alpine

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV PACKAGES_DIR=/app/packages
ENV UPLOAD_TMP_DIR=/app/data/tmp

WORKDIR /app

# Install dependencies first so the layer caches across source changes.
# `npm ci --omit=dev` matches package-lock.json exactly and skips devDeps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code.
COPY src ./src
COPY seed.js NOTICE LICENSE ./

# Writable volumes (data/index.json, packages/<name>/<version>/package.tar.gz,
# and the upload staging directory) must be owned by the unprivileged user.
RUN mkdir -p /app/data /app/packages && chown -R node:node /app

# Hardening: the service runs as the built-in unprivileged `node` user.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
