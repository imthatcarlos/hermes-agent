FROM node:24-slim

# Install dependencies for Solana CLI, GitHub CLI, Python, Bun, and debugging
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    bash \
    jq \
    gpg \
    python3 \
    python3-pip \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Bun runtime
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Solana CLI
RUN sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" && \
    echo 'export PATH="/root/.local/share/solana/install/active_release/bin:$PATH"' >> /root/.bashrc

ENV PATH="/root/.local/share/solana/install/active_release/bin:$PATH"

WORKDIR /app

# Install openclaw globally (latest version, rebuilt on each deploy)
RUN npm install -g openclaw@latest

# Install pnpm for Mission Control
RUN npm install -g pnpm

# Clone and build Mission Control dashboard
RUN git clone --depth 1 https://github.com/builderz-labs/mission-control.git /app/mission-control
WORKDIR /app/mission-control
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
RUN pnpm build

WORKDIR /app

# Copy openclaw config to init location (volume mounted at runtime to /root/.openclaw)
COPY .clawdbot/ /app/openclaw-init/

# Copy and setup entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create directories
RUN mkdir -p /root/.openclaw /app/workspace
WORKDIR /app/workspace

# Gateway port + Mission Control port
EXPOSE 18789 3001

# Use entrypoint to handle volume initialization
ENTRYPOINT ["/app/entrypoint.sh"]
