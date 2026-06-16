/**
 * Identifier-verdict unit tests — every failure class plus the boundary
 * cases the rules hinge on:
 *
 *   - XML element-name legality (spaces, hyphens, leading digits, empty)
 *   - the reserved `__nova_` synthetic-node prefix
 *   - the case-property length cap (255 per CommCare Core's
 *     CaseXmlParser constraint — `MAX_CASE_PROPERTY_LENGTH`): 255 passes,
 *     256 fails
 *   - sibling-id uniqueness: siblings conflict, cousins share freely,
 *     a field re-checking its own id passes (excludeUuid), and in-flight
 *     batch ids count as siblings (pendingSiblingIds)
 *   - the rename verdict's peer-aware scan: renaming a case-bound field
 *     also renames its (id, case_property_on) peers, so a collision in a
 *     PEER's form rejects — and the message names that form
 */

import { describe, expect, it } from "vitest";
import {
	asUuid,
	type BlueprintDoc,
	type Field,
	type Form,
	type Module,
	type Uuid,
} from "@/lib/domain";
import {
	caseTypeNameVerdict,
	fieldIdVerdict,
	findRenameSiblingConflict,
	renameFieldIdVerdict,
} from "../identifierVerdicts";

const MOD = asUuid("11111111-1111-1111-1111-111111111111");
const F1 = asUuid("22222222-2222-2222-2222-222222222222");
const F2 = asUuid("33333333-3333-3333-3333-333333333333");
const AGE = asUuid("44444444-4444-4444-4444-444444444444");
const GRP = asUuid("55555555-5555-5555-5555-555555555555");
const KID_NAME = asUuid("66666666-6666-6666-6666-666666666666");
const WEIGHT_F1 = asUuid("77777777-7777-7777-7777-777777777777");
const WEIGHT_F2 = asUuid("88888888-8888-8888-8888-888888888888");
const TARGET_F2 = asUuid("99999999-9999-9999-9999-999999999999");

/**
 * One module, two forms.
 *
 * Registration: `age`, group `grp` (child `kid_name`), and `weight`
 * (case-bound to "patient"). Follow Up: `weight` (the case-property
 * peer, also bound to "patient") and `target` — the sibling a peer-
 * cascade rename can collide with.
 */
function makeDoc(): BlueprintDoc {
	const mod: Module = {
		uuid: MOD,
		id: "patients",
		name: "Patients",
		caseType: "patient",
	};
	const reg: Form = {
		uuid: F1,
		id: "register",
		name: "Register",
		type: "registration",
	};
	const followup: Form = {
		uuid: F2,
		id: "visit",
		name: "Follow Up",
		type: "followup",
	};
	const fields: Record<Uuid, Field> = {
		[AGE]: { uuid: AGE, id: "age", kind: "int", label: "Age" } as Field,
		[GRP]: { uuid: GRP, id: "grp", kind: "group", label: "Group" } as Field,
		[KID_NAME]: {
			uuid: KID_NAME,
			id: "kid_name",
			kind: "text",
			label: "Kid name",
		} as Field,
		[WEIGHT_F1]: {
			uuid: WEIGHT_F1,
			id: "weight",
			kind: "decimal",
			label: "Weight",
			case_property_on: "patient",
		} as Field,
		[WEIGHT_F2]: {
			uuid: WEIGHT_F2,
			id: "weight",
			kind: "decimal",
			label: "Weight",
			case_property_on: "patient",
		} as Field,
		[TARGET_F2]: {
			uuid: TARGET_F2,
			id: "target",
			kind: "decimal",
			label: "Target",
		} as Field,
	};
	return {
		appId: "test-app",
		appName: "Clinic",
		connectType: null,
		caseTypes: null,
		modules: { [MOD]: mod },
		forms: { [F1]: reg, [F2]: followup },
		fields,
		moduleOrder: [MOD],
		formOrder: { [MOD]: [F1, F2] },
		fieldOrder: {
			[F1]: [AGE, GRP, WEIGHT_F1],
			[GRP]: [KID_NAME],
			[F2]: [WEIGHT_F2, TARGET_F2],
		},
		fieldParent: {
			[AGE]: F1,
			[GRP]: F1,
			[KID_NAME]: GRP,
			[WEIGHT_F1]: F1,
			[WEIGHT_F2]: F2,
			[TARGET_F2]: F2,
		},
	};
}

function codeOf(verdict: ReturnType<typeof fieldIdVerdict>): string {
	return verdict.ok ? "ok" : verdict.code;
}

describe("fieldIdVerdict — format classes", () => {
	const doc = makeDoc();
	const at = (proposedId: string) =>
		fieldIdVerdict({ doc, parentUuid: F1, proposedId });

	it("accepts a plain snake_case id", () => {
		expect(at("first_name")).toEqual({ ok: true });
	});

	it("accepts a leading underscore (legal XML name)", () => {
		expect(at("_internal")).toEqual({ ok: true });
	});

	it("rejects an empty id", () => {
		const v = at("");
		expect(codeOf(v)).toBe("illegal_xml_name");
		expect(v.ok ? "" : v.message).toContain("empty");
	});

	it("rejects spaces, hyphens, and leading digits as XML-illegal", () => {
		for (const bad of ["first name", "first-name", "1st_name", "naïve!"]) {
			const v = at(bad);
			expect(codeOf(v)).toBe("illegal_xml_name");
			expect(v.ok ? "" : v.message).toContain(`"${bad}"`);
		}
	});

	it("rejects the reserved __nova_ prefix", () => {
		const v = at("__nova_count_x");
		expect(codeOf(v)).toBe("reserved_prefix");
		expect(v.ok ? "" : v.message).toContain("__nova_");
	});

	it("accepts a 255-character id and rejects 256 (the case-property cap)", () => {
		expect(at("a".repeat(255))).toEqual({ ok: true });
		const v = at("a".repeat(256));
		expect(codeOf(v)).toBe("too_long");
		expect(v.ok ? "" : v.message).toContain("256");
	});
});

describe("fieldIdVerdict — sibling scope", () => {
	const doc = makeDoc();

	it("rejects an id already used by a sibling", () => {
		const v = fieldIdVerdict({ doc, parentUuid: F1, proposedId: "age" });
		expect(codeOf(v)).toBe("sibling_conflict");
		expect(v.ok ? "" : v.message).toContain('"age"');
	});

	it("accepts a cousin's id under a different parent", () => {
		// `age` lives at the form's top level; inside the group it's a
		// cousin, and cousins may share (different XML paths).
		expect(fieldIdVerdict({ doc, parentUuid: GRP, proposedId: "age" })).toEqual(
			{ ok: true },
		);
	});

	it("passes when the conflicting sibling is the excluded field itself", () => {
		expect(
			fieldIdVerdict({
				doc,
				parentUuid: F1,
				proposedId: "age",
				excludeUuid: AGE,
			}),
		).toEqual({ ok: true });
	});

	it("counts pending batch ids as siblings", () => {
		const v = fieldIdVerdict({
			doc,
			parentUuid: F1,
			proposedId: "incoming",
			pendingSiblingIds: new Set(["incoming"]),
		});
		expect(codeOf(v)).toBe("sibling_conflict");
	});
});

describe("renameFieldIdVerdict", () => {
	const doc = makeDoc();

	it("passes a rename to the field's current id (no-op)", () => {
		expect(renameFieldIdVerdict({ doc, fieldUuid: AGE, newId: "age" })).toEqual(
			{ ok: true },
		);
	});

	it("passes for an unknown field uuid (not-found is the caller's channel)", () => {
		expect(
			renameFieldIdVerdict({
				doc,
				fieldUuid: asUuid("00000000-0000-0000-0000-000000000000"),
				newId: "anything",
			}),
		).toEqual({ ok: true });
	});

	it("rejects a rename onto a sibling's id without naming the own form", () => {
		const v = renameFieldIdVerdict({ doc, fieldUuid: AGE, newId: "grp" });
		expect(codeOf(v)).toBe("sibling_conflict");
		// Same-form conflict: the collision is on the caller's screen, so
		// no form name is appended.
		expect(v.ok ? "" : v.message).not.toContain("Register");
	});

	it("passes a rename onto a cousin's id", () => {
		// `kid_name` lives inside the group — renaming top-level `age` to
		// it creates cousins, not siblings.
		expect(
			renameFieldIdVerdict({ doc, fieldUuid: AGE, newId: "kid_name" }),
		).toEqual({ ok: true });
	});

	it("rejects when a case-property PEER's sibling holds the id, naming the peer's form", () => {
		// Renaming Register's `weight` cascades to Follow Up's `weight`
		// (same id + case_property_on); Follow Up already has `target`.
		const v = renameFieldIdVerdict({
			doc,
			fieldUuid: WEIGHT_F1,
			newId: "target",
		});
		expect(codeOf(v)).toBe("sibling_conflict");
		expect(v.ok ? "" : v.message).toContain('"Follow Up"');
	});

	it("passes when the only id-sharing field renames in lockstep", () => {
		// `weight` exists in both forms, but both rename together (peer
		// cascade) — neither is a conflict for the other.
		expect(
			renameFieldIdVerdict({ doc, fieldUuid: WEIGHT_F1, newId: "bmi" }),
		).toEqual({ ok: true });
	});

	it("applies the format classes to the new id too", () => {
		expect(
			codeOf(renameFieldIdVerdict({ doc, fieldUuid: AGE, newId: "a b" })),
		).toBe("illegal_xml_name");
		expect(
			codeOf(renameFieldIdVerdict({ doc, fieldUuid: AGE, newId: "__nova_x" })),
		).toBe("reserved_prefix");
		expect(
			codeOf(
				renameFieldIdVerdict({
					doc,
					fieldUuid: AGE,
					newId: "a".repeat(256),
				}),
			),
		).toBe("too_long");
	});
});

describe("findRenameSiblingConflict (the store-level backstop's scan)", () => {
	const doc = makeDoc();

	it("returns the conflicting parent uuid", () => {
		expect(findRenameSiblingConflict(doc, AGE, "grp")).toBe(F1);
		expect(findRenameSiblingConflict(doc, WEIGHT_F1, "target")).toBe(F2);
	});

	it("returns undefined when the rename is conflict-free", () => {
		expect(findRenameSiblingConflict(doc, AGE, "fresh_id")).toBeUndefined();
		expect(findRenameSiblingConflict(doc, WEIGHT_F1, "bmi")).toBeUndefined();
	});
});

describe("caseTypeNameVerdict", () => {
	const existing = new Set(["patient", "household"]);

	it("accepts a fresh, well-formed name", () => {
		expect(caseTypeNameVerdict("visit", existing).ok).toBe(true);
	});

	it("rejects empty / blank", () => {
		expect(caseTypeNameVerdict("   ", existing)).toMatchObject({
			ok: false,
			code: "empty",
		});
	});

	it("rejects an illegal identifier (leading digit / spaces)", () => {
		expect(caseTypeNameVerdict("1visit", existing).ok).toBe(false);
		expect(caseTypeNameVerdict("home visit", existing)).toMatchObject({
			ok: false,
			code: "illegal_format",
		});
	});

	it("rejects a reserved namespace, case-insensitively", () => {
		expect(caseTypeNameVerdict("case", existing)).toMatchObject({
			ok: false,
			code: "reserved",
		});
		expect(caseTypeNameVerdict("Parent", existing)).toMatchObject({
			ok: false,
			code: "reserved",
		});
	});

	it("rejects an EXACT duplicate of an existing type", () => {
		expect(caseTypeNameVerdict("patient", existing)).toMatchObject({
			ok: false,
			code: "duplicate",
		});
	});

	it("ACCEPTS a case-variant of an existing type (wire is case-sensitive)", () => {
		// "Patient" and "patient" are distinct, wire-valid case types; the
		// picker must not be stricter than the wire (no DUPLICATE_CASE_TYPE rule).
		expect(caseTypeNameVerdict("Patient", existing).ok).toBe(true);
	});
});
