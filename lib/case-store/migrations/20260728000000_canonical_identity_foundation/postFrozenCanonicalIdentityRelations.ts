/**
 * Relations added after this timestamp that the reviewed canonical-identity
 * cutover must nevertheless treat as app-owned catalog state.
 *
 * This projection lives inside the timestamp tree on purpose. Fresh-database
 * replay and the production scanner execute the same frozen bytes; a historical
 * migration must never import a mutable live catalog from its parent folder.
 */
export const POST_FROZEN_CANONICAL_IDENTITY_PUBLIC_TABLES = [
	"app_location_references",
	"app_locations",
	"app_organization_state",
] as const;
