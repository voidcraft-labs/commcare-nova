/**
 * The staging schema projection — which identity slots of the shared tool
 * surface may carry a change-set handle, decided once per identity FAMILY
 * against the same registry the identity-parity tests derive from
 * (`lib/agent/identityPointerRegistry.ts`).
 *
 * Only Blueprint-ENTITY identities are handle-eligible: entities a private
 * change set can itself create. App, Project, media-asset, lookup, location
 * row, case, thread, run, batch, and every other external identity remains
 * canonical — those resources exist outside the private candidate, so a
 * symbol for a not-yet-created one is meaningless.
 *
 * The RESOLVER stays structural and generic (`handles.ts` — exact one-key
 * `{ handle }` objects anywhere, then the second parse through the original
 * tool schema decides legality). This classification is the REVIEWED
 * decision surface: a new identity family fails the projection source test
 * until someone classifies it here, and the executor-facing projected wire
 * schemas (a later unit) emit `uuid | { handle }` unions from exactly this
 * map.
 */

import type { AuthorableIdentityFamily } from "@/lib/agent/identityPointerRegistry";
import type { StagedEntityKind } from "./schemas";

export type StagingProjectionDecision = "handle-eligible" | "canonical-only";

/**
 * The complete reviewed classification. Every member of
 * `AuthorableIdentityFamily` appears exactly once; the projection source
 * test proves the two unions stay in lockstep.
 */
export const STAGING_PROJECTION_DECISIONS: Readonly<
	Record<AuthorableIdentityFamily, StagingProjectionDecision>
> = {
	"entry-point": "handle-eligible",
	module: "handle-eligible",
	form: "handle-eligible",
	field: "handle-eligible",
	"select-option": "handle-eligible",
	"case-list-column": "handle-eligible",
	"search-input": "handle-eligible",
	"case-operation": "handle-eligible",
	"worker-property": "handle-eligible",
	"user-type": "handle-eligible",
	persona: "handle-eligible",
	"organization-level": "handle-eligible",
	"location-property": "handle-eligible",
	automation: "handle-eligible",
	"automation-criterion": "handle-eligible",
	"automation-setup-criterion": "handle-eligible",
	"automation-update": "handle-eligible",
	"automation-recipient": "handle-eligible",
	"automation-event": "handle-eligible",
	"automation-user-data-filter": "handle-eligible",
	/* After-submit links are Blueprint entities, but no change set can
	 * create one: the executor authorizes no form-link tool from any area
	 * (reviewed construction has no Design Contract carrier for after-submit
	 * links, the same standing as CommCare Connect), and a handle-eligible
	 * family needs a durable staged entity kind, which is a migration of the
	 * staging tables' kind constraint. The eligibility decision rides with
	 * that carrier. */
	"form-link": "canonical-only",
	/* External identities — never handles, per the plan's identity
	 * isolation rules. */
	location: "canonical-only",
	"media-asset": "canonical-only",
	"lookup-table": "canonical-only",
	"lookup-column": "canonical-only",
	"lookup-row": "canonical-only",
};

/** The entity kind a handle-eligible family's binding records. */
export const HANDLE_ENTITY_KIND_BY_FAMILY: Readonly<
	Partial<Record<AuthorableIdentityFamily, StagedEntityKind>>
> = {
	"entry-point": "entry_point",
	module: "module",
	form: "form",
	field: "field",
	"select-option": "option",
	"case-list-column": "case_list_column",
	"search-input": "search_input",
	"case-operation": "case_operation",
	"worker-property": "worker_property",
	"user-type": "user_type",
	persona: "persona",
	"organization-level": "organization_level",
	"location-property": "location_property",
	automation: "automation",
	"automation-criterion": "automation_criterion",
	"automation-setup-criterion": "automation_setup_criterion",
	"automation-update": "automation_update",
	"automation-recipient": "automation_recipient",
	"automation-event": "automation_event",
	"automation-user-data-filter": "automation_user_data_filter",
};

export function familyIsHandleEligible(
	family: AuthorableIdentityFamily,
): boolean {
	return STAGING_PROJECTION_DECISIONS[family] === "handle-eligible";
}
