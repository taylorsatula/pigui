# picloud in a container: the server, the tools its agent works with (Node and npm, git, gh, a C toolchain, ripgrep)
# and Pi's CLI for signing in, run as an unprivileged user. compose.yaml runs it behind Tailscale; README.md, "Run
# with Docker", has the steps.

# Reading replies aloud with Kokoro, a speech model run on the CPU: on, or off to leave its model out.
ARG PICLOUD_SPEECH=on
# Embedding long-term memory on the CPU with LEAF (mdbr-leaf-ir-asym), with no key and no network: on, or off to leave
# its model out, so memory embeds with the provider's endpoint and Pi's key, or stays off.
ARG PICLOUD_MEMORY_LOCAL=off

# Build: install every dependency, build the phone app, then drop the packages only development needs. With speech and
# local memory both off, the optional packages go too: they run those models, and nothing else loads them.
FROM node:22.23.4-bookworm-slim AS build
ARG PICLOUD_SPEECH
ARG PICLOUD_MEMORY_LOCAL
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN for switch in "PICLOUD_SPEECH=$PICLOUD_SPEECH" "PICLOUD_MEMORY_LOCAL=$PICLOUD_MEMORY_LOCAL"; do \
		case "${switch#*=}" in on | off) ;; *) echo "${switch%%=*} must be on or off, not '${switch#*=}'." >&2; exit 1 ;; esac; done \
	&& npm ci --no-audit --no-fund \
	&& if [ "$PICLOUD_SPEECH" = on ] && [ ! -d node_modules/kokoro-js ]; then \
		echo "npm left out kokoro-js, which speech needs: an install script under it failed (see above)." >&2; exit 1; fi \
	&& if [ "$PICLOUD_MEMORY_LOCAL" = on ] && [ ! -d node_modules/@huggingface/transformers ]; then \
		echo "npm left out @huggingface/transformers, which local memory needs: an install script under it failed (see above)." >&2; exit 1; fi
COPY . .
RUN npm run build \
	&& npm prune --omit=dev $([ "$PICLOUD_SPEECH" = off ] && [ "$PICLOUD_MEMORY_LOCAL" = off ] && echo --omit=optional) --no-audit --no-fund

# Run: an Ubuntu 24.04 userland, which the installer supports too, so the agent works in the same environment either
# way. The agent sandbox is Landlock, which lives in the host's kernel rather than in the image: what it enforces
# depends on the host, and a Debian 13 host is the recommended one.
FROM ubuntu:noble-20261024.1
ARG PICLOUD_SPEECH
ARG PICLOUD_MEMORY_LOCAL
RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl gh git ripgrep unzip \
	&& rm -rf /var/lib/apt/lists/*

# Node exactly as the official image ships it, with npm, since the agent builds JavaScript projects too.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
	&& ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# git reaches GitHub with gh's credentials, which come from GH_TOKEN: picloud's own token for picloud, and the
# agent's read-only one for agent commands, which get it as their GH_TOKEN.
RUN git config --system credential.https://github.com.helper '!gh auth git-credential'

# The models switched on, downloaded at build time and checked against pinned checksums: at runtime picloud reaches no
# network for them. A layer of its own, before the app's, so a change to the code does not download them again.
COPY deploy/models.sh /app/deploy/models.sh
RUN /app/deploy/models.sh /app/models $([ "$PICLOUD_SPEECH" = on ] && echo speech) $([ "$PICLOUD_MEMORY_LOCAL" = on ] && echo memory)

COPY --from=build /app /app
# The launcher every agent command starts through, built with this stage's toolchain (the build stage has none).
RUN cc -O2 -Wall -o /usr/local/bin/picloud-sandbox /app/src/sandbox/picloud-sandbox.c
# No setuid or setgid programs: nothing in the container can become another user, even with privilege escalation
# allowed, which compose.yaml also forbids.
RUN ln -s /app/node_modules/.bin/pi /usr/local/bin/pi \
	&& useradd --create-home --shell /bin/bash picloud \
	&& install -d -o picloud -g picloud /data /home/picloud/.pi \
	&& find / -xdev -perm /6000 -type f -exec chmod a-s {} +

ENV PICLOUD_DATA_DIR=/data \
	PICLOUD_HOST=127.0.0.1 \
	PICLOUD_PORT=8787
USER picloud
WORKDIR /app
# /data holds the database, workspaces and backups, and each session's own home and tmp, where the tools the agent
# runs keep their caches; the home holds Pi's sign-in and model choice. With compose.yaml's read-only root, these and
# /tmp are all it can write.
VOLUME ["/data", "/home/picloud"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/main.ts"]
