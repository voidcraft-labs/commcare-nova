#!/usr/bin/env bash
# Build the complete deployable artifact in PR CI and Cloud Build. Publication
# of the application image remains a separate Cloud Build step.
set -euo pipefail

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
if [[ $# != 0 ]]; then
	echo 'build-image.sh takes no arguments; it always builds the final runner.' >&2
	exit 2
fi

cache_directory="${NOVA_BUILD_CACHE_DIRECTORY:-${TMPDIR:-/tmp}/nova-build-cache-${NOVA_BUILD_ID}}"
mkdir -p "$cache_directory/input"
# docker-container supports registry caches even on Cloud Build's Docker daemon.
# The caller owns this private builder; do not alter the user's selected builder.
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

export SENTRY_AUTH_TOKEN="${SENTRY_AUTH_TOKEN:-}"

build_arguments=(
	--builder "$builder"
	--platform linux/amd64
	--progress plain
	--build-context "next-cache=$cache_directory/input"
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
	-f Dockerfile
)
if [[ -n "${NOVA_DOCKER_CACHE_FROM:-}" ]]; then
	build_arguments+=(--cache-from "type=registry,ref=$NOVA_DOCKER_CACHE_FROM")
fi
# No caller-provided target/output flags can bypass the production image gate.
docker buildx build "${build_arguments[@]}" \
	--target runner --load --tag "$NOVA_IMAGE_TAG" .

if [[ -n "${NOVA_DOCKER_CACHE_TO:-}" ]]; then
	# Export only reusable dependency/source/Job layers. Exporting runner and
	# compiler-result layers recompresses per-release artifacts nobody can reuse;
	# the compiler's own incremental cache is exported separately below.
	if ! docker buildx build "${build_arguments[@]}" \
		--target jobs --output type=cacheonly \
		--cache-to "type=registry,ref=$NOVA_DOCKER_CACHE_TO,mode=max,ignore-error=true" .; then
		echo 'Registry cache export failed; the application image is still valid.' >&2
	fi
fi

if [[ "${NOVA_EXPORT_NEXT_CACHE:-false}" == true ]]; then
	# Same builder and inputs: this exports cached compiler output, not a second
	# compilation. Failure to export a cache does not invalidate a good image.
	if ! docker buildx build "${build_arguments[@]}" \
		--target next-cache-export --output "type=local,dest=$cache_directory/output" .; then
		echo 'Next.js cache export failed; the application image is still valid.' >&2
	fi
fi
