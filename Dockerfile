# XIOM Package Registry — Docker image
# Build: docker build -t xiom-registry .
# Run:   docker run -p 3000:3000 -v $(pwd)/data:/app/data -v $(pwd)/packages:/app/packages xiom-registry
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy application
COPY server.js ./

# Create data directories
RUN mkdir -p /app/data /app/packages /app/tmp

# Environment
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV PACKAGES_DIR=/app/packages

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/', r => { process.exit(r.statusCode === 200 ? 0 : 1) })"

CMD ["node", "server.js"]
