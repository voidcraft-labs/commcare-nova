import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { xpIn } from "@/lib/__tests__/docHelpers";
import {
	buildConnectSlugMap,
	connectIdConflictError,
	connectIdError,
	deriveConnectId,
} from "@/lib/commcare/connectSlugs";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { connectWireFixtures } from "./connectWireFixtures";

function fixture(name: string) {
	const found = connectWireFixtures().find((fixture) => fixture.name === name);
	if (!found) throw new Error(name);
	const formUuid = found.doc.formOrder[found.doc.moduleOrder[0]][0];
	return { ...found, formUuid, form: found.doc.forms[formUuid] };
}

// These are private identity-policy and defensive compiler assertions. They do
// not establish external acceptance; Connect's native consumer owns that proof.
describe("Connect identity projection", () => {
	it.each(["learn-default", "deliver-default", "absent"])(
		"%s keeps complete stored identities and does not mutate its source",
		(name) => {
			const { doc, formUuid, form } = fixture(name);
			const before = structuredClone(doc);
			const result = buildConnectSlugMap(doc);
			expect([...result]).toEqual(
				form.connect ? [[formUuid, form.connect]] : [],
			);
			expect(doc).toEqual(before);
		},
	);

	it.each(["", "bad id", "1leading", "a".repeat(51)])(
		"refuses a forged invalid final id %j instead of repairing it",
		(id) => {
			const { doc, form } = fixture("learn-default");
			if (
				!form.connect ||
				!("learn_module" in form.connect) ||
				!form.connect.learn_module
			)
				throw new Error("Missing lesson");
			form.connect.learn_module.id = id;
			expect(() => buildConnectSlugMap(doc)).toThrow(/invalid final id/);
			expect(() => expandDoc(doc)).toThrow(/invalid final id/);
		},
	);

	it("refuses two blocks sharing a final id, including different block kinds", () => {
		const { doc, form } = fixture("learn-default");
		if (
			!form.connect ||
			!("assessment" in form.connect) ||
			!form.connect.assessment
		)
			throw new Error("Missing quiz");
		form.connect.assessment.id = "lesson";
		expect(() => buildConnectSlugMap(doc)).toThrow(
			/Two Connect blocks share the id "lesson"/,
		);
	});

	it.each([null, "deliver"] as const)(
		"refuses learned blocks after a forged app-mode change to %s",
		(mode) => {
			const { doc } = fixture("learn-default");
			doc.connectType = mode;
			expect(() => buildConnectSlugMap(doc)).toThrow(
				mode === null ? /no Connect mode/ : /wrong app mode/,
			);
		},
	);
});

describe("Connect creation identity policy", () => {
	it.each([
		"2024 Intake",
		"has space",
		"1st_module",
		"bad-dash",
		"",
		"a".repeat(51),
	])("explains invalid id %j", (id) => {
		expect(connectIdError(id)).toEqual(expect.any(String));
	});
	it.each(["intake_2024", "_leading_underscore", "a".repeat(50)])(
		"accepts %j",
		(id) => {
			expect(connectIdError(id)).toBeNull();
		},
	);
	it("only rejects explicit identities that another block owns", () => {
		expect(
			connectIdConflictError("intro", new Set(["intro", "other"])),
		).toContain("already used");
		expect(connectIdConflictError("intro", new Set(["other"]))).toBeNull();
	});
	it("derives the first available suffix across digit and length boundaries", () => {
		expect(deriveConnectId("Module 3 Intro", new Set())).toBe("module_3_intro");
		const base = "a".repeat(50);
		const taken = new Set([base]);
		for (let n = 2; n <= 101; n++) {
			const suffix = `_${n}`;
			const expected = base.slice(0, 50 - suffix.length) + suffix;
			expect(deriveConnectId(base, taken)).toBe(expected);
			taken.add(expected);
		}
	});
	it("constructs a bounded fresh XML-safe identity from arbitrary names without changing reservations", () => {
		fc.assert(
			fc.property(
				fc.string(),
				fc.array(fc.string(), { maxLength: 10 }),
				(name, reservations) => {
					const initial = new Set(reservations);
					const first = deriveConnectId(name, initial);
					expect(first).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
					expect(first.length).toBeLessThanOrEqual(50);
					expect(initial.has(first)).toBe(false);
					expect([...initial]).toEqual([...new Set(reservations)]);
					const occupied = new Set([...initial, first]);
					const second = deriveConnectId(name, occupied);
					expect(occupied.has(second)).toBe(false);
					expect(second).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
					expect(second.length).toBeLessThanOrEqual(50);
				},
			),
			{ seed: 648201, numRuns: 100 },
		);
	});
});

describe("Connect data paths in validator admission", () => {
	it.each([
		["learn-default", "lesson"],
		["deliver-default", "task"],
	])(
		"%s admits the actual wrapper and identifies a missing wrapper",
		(name, wrapper) => {
			const { doc, formUuid } = fixture(name);
			const field = doc.fields[doc.fieldOrder[formUuid][0]];
			const setReference = (target: BlueprintDoc, path: string) => {
				const targetField = target.fields[field.uuid];
				if (targetField.kind !== "int")
					throw new Error("Expected score question");
				targetField.relevant = xpIn(target, formUuid, `${path} = 'x'`);
			};
			setReference(doc, `/data/${wrapper}`);
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			setReference(doc, "/data/no_such_connect_node");
			const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({
				code: "INVALID_REF",
				location: { formUuid, fieldUuid: field.uuid },
			});
			expect(findings[0].message).toContain("no_such_connect_node");
		},
	);
});
