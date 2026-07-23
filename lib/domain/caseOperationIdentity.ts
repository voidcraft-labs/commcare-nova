import { v5 as uuidv5 } from "uuid";
import type { Uuid } from "./uuid";

/**
 * Stable, Nova-owned identity derivation for a create whose key comes from a
 * form answer.
 *
 * CommCare accepts caller-authored case ids, but a raw answer can collide with
 * a case that is not present in the device's restored casedb. Core would then
 * create locally while HQ would merge into that unseen case. Namespacing the
 * key by app, form, operation, and declared type makes the only ordinary merge
 * the intentional retry/duplicate-key merge for this exact create definition.
 *
 * The namespace UUID and tuple serialization are wire protocol. Changing
 * either would change the case id for an already-deployed form.
 */
export const AUTHORED_CASE_ID_VERSION = "nova-case-v1";
export const AUTHORED_CASE_ID_NAMESPACE_UUID =
	"5f94d90d-9e8c-45b5-888e-8370cbbec356";

/** HQ stores `CommCareCase.case_id` in varchar(255). */
export const MAX_AUTHORED_CASE_ID_LENGTH = 255;

/** `nova-case-v1:` + UUIDv5 + `:` is always 50 UTF-16 code units. */
export const AUTHORED_CASE_ID_PREFIX_LENGTH = 50;
export const MAX_AUTHORED_CASE_KEY_LENGTH =
	MAX_AUTHORED_CASE_ID_LENGTH - AUTHORED_CASE_ID_PREFIX_LENGTH;

export interface AuthoredCaseIdScope {
	readonly appId: string;
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly caseType: string;
}

export type AuthoredCaseIdResult =
	| { readonly ok: true; readonly caseId: string }
	| {
			readonly ok: false;
			readonly reason: "blank" | "too-long";
			readonly maxKeyLength: number;
	  };

/**
 * The exact UUIDv5 name. JSON array serialization is deliberate: it is
 * deterministic and preserves boundaries even if a future app id contains a
 * delimiter. Do not replace it with delimiter joining.
 */
export function authoredCaseIdNamespaceName(
	scope: AuthoredCaseIdScope,
): string {
	return JSON.stringify([
		AUTHORED_CASE_ID_VERSION,
		scope.appId,
		scope.formUuid,
		scope.operationUuid,
		scope.caseType,
	]);
}

export function authoredCaseIdPrefix(scope: AuthoredCaseIdScope): string {
	const namespace = uuidv5(
		authoredCaseIdNamespaceName(scope),
		AUTHORED_CASE_ID_NAMESPACE_UUID,
	);
	const prefix = `${AUTHORED_CASE_ID_VERSION}:${namespace}:`;
	// Keep the bound in sync if the marker or UUID representation ever changes.
	if (prefix.length !== AUTHORED_CASE_ID_PREFIX_LENGTH) {
		throw new Error(
			`Authored case-id prefix length changed from ${AUTHORED_CASE_ID_PREFIX_LENGTH} to ${prefix.length}. This is a wire migration, not a refactor.`,
		);
	}
	return prefix;
}

/**
 * Derive the concrete opaque case id used by Preview/CaseStore.
 *
 * The key is exact: Nova does not trim, case-fold, or Unicode-normalize it.
 * Only the zero-length string is blank. The length check deliberately uses JS
 * UTF-16 code units, matching Java's `String.length()` used by JavaRosa's
 * `string-length()`; PostgreSQL's varchar character count is no stricter.
 */
export function deriveAuthoredCaseId(
	scope: AuthoredCaseIdScope,
	key: string,
): AuthoredCaseIdResult {
	if (key.length === 0) {
		return {
			ok: false,
			reason: "blank",
			maxKeyLength: MAX_AUTHORED_CASE_KEY_LENGTH,
		};
	}
	if (key.length > MAX_AUTHORED_CASE_KEY_LENGTH) {
		return {
			ok: false,
			reason: "too-long",
			maxKeyLength: MAX_AUTHORED_CASE_KEY_LENGTH,
		};
	}
	return { ok: true, caseId: `${authoredCaseIdPrefix(scope)}${key}` };
}
