# Debian, not Alpine: the tool plugins' CLIs are glibc binaries.
FROM oven/bun:1

# ca-certificates: the CLIs verify TLS against the OS trust store.
# git: the wiki vault is a git repository Mercury initializes at startup.
RUN apt-get update && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd -r mercury && useradd -r -g mercury mercury

WORKDIR /app

# Each tool plugin downloads its pinned CLI in its postinstall (allowed by
# package.json's trustedDependencies); the binaries go on PATH. .packs/ holds
# local tarballs when the app installs them (mfw local-packages), and is
# skipped when it isn't there.
COPY --chown=mercury:mercury package.json bun.lock* ./
COPY --chown=mercury:mercury .pack[s] ./.packs/
RUN bun install --production && chown -R mercury:mercury node_modules
RUN find /app/node_modules -path '*/@mercury-fw/*/bin/*' -type f -exec ln -sf {} /usr/local/bin/ \;

COPY --chown=mercury:mercury mercury.config.ts ./
COPY --chown=mercury:mercury locales ./locales
COPY --chown=mercury:mercury src ./src

# Mount points of the named volumes, owned by the runtime user before a fresh
# volume attaches (a new volume takes the ownership it finds here).
RUN mkdir -p /app/wiki-vault /home/mercury/.config \
  && chown mercury:mercury /app/wiki-vault \
  && chown -R mercury:mercury /home/mercury

USER mercury

CMD ["bun", "src/index.ts"]
