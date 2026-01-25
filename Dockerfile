FROM node:24-slim

# Install dependencies for Solana CLI and general utilities
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install Solana CLI
RUN sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" && \
    echo 'export PATH="/root/.local/share/solana/install/active_release/bin:$PATH"' >> /root/.bashrc

ENV PATH="/root/.local/share/solana/install/active_release/bin:$PATH"

WORKDIR /app

# Install clawdbot globally (pin to working version)
RUN npm install -g clawdbot@2026.1.23-1

# Copy clawdbot config
COPY .clawdbot/ /root/.clawdbot/

# Set workspace directory
RUN mkdir -p /app/workspace
WORKDIR /app/workspace

# Gateway port
EXPOSE 18789

# Start gateway in foreground
CMD ["npx", "clawdbot", "gateway", "--port", "18789"]
