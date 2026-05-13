// lib/case-store/__tests__/errors.test.ts
//
// Contract tests for the typed user-domain error classes.
//
// Four error classes flow through to API + Server Action consumers:
//
//   - `CaseNotFoundError(caseId)` — covers row-not-found,
//     row-removed-out-of-band, and row-outside-bound-tenant as one
//     equivalence class so the tenant boundary stays structural.
//   - `CasePropertiesValidationError(appId, caseType, failures)` —
//     carries the structured per-field AJV failure list as a public
//     field so API routes catch and re-emit it.
//   - `CaseTypeNotInBlueprintError(appId, caseType)` — surfaces
//     from two production throw sites: the case-store's
//     `applySchemaChange` (when the supplied `caseTypeSchemas`
//     map omits the requested case type) and the running-app
//     view's `caseDataBindingHelpers.resolveCaseTypeOrThrow`
//     (when the supplied `BlueprintDoc` snapshot omits it).
//     Server Actions on the running-app view map to a
//     `missing-case-type` result arm.
//   - `SchemaNotSyncedError(appId, caseType)` — surfaces from
//     `getValidator` when no `case_type_schemas` row exists for
//     `(appId, caseType)`. Server Actions map to a
//     `schema-not-synced` result arm.
//
// All four classes use `readonly name = "<ClassName>"` field
// initializers so the literal class-name stays stable across bundler
// transforms.
//
// ## Voice contract
//
// The tests pin the LOAD-BEARING facts (the class name; the public
// fields; substring assertions on the user-actionable header) but
// not the indentation, line breaks, or the `Hint:` line text.
// Voice tweaks to the message body should not break these tests —
// the structured field contract is the API surface, not the
// rendered prose.

import { describe, expect, it } from "vitest";
import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	type CasePropertyFailure,
	CaseTypeNotInBlueprintError,
	SchemaNotSyncedError,
} from "../errors";

// ---------------------------------------------------------------
// CaseNotFoundError
// ---------------------------------------------------------------

describe("CaseNotFoundError", () => {
	it("populates `caseId` as a public field", () => {
		const err = new CaseNotFoundError("case-123");
		expect(err.caseId).toBe("case-123");
	});

	it("pins `name` to the class name (stable across bundler transforms)", () => {
		const err = new CaseNotFoundError("case-123");
		expect(err.name).toBe("CaseNotFoundError");
	});

	it("is an Error instance for catch-block compatibility", () => {
		const err = new CaseNotFoundError("case-123");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(CaseNotFoundError);
	});

	it("carries the case id in the rendered message header", () => {
		// Pin the load-bearing fact (the case id) without locking down
		// indentation or surrounding voice.
		const err = new CaseNotFoundError("case-abc-def");
		expect(err.message).toContain("Case 'case-abc-def' not found");
	});

	it("does NOT confirm the case is in another tenant — the equivalence statement keeps tenant boundaries structural", () => {
		// The earlier message wording leaked tenant existence
		// ("belongs to another tenant"); the new message frames the
		// three equivalent causes (absent / removed / outside-tenant)
		// as one equivalence class. This test pins the
		// non-leak contract.
		const err = new CaseNotFoundError("case-abc-def");
		expect(err.message).not.toMatch(/belongs to another tenant/);
		expect(err.message).not.toMatch(/another tenant has this case/);
	});
});

// ---------------------------------------------------------------
// CasePropertiesValidationError
// ---------------------------------------------------------------

describe("CasePropertiesValidationError", () => {
	const failures: ReadonlyArray<CasePropertyFailure> = [
		{ path: "/age", message: "must be integer" },
		{ path: "/name", message: "must NOT have fewer than 1 characters" },
	];

	it("populates `appId`, `caseType`, and `failures` as public fields", () => {
		const err = new CasePropertiesValidationError("app-1", "patient", failures);
		expect(err.appId).toBe("app-1");
		expect(err.caseType).toBe("patient");
		expect(err.failures).toEqual(failures);
	});

	it("pins `name` to the class name", () => {
		const err = new CasePropertiesValidationError("app-1", "patient", failures);
		expect(err.name).toBe("CasePropertiesValidationError");
	});

	it("is an Error instance for catch-block compatibility", () => {
		const err = new CasePropertiesValidationError("app-1", "patient", failures);
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(CasePropertiesValidationError);
	});

	it("renders the case type in the header for log scanning", () => {
		const err = new CasePropertiesValidationError("app-1", "patient", failures);
		expect(err.message).toContain("'patient'");
	});

	it("renders each failure path + message in the body for debug context", () => {
		const err = new CasePropertiesValidationError("app-1", "patient", failures);
		expect(err.message).toContain("/age");
		expect(err.message).toContain("must be integer");
		expect(err.message).toContain("/name");
		expect(err.message).toContain("must NOT have fewer than 1 characters");
	});

	it("preserves the structured failure list for API routes to surface", () => {
		// The API route's 400 response body emits `err.failures`
		// directly. The list shape is the contract; the rendered
		// prose is supplementary.
		const err = new CasePropertiesValidationError("app-1", "patient", failures);
		expect(err.failures).toHaveLength(2);
		expect(err.failures[0]).toEqual({
			path: "/age",
			message: "must be integer",
		});
		expect(err.failures[1]).toEqual({
			path: "/name",
			message: "must NOT have fewer than 1 characters",
		});
	});

	it("renders an empty failure list cleanly when no AJV errors are reported", () => {
		// AJV's `validator.errors` can be `null` per the typed
		// surface; the case-store's projection coerces to `[]`
		// before passing in. This test pins the empty-list shape.
		const err = new CasePropertiesValidationError("app-1", "patient", []);
		expect(err.failures).toEqual([]);
		expect(err.message).toContain("'patient'");
	});
});

// ---------------------------------------------------------------
// CaseTypeNotInBlueprintError
// ---------------------------------------------------------------

describe("CaseTypeNotInBlueprintError", () => {
	it("populates `appId` + `caseType` as public fields", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		expect(err.appId).toBe("app-1");
		expect(err.caseType).toBe("patient");
	});

	it("pins `name` to the class name (stable across bundler transforms)", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		expect(err.name).toBe("CaseTypeNotInBlueprintError");
	});

	it("is an Error instance for catch-block compatibility", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(CaseTypeNotInBlueprintError);
	});

	it("carries the case type in the rendered message header", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		expect(err.message).toContain("'patient'");
	});

	it("acknowledges three equivalent causes in the body without claiming which", () => {
		// The shape mirrors `CaseNotFoundError`'s equivalence-class
		// framing. Any one of the three causes (deleted, stale,
		// never declared) explains the missing case type from the
		// caller's perspective; surfacing them as equivalent keeps
		// the typed shape narrow.
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		expect(err.message).toMatch(/deleted/);
		expect(err.message).toMatch(/stale/);
	});
});

// ---------------------------------------------------------------
// SchemaNotSyncedError
// ---------------------------------------------------------------

describe("SchemaNotSyncedError", () => {
	it("populates `appId` + `caseType` as public fields", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		expect(err.appId).toBe("app-1");
		expect(err.caseType).toBe("patient");
	});

	it("pins `name` to the class name (stable across bundler transforms)", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		expect(err.name).toBe("SchemaNotSyncedError");
	});

	it("is an Error instance for catch-block compatibility", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(SchemaNotSyncedError);
	});

	it("carries the case type in the rendered message header", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		expect(err.message).toContain("'patient'");
	});

	it("points the reader at applySchemaChange as the structural fix", () => {
		// The body's `Hint:` directs the consumer to the upstream
		// ordering contract — every blueprint mutation runs
		// `applySchemaChange` before any data write reaches the
		// case type.
		const err = new SchemaNotSyncedError("app-1", "patient");
		expect(err.message).toMatch(/applySchemaChange/);
	});
});
