#!/usr/bin/env bash
# Cloud Build's versioned Docker builder does not guarantee the buildx plugin.
# Install a checksum-pinned CLI plugin in the step's private configuration.
set -euo pipefail
plugin_directory="${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins"
mkdir -p "$plugin_directory"
curl --fail --silent --show-error --location --retry 3 \
	https://github.com/docker/buildx/releases/download/v0.36.1/buildx-v0.36.1.linux-amd64 \
	--output "$plugin_directory/docker-buildx"
printf '%s  %s\n' \
	48af8a397ebd60178778bf63611dbcebe5f5e7a9be90eb9147b24b9587455778 \
	"$plugin_directory/docker-buildx" | sha256sum --check --status
chmod 700 "$plugin_directory/docker-buildx"
docker buildx version
