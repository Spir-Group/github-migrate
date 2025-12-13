# Production image for github-migrate
# Build context is dist/ - TS already compiled, package.json and ui/ copied here
# NOTE: Using slim (Debian) instead of alpine because gh-gei binary requires glibc
FROM --platform=linux/amd64 node:22-slim

# Install gh CLI and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    libicu72 \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/cli/cli/releases/download/v2.40.1/gh_2.40.1_linux_amd64.tar.gz | tar xz \
    && mv gh_2.40.1_linux_amd64/bin/gh /usr/local/bin/ \
    && rm -rf gh_2.40.1_linux_amd64 \
    && chmod +x /usr/local/bin/gh

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled application (already in dist/ context)
COPY *.js ./dist/
COPY workers ./dist/workers/

# Copy UI files (static assets)
COPY ui ./src/ui

# Set HOME for gh CLI extensions
ENV HOME=/app
ENV GH_CONFIG_DIR=/app/.config/gh

# Download and install gh-gei extension (pre-built binary from releases)
# gh looks for extensions in $HOME/.local/share/gh/extensions/
RUN mkdir -p /app/.local/share/gh/extensions/gh-gei /app/.config/gh \
    && GEI_VERSION="v1.20.0" \
    && curl -fsSL "https://github.com/github/gh-gei/releases/download/${GEI_VERSION}/gei-linux-amd64" -o /app/.local/share/gh/extensions/gh-gei/gh-gei \
    && chmod +x /app/.local/share/gh/extensions/gh-gei/gh-gei \
    && echo "owner: github" > /app/.local/share/gh/extensions/gh-gei/manifest.yml \
    && echo "name: gh-gei" >> /app/.local/share/gh/extensions/gh-gei/manifest.yml \
    && echo "host: github.com" >> /app/.local/share/gh/extensions/gh-gei/manifest.yml \
    && echo "tag: ${GEI_VERSION}" >> /app/.local/share/gh/extensions/gh-gei/manifest.yml \
    && echo "ispinned: true" >> /app/.local/share/gh/extensions/gh-gei/manifest.yml \
    && echo "path: /app/.local/share/gh/extensions/gh-gei/gh-gei" >> /app/.local/share/gh/extensions/gh-gei/manifest.yml

# Create non-root user and set permissions
RUN groupadd -g 1001 nodejs \
    && useradd -u 1001 -g nodejs -s /bin/bash nodejs \
    && chown -R nodejs:nodejs /app

USER nodejs

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "dist/server.js"]
