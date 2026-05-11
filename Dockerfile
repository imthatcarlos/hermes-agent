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
    procps \
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

# Install Caddy — used as a basic-auth reverse proxy in front of the
# Hermes dashboard, which has no auth of its own. Hermes binds to
# 127.0.0.1; Caddy is the only thing exposed to Railway.
ARG CADDY_VERSION=2.8.4
RUN curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_$(dpkg --print-architecture).tar.gz" \
    | tar -xzC /usr/local/bin caddy && chmod +x /usr/local/bin/caddy

# Install Solana CLI
RUN sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" && \
    echo 'export PATH="/root/.local/share/solana/install/active_release/bin:$PATH"' >> /root/.bashrc

ENV PATH="/root/.local/share/solana/install/active_release/bin:$PATH"

WORKDIR /app

# Install uv (Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Install hermes agent to /opt (outside ~/.hermes volume mount).
# Two ways to reach the binary so `railway ssh` sessions always find it:
#   1. /usr/local/bin/hermes symlink — picked up by any shell whose PATH
#      includes /usr/local/bin (the default on Debian).
#   2. /etc/profile.d/hermes.sh — exports the venv bin dir to PATH for
#      login shells, in case the symlink ever breaks.
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes \
    && cd /opt/hermes \
    && uv venv .venv \
    && uv pip install --python .venv/bin/python -e ".[all]" \
    && ln -sf /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes \
    && echo 'export PATH="/opt/hermes/.venv/bin:$PATH"' > /etc/profile.d/hermes.sh \
    && chmod +x /etc/profile.d/hermes.sh

# Allow `hermes gateway run` as root. This container runs entirely as root
# (no separate `hermes` user), so the upstream safety check would otherwise
# block the gateway from starting. HERMES_HOME stays root-owned consistently.
ENV HERMES_ALLOW_ROOT_GATEWAY=1

WORKDIR /app

# Copy and setup entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create directories
RUN mkdir -p /root/.hermes /app/workspace
WORKDIR /app/workspace

# Gateway port
EXPOSE 18789

# Use entrypoint to start hermes gateway
ENTRYPOINT ["/app/entrypoint.sh"]
