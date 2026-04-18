/**
 * Round-trip tests for `mutationSchema` — one assertion per Mutation kind
 * proves the Zod schema accepts the exact shape a reducer would consume.
 * The event log reader validates persisted mutation payloads via this
 * schema, so every new mutation variant needs a fixture here.
 */
import { describe, expect, it } from "vitest";
import { asUuid, type Mutation, mutationSchema } from "@/lib/doc/types";
import type { Field, Form, Module } from "@/lib/domain";

// Shared fixtures — stable UUIDs so failures point at specific payloads.
const moduleUuid = asUuid("11111111-1111-1111-1111-111111111111");
const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
const fieldUuid = asUuid("33333333-3333-3333-3333-333333333333");
const otherModuleUuid = asUuid("44444444-4444-4444-4444-444444444444");
const otherFieldUuid = asUuid("55555555-5555-5555-5555-555555555555");

const module_: Module = {
	uuid: moduleUuid,
	id: "patients",
	name: "Patients",
};

const form_: Form = {
	uuid: formUuid,
	id: "intake",
	name: "Intake",
	type: "registration",
};

const field_: Field = {
	kind: "text",
	uuid: fieldUuid,
	id: "name",
	label: "Name",
};

/**
 * Expect `mutation` to round-trip through `mutationSchema` unchanged.
 *
 * Wrapping the assertion in a helper keeps each per-kind test to a single
 * line so the table reads like a fixture matrix. The helper also gives
 * failing assertions a stable label via the input's `kind` discriminator.
 */
function expectRoundTrip(mutation: Mutation): void {
	expect(mutationSchema.parse(mutation)).toEqual(mutation);
}

describe("mutationSchema round-trip", () => {
	describe("module", () => {
		it("addModule", () => {
			expectRoundTrip({ kind: "addModule", module: module_ });
		});

		it("addModule with index", () => {
			expectRoundTrip({ kind: "addModule", module: module_, index: 2 });
		});

		it("removeModule", () => {
			expectRoundTrip({ kind: "removeModule", uuid: moduleUuid });
		});

		it("moveModule", () => {
			expectRoundTrip({ kind: "moveModule", uuid: moduleUuid, toIndex: 1 });
		});

		it("renameModule", () => {
			expectRoundTrip({
				kind: "renameModule",
				uuid: moduleUuid,
				newId: "renamed",
			});
		});

		it("updateModule", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { name: "Updated", caseType: "patient" },
			});
		});
	});

	describe("form", () => {
		it("addForm", () => {
			expectRoundTrip({
				kind: "addForm",
				moduleUuid,
				form: form_,
			});
		});

		it("addForm with index", () => {
			expectRoundTrip({
				kind: "addForm",
				moduleUuid,
				form: form_,
				index: 0,
			});
		});

		it("removeForm", () => {
			expectRoundTrip({ kind: "removeForm", uuid: formUuid });
		});

		it("moveForm", () => {
			expectRoundTrip({
				kind: "moveForm",
				uuid: formUuid,
				toModuleUuid: otherModuleUuid,
				toIndex: 0,
			});
		});

		it("renameForm", () => {
			expectRoundTrip({
				kind: "renameForm",
				uuid: formUuid,
				newId: "checkup",
			});
		});

		it("updateForm", () => {
			expectRoundTrip({
				kind: "updateForm",
				uuid: formUuid,
				patch: { name: "New Name", type: "followup" },
			});
		});
	});

	describe("field", () => {
		it("addField", () => {
			expectRoundTrip({
				kind: "addField",
				parentUuid: formUuid,
				field: field_,
			});
		});

		it("addField with index", () => {
			expectRoundTrip({
				kind: "addField",
				parentUuid: formUuid,
				field: field_,
				index: 3,
			});
		});

		it("removeField", () => {
			expectRoundTrip({ kind: "removeField", uuid: fieldUuid });
		});

		it("moveField", () => {
			expectRoundTrip({
				kind: "moveField",
				uuid: fieldUuid,
				toParentUuid: otherFieldUuid,
				toIndex: 2,
			});
		});

		it("renameField", () => {
			expectRoundTrip({
				kind: "renameField",
				uuid: fieldUuid,
				newId: "full_name",
			});
		});

		it("duplicateField", () => {
			expectRoundTrip({ kind: "duplicateField", uuid: fieldUuid });
		});

		it("updateField", () => {
			expectRoundTrip({
				kind: "updateField",
				uuid: fieldUuid,
				patch: { label: "Updated Label", hint: "Enter name" },
			});
		});

		it("convertField", () => {
			expectRoundTrip({
				kind: "convertField",
				uuid: fieldUuid,
				toKind: "secret",
			});
		});
	});

	describe("app-level", () => {
		it("setAppName", () => {
			expectRoundTrip({ kind: "setAppName", name: "My App" });
		});

		it("setConnectType (learn)", () => {
			expectRoundTrip({ kind: "setConnectType", connectType: "learn" });
		});

		it("setConnectType (null)", () => {
			expectRoundTrip({ kind: "setConnectType", connectType: null });
		});

		it("setCaseTypes (non-empty)", () => {
			expectRoundTrip({
				kind: "setCaseTypes",
				caseTypes: [{ name: "patient", properties: [] }],
			});
		});

		it("setCaseTypes (null)", () => {
			expectRoundTrip({ kind: "setCaseTypes", caseTypes: null });
		});
	});

	it("rejects an unknown mutation kind", () => {
		const bad = { kind: "totallyMadeUp", uuid: moduleUuid };
		expect(() => mutationSchema.parse(bad)).toThrow();
	});
});
