/**
 * Public relations added after the canonical-identity cutover that depend on
 * `apps` and are therefore part of the cutover scanner's current catalog
 * closure. Keeping this list outside the timestamp-frozen occurrence and
 * repair manifests preserves their evidence while making every later,
 * deliberately approved dependency review-visible.
 */
export const POST_FROZEN_CANONICAL_IDENTITY_PUBLIC_TABLES = [
	"app_location_references",
	"app_locations",
	"app_organization_state",
] as const;
