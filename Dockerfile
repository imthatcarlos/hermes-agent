FROM node:24-slim

# Install dependencies for Solana CLI and debugging
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    bash \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Solana CLI
RUN sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" && \
    echo 'export PATH="/root/.local/share/solana/install/active_release/bin:$PATH"' >> /root/.bashrc

ENV PATH="/root/.local/share/solana/install/active_release/bin:$PATH"

WORKDIR /app

# Install clawdbot globally (latest version, rebuilt on each deploy)
RUN npm install -g clawdbot@latest

# Copy clawdbot config to init location (volume mounted at runtime to /root/.clawdbot)
COPY .clawdbot/ /app/clawdbot-init/

# Copy and setup entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create directories
RUN mkdir -p /root/.clawdbot /app/workspace
WORKDIR /app/workspace

# Gateway port
EXPOSE 18789

# Use entrypoint to handle volume initialization
ENTRYPOINT ["/app/entrypoint.sh"]
