// lib/preview/engine/caseDataBindingTelemetry.ts
//
// Server-only telemetry seam for the case-data Server Actions in
// `./caseDataBinding.ts`. It lives OUTSIDE that `"use server"`
// module because a `"use server"` file may only export async
// functions — extracting the synchronous error classifier here
// makes it unit-testable in isolation and shared across every
// action's catch.
//
// Why it exists: every case-data action catches and maps thrown
// errors to a typed / catchall result arm so an unhandled throw
// never tears down the RSC tree. But the catchall arm turns a raw
// Postgres error (e.g. the `::integer`-vs-`"17.01"` insert cast
// failure) or a compiler-invariant throw into a user-facing message
// with NO server-side log — so a user-blocking bug reaches the user
// and never raises a Sentry issue. This seam is the side-channel
// that makes those failures alert while keeping EXPECTED typed
// errors (which have dedicated result arms) out of the issue stream.

import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	ParkedValueNotFoundError,
	SchemaNotSyncedError,
	SubmissionRejectedError,
} from "@/lib/case-store";
import { log } from "@/lib/logger";

/**
 * The case-store's typed user-domain errors. Each maps to a
 * dedicated result arm the running-app client handles (not-found,
 * invalid-properties, missing-case-type, schema-not-synced), so
 * they are EXPECTED control flow — not bugs — and stay out of
 * Sentry. The case-store's internal-invariant throws and any raw
 * driver error are plain `Error`s that fall outside this set and so
 * alert. Exported for the classifier's unit test.
 *
 * Must list EVERY typed user-domain class in `lib/case-store/errors.ts`.
 * Drift is fail-safe, not fail-silent: a new typed error missing here
 * is treated as unexpected and OVER-alerts (a noisy Sentry issue, not
 * a swallowed bug) — but keep it in sync to avoid that noise.
 */
export const TYPED_USER_DOMAIN_ERRORS = [
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	ParkedValueNotFoundError,
	SchemaNotSyncedError,
	SubmissionRejectedError,
] as const;

/** Context attached to an unexpected-error report. */
export interface CaseDataActionErrorContext {
	readonly appId: string;
	readonly caseType?: string;
}

/** Options controlling per-action severity classification. */
export interface ReportUnexpectedActionErrorOptions {
	/**
	 * Flip `CasePropertiesValidationError` to alert-worthy. Set for
	 * the sample-data paths, where a validation failure means the
	 * GENERATOR produced data its own case-type schema rejects (a
	 * bug) — never user input. Left unset for form submit, where
	 * invalid properties are ordinary user error.
	 */
	readonly treatValidationAsBug?: boolean;
}

/**
 * Mirror an UNEXPECTED case-data Server Action failure to Sentry via
 * `log.error`'s two-channel capture. The caller still maps the error
 * to its result arm afterwards; this only adds the alert side-
 * channel. Returns whether it reported (for the unit test).
 *
 * Reports anything that is NOT one of the case-store's typed
 * user-domain errors, plus `CasePropertiesValidationError` when
 * `treatValidationAsBug` is set. The `[caseDataBinding]` message
 * prefix becomes the Sentry `component` tag; `appId` promotes to an
 * indexed tag and `action` / `caseType` ride in `extra` (see
 * `lib/logger.ts`).
 */
export function reportUnexpectedActionError(
	action: string,
	err: unknown,
	context: CaseDataActionErrorContext,
	opts?: ReportUnexpectedActionErrorOptions,
): boolean {
	const validationIsBug =
		opts?.treatValidationAsBug === true &&
		err instanceof CasePropertiesValidationError;
	const isExpected =
		TYPED_USER_DOMAIN_ERRORS.some((Ctor) => err instanceof Ctor) &&
		!validationIsBug;
	if (isExpected) return false;
	log.error(`[caseDataBinding] ${action} failed unexpectedly`, err, {
		action,
		...context,
	});
	return true;
}
