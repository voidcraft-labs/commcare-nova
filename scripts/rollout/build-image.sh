#!/usr/bin/env bash
# CI and production build the same complete runner. Only the exporter differs.
set -euo pipefail
if [[ $# != 0 ]]; then
	echo 'build-image.sh takes no arguments; it always builds the final runner.' >&2
	exit 2
fi
source "$(dirname "$0")/build-common.sh"
nova_application_arguments

# CI also builds the exact migration artifact. Cloud Build starts its separate
# fixed-target helper concurrently so migration can overlap app compilation.
if [[ "${NOVA_SEPARATE_MIGRATION_BUILD:-false}" != true ]]; then
	docker buildx build "${base_arguments[@]}" --build-arg SOURCE_DATE_EPOCH=0 \
		--target migration --load --tag "${NOVA_IMAGE_TAG}-migration" .
fi

# Resolve and materialize only the disposable cache first. A broken cache can
# fall back here before any application compilation or validation starts.
if ! docker buildx build "${application_arguments[@]}" --target cache-seed --output type=cacheonly .; then
	echo 'Compiler cache unavailable; preparing an empty cache.' >&2
	printf '%s' "$cache_directory/input" > "$cache_directory/seed-context"
	nova_application_arguments
	docker buildx build "${application_arguments[@]}" --target cache-seed --output type=cacheonly .
fi
printf '%s' "$seed_context" > "$cache_directory/seed-context"

case "${NOVA_IMAGE_OUTPUT:-load}" in
	load)
		docker buildx build "${application_arguments[@]}" --target runner \
			--load --tag "$NOVA_IMAGE_TAG" .
        docker run --rm --entrypoint node "$NOVA_IMAGE_TAG" --input-type=module -e '
          for (const [name, member] of [["@google-cloud/kms", "KeyManagementServiceClient"], ["@google-cloud/cloud-sql-connector", "Connector"], ["@google-cloud/storage", "Storage"]]) {
            if (typeof (await import(name))[member] !== "function") throw new Error(`Missing standalone SDK: ${name}`);
          }
        '
		;;
	registry)
		docker buildx build "${application_arguments[@]}" --target runner \
			--output "type=image,name=$NOVA_IMAGE_TAG,push=true" \
			--metadata-file "$cache_directory/app-image.json" .
		;;
	*) echo 'NOVA_IMAGE_OUTPUT must be load or registry.' >&2; exit 2 ;;
esac
