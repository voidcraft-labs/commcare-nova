#!/usr/bin/env bash

set -euo pipefail

# Cloud Build and pull-request CI must exercise the same Dockerfile and
# `.dockerignore` boundary. The callers supply production secrets or synthetic
# CI values, but this script owns the complete final-image invocation so build
# inputs cannot drift between the merge gate and deployment.
required_environment=(
	NOVA_IMAGE_TAG
	NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
	NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
	NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
	NEXT_DEPLOYMENT_ID
	NOVA_BUILD_ID
	NOVA_CLOUD_RUN_REQUEST_SECONDS
	NOVA_EDIT_RUN_LEASE_SECONDS
	NOVA_BUILD_STALENESS_SECONDS
	NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH
)

for variable in "${required_environment[@]}"; do
	if [[ -z "${!variable:-}" ]]; then
		echo "Missing required image-build environment: ${variable}" >&2
		exit 1
	fi
done

docker build \
	--tag "${NOVA_IMAGE_TAG}" \
	--build-arg "SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN:-}" \
	--build-arg "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}" \
	--build-arg "NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=${NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID}" \
	--build-arg "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY}" \
	--build-arg "NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}" \
	--build-arg "NOVA_BUILD_ID=${NOVA_BUILD_ID}" \
	--build-arg "NOVA_CLOUD_RUN_REQUEST_SECONDS=${NOVA_CLOUD_RUN_REQUEST_SECONDS}" \
	--build-arg "NOVA_EDIT_RUN_LEASE_SECONDS=${NOVA_EDIT_RUN_LEASE_SECONDS}" \
	--build-arg "NOVA_BUILD_STALENESS_SECONDS=${NOVA_BUILD_STALENESS_SECONDS}" \
	--build-arg "NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH=${NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH}" \
	-f Dockerfile \
	.
