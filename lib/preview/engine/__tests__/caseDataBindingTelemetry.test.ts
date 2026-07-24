// lib/preview/engine/__tests__/caseDataBindingTelemetry.test.ts
//
// Pins the case-data Server Action error classifier: UNEXPECTED
// failures (raw Postgres errors, compiler-invariant throws) must
// reach Sentry via `log.error`, while EXPECTED typed user-domain
// errors (which the actions map to dedicated result arms) must stay
// out of the issue stream. The `::integer`-vs-`"17.01"` insert
// failure was a raw Postgres error that the actions' catchall arm
// turned into a user-facing message with no log — this is the
// regression net for that silent-swallow.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	SchemaNotSyncedError,
	SubmissionRejectedError,
} from "@/lib/case-store";
import { log } from "@/lib/logger";
import { reportUnexpectedActionError } from "../caseDataBindingTelemetry";

describe("reportUnexpectedActionError", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("alerts on a raw, untyped error — the swallowed-catchall gap that hid the int-cast 500", () => {
		const spy = vi.spyOn(log, "error").mockImplementation(() => {});
		const reported = reportUnexpectedActionError(
			"populateSampleCases",
			// The exact Postgres cast failure that went unreported.
			new Error('invalid input syntax for type integer: "17.01"'),
			{ appId: "app-1", caseType: "patient" },
		);
		expect(reported).toBe(true);
		expect(spy).toHaveBeenCalledOnce();
		const call = spy.mock.calls[0];
		// biome-ignore lint/style/noNonNullAssertion: asserted called once above
		const [message, error, context] = call!;
		// `[caseDataBinding]` prefix drives the Sentry `component` tag;
		// the error object rides along so Sentry fingerprints on its
		// stack; `appId` promotes to an indexed tag.
		expect(message).toContain("[caseDataBinding]");
		expect(message).toContain("populateSampleCases");
		expect(error).toBeInstanceOf(Error);
		expect(context).toMatchObject({
			action: "populateSampleCases",
			appId: "app-1",
			caseType: "patient",
		});
	});

	it("stays silent on the typed user-domain errors that have dedicated result arms", () => {
		const spy = vi.spyOn(log, "error").mockImplementation(() => {});
		const expectedErrors = [
			new CaseNotFoundError("c1"),
			new CaseTypeNotInBlueprintError("app-1", "patient"),
			new SchemaNotSyncedError("app-1", "patient"),
			// The envelope's whole-rollback rejection maps to the
			// `submission-rejected` result arm — expected control flow.
			new SubmissionRejectedError({
				kind: "authored-key",
				operationUuid: "op-1",
				reason: "blank",
				maxKeyLength: 205,
			}),
		];
		for (const err of expectedErrors) {
			expect(
				reportUnexpectedActionError("loadCases", err, { appId: "app-1" }),
			).toBe(false);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("treats invalid properties as user error by default, but a generator bug for sample-data", () => {
		const spy = vi.spyOn(log, "error").mockImplementation(() => {});
		const validationErr = new CasePropertiesValidationError(
			"app-1",
			"patient",
			[{ path: "/weight", message: "must be number" }],
		);

		// Form submit: the submitted values failed the schema — ordinary
		// user error, no alert.
		expect(
			reportUnexpectedActionError("submitForm", validationErr, {
				appId: "app-1",
			}),
		).toBe(false);

		// Sample-data: the GENERATOR produced data its own schema rejects
		// — a bug, so it alerts.
		expect(
			reportUnexpectedActionError(
				"populateSampleCases",
				validationErr,
				{ appId: "app-1" },
				{ treatValidationAsBug: true },
			),
		).toBe(true);
		expect(spy).toHaveBeenCalledOnce();
	});
});
