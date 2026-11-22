# picloud in a container: the server, the tools its agent works with (Node and npm, git, gh, a C toolchain, ripgrep)
# and Pi's CLI for signing in, run as an unprivileged user. compose.yaml runs it behind Tailscale; README.md, "Run
# with Docker", has the steps.

# Build: install every dependency, build the phone app, then drop the packages only development needs.
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# Run: Ubuntu 24.04, the system the installer targets, so the agent works in the same environment either way.
FROM ubuntu:noble-20261024.1
RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl gh git ripgrep unzip \
	&& rm -rf /var/lib/apt/lists/*

# Node exactly as the official image ships it, with npm, since the agent builds JavaScript projects too.
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
	&& ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# git reaches GitHub with gh's credentials, which come from GH_TOKEN.
RUN git config --system credential.https://github.com.helper '!gh auth git-credential'

COPY --from=build /app /app
RUN ln -s /app/node_modules/.bin/pi /usr/local/bin/pi \
	&& useradd --create-home --shell /bin/bash picloud \
	&& install -d -o picloud -g picloud /data /home/picloud/.pi

ENV PICLOUD_DATA_DIR=/data \
	PICLOUD_HOST=127.0.0.1 \
	PICLOUD_PORT=8787
USER picloud
WORKDIR /app
# /data holds the database, workspaces and backups; ~/.pi holds Pi's sign-in and model choice.
VOLUME ["/data", "/home/picloud/.pi"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/main.ts"]
