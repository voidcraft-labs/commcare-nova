#!/usr/bin/env bash
# Shared BuildKit invocation. Each caller chooses one fixed artifact target.
set -euo pipefail

nova_require_environment() {
	local variable
	for variable in "$@"; do
		if [[ -z "${!variable:-}" ]]; then
			echo "Missing required image-build environment: ${variable}" >&2
			exit 1
		fi
	done
}

nova_require_environment NOVA_BUILD_ID
cache_directory="${NOVA_BUILD_CACHE_DIRECTORY:-${TMPDIR:-/tmp}/nova-build-cache-${NOVA_BUILD_ID}}"
mkdir -p "$cache_directory/input"
builder="${NOVA_BUILDX_BUILDER:-nova-${NOVA_BUILD_ID}}"
created_builder=false
cleanup_builder() {
	local status=$?
	if [[ "$created_builder" == true ]]; then
		docker buildx rm "$builder" >/dev/null 2>&1 || true
	fi
	return "$status"
}
trap cleanup_builder EXIT
if [[ -z "${NOVA_BUILDX_BUILDER:-}" ]]; then
	docker buildx create --name "$builder" --driver docker-container \
		--driver-opt image=moby/buildkit:v0.33.0 >/dev/null
	created_builder=true
fi

base_arguments=(--builder "$builder" --platform linux/amd64 --progress plain --provenance=false -f Dockerfile)
if [[ -n "${NOVA_DOCKER_CACHE_FROM:-}" ]]; then
	base_arguments+=(--cache-from "type=registry,ref=$NOVA_DOCKER_CACHE_FROM")
fi

nova_application_arguments() {
	nova_require_environment NOVA_IMAGE_TAG NEXT_PUBLIC_GOOGLE_MAPS_API_KEY \
		NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
		NEXT_DEPLOYMENT_ID NOVA_CLOUD_RUN_REQUEST_SECONDS \
		NOVA_EDIT_RUN_LEASE_SECONDS NOVA_BUILD_STALENESS_SECONDS \
		NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH
	export SENTRY_AUTH_TOKEN="${SENTRY_AUTH_TOKEN:-}"
	seed_context="${NOVA_NEXT_CACHE_FROM:+docker-image://${NOVA_NEXT_CACHE_FROM}}"
	seed_context="${seed_context:-$cache_directory/input}"
	if [[ -f "$cache_directory/seed-context" ]]; then
		seed_context="$(cat "$cache_directory/seed-context")"
	fi
	application_arguments=("${base_arguments[@]}"
		--build-context "next-cache=$seed_context"
		--secret id=SENTRY_AUTH_TOKEN,env=SENTRY_AUTH_TOKEN
		--secret id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
		--build-arg "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=${NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}"
		--build-arg "NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=${NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID}"
		--build-arg "NEXT_DEPLOYMENT_ID=${NEXT_DEPLOYMENT_ID}"
		--build-arg "NOVA_BUILD_ID=${NOVA_BUILD_ID}"
		--build-arg "NOVA_CLOUD_RUN_REQUEST_SECONDS=${NOVA_CLOUD_RUN_REQUEST_SECONDS}"
		--build-arg "NOVA_EDIT_RUN_LEASE_SECONDS=${NOVA_EDIT_RUN_LEASE_SECONDS}"
		--build-arg "NOVA_BUILD_STALENESS_SECONDS=${NOVA_BUILD_STALENESS_SECONDS}"
		--build-arg "NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH=${NOVA_RUNTIME_CAPABILITY_MANIFEST_HASH}"
	)
}
