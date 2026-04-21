/**
 * Tests for `recoverLocation` — the pure "degrade to closest valid
 * ancestor" helper used by both the RSC page handler and the
 * client-side `LocationRecoveryEffect`.
 *
 * These cases explicitly exercise the identity-preservation contract
 * (`recover(loc, doc) === loc` when every reference resolves) alongside
 * the inside-out degradation policy:
 *
 *   form → module (stale formUuid)
 *   form → home   (stale moduleUuid)
 *   form → form w/o sel (stale selectedUuid)
 *
 * The doc fixture is a hand-built `LocationDoc` literal (cast through
 * `as never` for slots we don't care about) — we're testing branching
 * logic, not entity content, so hand-building the fixture keeps the
 * test focused and the assertions obvious.
 */

import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import { type LocationDoc, recoverLocation } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

/*
 * Well-known uuids used throughout the file. `asUuid` brands them so
 * they pass into `Location` shapes without casts. `MISSING_*` uuids are
 * deliberately absent from the doc fixtures below.
 */
const MOD_A = asUuid("mod-a");
const MOD_B = asUuid("mod-b");
const FORM_A = asUuid("form-a"); // lives in MOD_A's formOrder
const FORM_B = asUuid("form-b"); // lives in MOD_B's formOrder
const Q_1 = asUuid("q-1");
const MISSING_MOD = asUuid("missing-mod");
const MISSING_FORM = asUuid("missing-form");
const MISSING_Q = asUuid("missing-q");

/**
 * Minimal fixture with two modules, two forms (one per module), and one
 * field. The entity values themselves are irrelevant to recovery —
 * only the presence of a key in `modules`, `forms`, or `questions`
 * matters — so we cast ad-hoc objects through `as never`.
 */
const doc: LocationDoc = {
	modules: {
		[MOD_A]: { uuid: MOD_A, name: "A" } as never,
		[MOD_B]: { uuid: MOD_B, name: "B" } as never,
	},
	forms: {
		[FORM_A]: { uuid: FORM_A, name: "FA" } as never,
		[FORM_B]: { uuid: FORM_B, name: "FB" } as never,
	},
	fields: {
		[Q_1]: { uuid: Q_1, id: "one" } as never,
	},
};

describe("recoverLocation — home", () => {
	it("returns home as-is (identity preserved)", () => {
		const loc: Location = { kind: "home" };
		const result = recoverLocation(loc, doc);
		expect(result).toBe(loc);
	});
});

describe("recoverLocation — module", () => {
	it("valid module uuid → identity", () => {
		const loc: Location = { kind: "module", moduleUuid: MOD_A };
		expect(recoverLocation(loc, doc)).toBe(loc);
	});

	it("missing module uuid → home", () => {
		const loc: Location = { kind: "module", moduleUuid: MISSING_MOD };
		expect(recoverLocation(loc, doc)).toEqual({ kind: "home" });
	});
});

describe("recoverLocation — cases", () => {
	it("valid module uuid (no caseId) → identity", () => {
		const loc: Location = { kind: "cases", moduleUuid: MOD_A };
		expect(recoverLocation(loc, doc)).toBe(loc);
	});

	it("valid module uuid + caseId → identity (caseId not validated)", () => {
		/* caseId is user-supplied free text — the recover policy explicitly
		 * does not touch it. The identity return proves the happy path
		 * short-circuits with a single pointer compare. */
		const loc: Location = {
			kind: "cases",
			moduleUuid: MOD_A,
			caseId: "any-arbitrary-string",
		};
		expect(recoverLocation(loc, doc)).toBe(loc);
	});

	it("missing module uuid → home", () => {
		const loc: Location = {
			kind: "cases",
			moduleUuid: MISSING_MOD,
			caseId: "abc",
		};
		expect(recoverLocation(loc, doc)).toEqual({ kind: "home" });
	});
});

describe("recoverLocation — form", () => {
	it("valid everything (no selection) → identity", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: MOD_A,
			formUuid: FORM_A,
		};
		expect(recoverLocation(loc, doc)).toBe(loc);
	});

	it("valid everything with valid selection → identity", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			selectedUuid: Q_1,
		};
		expect(recoverLocation(loc, doc)).toBe(loc);
	});

	it("valid form + stale selectedUuid → form without selection", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: MOD_A,
			formUuid: FORM_A,
			selectedUuid: MISSING_Q,
		};
		expect(recoverLocation(loc, doc)).toEqual({
			kind: "form",
			moduleUuid: MOD_A,
			formUuid: FORM_A,
		});
	});

	it("missing formUuid (module still valid) → module ancestor", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: MOD_A,
			formUuid: MISSING_FORM,
			selectedUuid: Q_1,
		};
		expect(recoverLocation(loc, doc)).toEqual({
			kind: "module",
			moduleUuid: MOD_A,
		});
	});

	it("missing moduleUuid → home (shortest-ancestor policy)", () => {
		/* When the module itself is gone, nothing below it is recoverable —
		 * we don't try to dig the form's original module out of some other
		 * index. The user's safe destination is app home. */
		const loc: Location = {
			kind: "form",
			moduleUuid: MISSING_MOD,
			formUuid: FORM_A,
			selectedUuid: Q_1,
		};
		expect(recoverLocation(loc, doc)).toEqual({ kind: "home" });
	});

	/*
	 * Cross-module form reference — FORM_B exists in `doc.forms` but
	 * belongs to MOD_B, while the location claims moduleUuid=MOD_A.
	 * `recoverLocation` only checks that `doc.forms[formUuid]` is defined
	 * (it has no moduleUuid→formUuid index available) — so this case
	 * passes through as identity. Documenting here for posterity.
	 */
	it("form exists in doc.forms but in a different module → still identity", () => {
		const loc: Location = {
			kind: "form",
			moduleUuid: MOD_A,
			formUuid: FORM_B,
		};
		expect(recoverLocation(loc, doc)).toBe(loc);
	});
});

/*
 * Defense-in-depth: the recover function must never return a new object
 * reference when no change is needed, because `LocationRecoveryEffect`
 * uses `recovered === loc` as its "skip router.replace" short-circuit.
 * A spurious new object on the happy path would cause a redirect loop.
 */
describe("recoverLocation — identity guarantee", () => {
	it("returns the same reference across every no-op kind", () => {
		const cases: Location[] = [
			{ kind: "home" },
			{ kind: "module", moduleUuid: MOD_A },
			{ kind: "cases", moduleUuid: MOD_A },
			{ kind: "cases", moduleUuid: MOD_A, caseId: "x" },
			{ kind: "form", moduleUuid: MOD_A, formUuid: FORM_A },
			{
				kind: "form",
				moduleUuid: MOD_A,
				formUuid: FORM_A,
				selectedUuid: Q_1,
			},
		];
		for (const loc of cases) {
			expect(recoverLocation(loc, doc)).toBe(loc);
		}
	});
});

/*
 * A tiny sanity check that the fixture `as never` casts don't let
 * untyped properties sneak in — the doc only needs `modules`/`forms`/
 * `fields` record keys to exist. Richer fixtures should be built with
 * the `buildDoc` / `f` DSL in `lib/__tests__/docHelpers.ts`.
 */
describe("recoverLocation — fixture shape sanity", () => {
	it("doc only exposes keyed presence checks", () => {
		const keyCount =
			Object.keys(doc.modules).length +
			Object.keys(doc.forms).length +
			Object.keys(doc.fields).length;
		expect(keyCount).toBe(5);
		// Ensure the canonical shape surface is exactly what the recover
		// algorithm reads from.
		const keys = Object.keys(doc) as (keyof LocationDoc)[];
		expect(keys).toEqual(["modules", "forms", "fields"]);
	});
});
