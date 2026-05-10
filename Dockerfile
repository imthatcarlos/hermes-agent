FROM nousresearch/hermes-agent:latest

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g @sherwoodagent/cli

COPY skills/hedge-fund /opt/skills/hedge-fund

# Install the research script's deps (@x402/fetch + @x402/evm + viem) once at
# build time. --omit=dev skips devDeps; --no-audit / --no-fund cut noise.
RUN cd /opt/skills/hedge-fund/scripts \
    && npm install --omit=dev --no-audit --no-fund

COPY entrypoint.sh /usr/local/bin/zhf-entrypoint.sh
RUN chmod +x /usr/local/bin/zhf-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/zhf-entrypoint.sh"]
CMD ["gateway", "run"]
