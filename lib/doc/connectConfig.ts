/**
 * Connect-config doc helpers for separate, uncommitted authoring drafts.
 *
 * Explicit Connect ids are never rewritten here. Every complete app-wide
 * target — including one assembled from a session stash — is proposed
 * atomically and either accepted verbatim or refused by the commit gate.
 *
 * Connect-id autofill itself lives at `lib/commcare/connectSlugs.ts`
 * (`deriveConnectId`); wire-emit defaults for `deliver_unit.entity_id` /
 * `entity_name` / `assessment.user_score` live at
 * `lib/commcare/connectDefaults.ts` and run at bind-emit time only.
 */
import {
	connectIdConflictError,
	connectIdError,
	deriveConnectId,
} from "@/lib/commcare/connectSlugs";

/**
 * Re-export the wire-emit default XPath expressions for the optional
 * Connect slots so authoring surfaces can SHOW the user the actual default
 * that runs when a slot is left blank — without reaching across the CommCare
 * boundary themselves. The single source stays `lib/commcare/connectDefaults`;
 * this is the doc-layer doorway to it.
 */
export {
	DEFAULT_ASSESSMENT_USER_SCORE,
	DEFAULT_DELIVER_ENTITY_ID,
	DEFAULT_DELIVER_ENTITY_NAME,
} from "@/lib/commcare/connectDefaults";

/** Re-export the id deriver so authoring surfaces can SHOW the actual
 *  auto-generated id (the value a blank draft will propose) instead of a
 *  placeholder — same boundary-doorway reasoning as the defaults above. */
export { deriveConnectId };

/**
 * Validity of an explicitly-typed Connect id: legal element-name / slug
 * format, then uniqueness against `taken` (every other id in the app's
 * scope). Returns a human-readable reason, or `null` when it's fine. The
 * one place the two wire-vocabulary checks compose, so UI surfaces that
 * collect an id (the form-settings sub-toggles, the app-wide manager) judge
 * a typed id identically without each reaching across the CommCare boundary.
 */
export function connectIdValidity(
	id: string,
	taken: Set<string>,
): string | null {
	return connectIdError(id) ?? connectIdConflictError(id, taken) ?? null;
}

/**
 * Project ONE separate, uncommitted Connect draft id against a running
 * `taken` set. An explicit draft value is always preserved byte-for-byte,
 * including an invalid or duplicate value that the adjacent validity check
 * will refuse. Only an absent value is derived from the display-name fallback.
 * Mutates `taken` by adding the projected id so later blank drafts derive
 * deterministically. Persisted `ConnectConfig` never enters this helper.
 */
export function projectDraftConnectId(
	id: string | undefined,
	fallbackName: string,
	taken: Set<string>,
): string {
	if (id !== undefined) {
		taken.add(id);
		return id;
	}
	const next = deriveConnectId(fallbackName, taken);
	taken.add(next);
	return next;
}
