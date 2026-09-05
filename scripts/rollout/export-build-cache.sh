#!/usr/bin/env bash
# Best-effort cache publication, concurrent with service deployment.
set -euo pipefail
if [[ $# != 0 ]]; then echo 'export-build-cache.sh takes no arguments.' >&2; exit 2; fi
source "$(dirname "$0")/build-common.sh"
finish_cache_export() { docker buildx rm "$builder" >/dev/null 2>&1 || true; }
trap finish_cache_export EXIT

export_dependency_cache() {
if [[ -n "${NOVA_DOCKER_CACHE_TO:-}" ]]; then
	docker buildx build "${base_arguments[@]}" --target deps --output type=cacheonly \
		--cache-to "type=registry,ref=$NOVA_DOCKER_CACHE_TO,mode=min,compression=zstd,compression-level=1,ignore-error=true" . || \
		echo 'Dependency cache export failed; the application image is valid.' >&2
fi
}
export_compiler_cache() {
if [[ -n "${NOVA_NEXT_CACHE_TO:-}" ]]; then
	docker buildx build "${base_arguments[@]}" --build-arg "NOVA_BUILD_ID=$NOVA_BUILD_ID" --target next-cache-export \
		--output "type=image,name=$NOVA_NEXT_CACHE_TO,push=true,compression=zstd,compression-level=1,force-compression=true,oci-mediatypes=true" \
		--metadata-file "$cache_directory/next-image.json" . || \
		echo 'Compiler cache export failed; the application image is valid.' >&2
fi

}
# Independent immutable exports overlap their network waits. Both finish before
# the builder is removed or a completion manifest can be published.
export_dependency_cache &
dependency_export_pid=$!
export_compiler_cache &
compiler_export_pid=$!
wait "$dependency_export_pid"
wait "$compiler_export_pid"
