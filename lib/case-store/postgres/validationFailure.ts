// lib/case-store/postgres/validationFailure.ts
//
// Project an AJV validation error onto the case-store's typed
// `CasePropertyFailure`. Split out of `store.ts` so the projection is
// unit-testable without booting the Postgres harness, and so the two
// write paths that validate (`validateProperties`,
// `insertManyInTransaction`) share one mapping.

import type { ErrorObject } from "ajv";
import type { CasePropertyFailure } from "../errors";

/**
 * Map one AJV `ErrorObject` to a `CasePropertyFailure`.
 *
 * `additionalProperties` is the one keyword whose default message
 * names nothing useful: AJV reports `instancePath` as the CONTAINING
 * object (the empty string for the document root) and stashes the
 * offending key in `params.additionalProperty`, so a bare "must NOT
 * have additional properties" leaves the reader guessing which
 * property tripped it. Fold the property name into the message — the
 * dominant cause of this failure is a write carrying a property the
 * case type's schema row does not (yet) declare (a freshly-added
 * property whose `case_type_schemas` sync has not landed), and naming
 * it points straight at the culprit.
 *
 * Every other keyword's default `message` already reads cleanly
 * against its `instancePath`, so it passes through unchanged.
 *
 * On an `additionalProperties` failure the offending key is also
 * surfaced structurally on `additionalProperty` — the point-of-use heal
 * keys on that field (not the message text) to recognize schema drift.
 */
export function ajvErrorToCaseFailure(error: ErrorObject): CasePropertyFailure {
	if (error.keyword === "additionalProperties") {
		const extra = (error.params as { additionalProperty?: string })
			.additionalProperty;
		if (extra !== undefined && extra !== "") {
			return {
				path: error.instancePath || "",
				message: `must NOT have additional property '${extra}'`,
				additionalProperty: extra,
			};
		}
	}
	return {
		path: error.instancePath || "",
		message: error.message ?? "invalid",
	};
}
