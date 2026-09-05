#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 0 ]]; then echo 'build-migration-image.sh takes no arguments.' >&2; exit 2; fi
source "$(dirname "$0")/build-common.sh"
nova_require_environment NOVA_MIGRATION_IMAGE_TAG
# Reproducible output makes unchanged migration code retain the same digest
# across application build UUIDs and unrelated source changes.
docker buildx build "${base_arguments[@]}" --build-arg SOURCE_DATE_EPOCH=0 \
	--target migration \
	--output "type=image,name=$NOVA_MIGRATION_IMAGE_TAG,push=true,rewrite-timestamp=true" \
	--metadata-file "$cache_directory/migration-image.json" .
