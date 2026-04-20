import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain";
import { formUuidByIds, makeDoc } from "./makeDoc";

// ── Core invariants (from the plan) ─────────────────────────────────

describe("makeDoc fixture builder", () => {
	it("produces a BlueprintDoc with correct orderings", () => {
		const doc = makeDoc({
			appId: "app-1",
			appName: "Test App",
			modules: [
				{
					id: "registration",
					name: "Registration",
					caseType: "patient",
					forms: [
						{
							id: "register",
							name: "Register",
							type: "registration",
							fields: [
								{
									kind: "text",
									id: "name",
									label: "Name",
									required: "true()",
									case_property: "patient",
								},
							],
						},
					],
				},
			],
		});

		expect(doc.moduleOrder).toHaveLength(1);
		const [moduleUuid] = doc.moduleOrder;
		expect(doc.modules[moduleUuid].id).toBe("registration");

		const [formUuid] = doc.formOrder[moduleUuid];
		expect(doc.forms[formUuid].id).toBe("register");

		const [fieldUuid] = doc.fieldOrder[formUuid];
		expect(doc.fields[fieldUuid]).toMatchObject({
			kind: "text",
			id: "name",
			label: "Name",
			required: "true()",
			case_property: "patient",
		});
		expect(doc.fieldParent[fieldUuid]).toBe(formUuid);
	});

	it("nests group / repeat fields via their children key", () => {
		const doc = makeDoc({
			appId: "app",
			appName: "App",
			modules: [
				{
					id: "m",
					name: "m",
					forms: [
						{
							id: "f",
							name: "f",
							type: "survey",
							fields: [
								{
									kind: "group",
									id: "address",
									label: "Address",
									children: [{ kind: "text", id: "street", label: "Street" }],
								},
							],
						},
					],
				},
			],
		});

		const form = doc.formOrder[doc.moduleOrder[0]][0];
		const group = doc.fieldOrder[form][0];
		expect(doc.fields[group].kind).toBe("group");

		const child = doc.fieldOrder[group][0];
		expect(doc.fields[child]).toMatchObject({ kind: "text", id: "street" });
		expect(doc.fieldParent[child]).toBe(group);
	});

	it("mints deterministic uuids for readable snapshots if seed provided", () => {
		const a = makeDoc({ appId: "a", appName: "a", modules: [], seed: 42 });
		const b = makeDoc({ appId: "a", appName: "a", modules: [], seed: 42 });
		expect(a).toEqual(b);
	});

	// ── Additional edge cases ─────────────────────────────────────────

	it("builds an empty doc when no modules are provided", () => {
		const doc = makeDoc({ appId: "empty", appName: "Empty", modules: [] });
		expect(doc.appId).toBe("empty");
		expect(doc.appName).toBe("Empty");
		expect(doc.moduleOrder).toEqual([]);
		expect(doc.modules).toEqual({});
		expect(doc.forms).toEqual({});
		expect(doc.fields).toEqual({});
		expect(doc.formOrder).toEqual({});
		expect(doc.fieldOrder).toEqual({});
		expect(doc.fieldParent).toEqual({});
		expect(doc.connectType).toBeNull();
		expect(doc.caseTypes).toBeNull();
	});

	it("passes connectType and caseTypes through verbatim", () => {
		const caseTypes = [
			{
				name: "patient",
				properties: [{ name: "age", label: "Age" }],
			},
		];
		const doc = makeDoc({
			appId: "connect",
			appName: "Connect",
			connectType: "learn",
			caseTypes,
			modules: [],
		});

		expect(doc.connectType).toBe("learn");
		expect(doc.caseTypes).toEqual(caseTypes);
	});

	it("honors caller-supplied uuids on modules, forms, and fields", () => {
		const moduleUuid = "00000000-0000-4000-8000-00000000aaaa";
		const formUuid = "00000000-0000-4000-8000-00000000bbbb";
		const fieldUuid = "00000000-0000-4000-8000-00000000cccc";

		const doc = makeDoc({
			appId: "app",
			appName: "App",
			modules: [
				{
					uuid: moduleUuid,
					id: "m",
					name: "M",
					forms: [
						{
							uuid: formUuid,
							id: "f",
							name: "F",
							type: "survey",
							fields: [
								{
									uuid: fieldUuid,
									kind: "text",
									id: "q",
									label: "Q",
								},
							],
						},
					],
				},
			],
		});

		/*
		 * Caller-supplied uuids survive as the branded Uuid keys throughout
		 * the entity maps and ordering arrays. The minted counter is not
		 * consulted for these entities — callers get the exact uuids they
		 * asked for.
		 */
		expect(doc.moduleOrder).toContain(asUuid(moduleUuid));
		expect(doc.formOrder[asUuid(moduleUuid)]).toContain(asUuid(formUuid));
		expect(doc.fieldOrder[asUuid(formUuid)]).toContain(asUuid(fieldUuid));
		expect(doc.modules[asUuid(moduleUuid)].uuid).toBe(moduleUuid);
		expect(doc.forms[asUuid(formUuid)].uuid).toBe(formUuid);
		expect(doc.fields[asUuid(fieldUuid)].uuid).toBe(fieldUuid);
	});

	it("recurses into repeat containers and records fieldParent for each child", () => {
		const doc = makeDoc({
			appId: "app",
			appName: "App",
			modules: [
				{
					id: "m",
					name: "m",
					forms: [
						{
							id: "f",
							name: "f",
							type: "survey",
							fields: [
								{
									kind: "repeat",
									id: "visits",
									label: "Visits",
									children: [
										{ kind: "date", id: "visit_date", label: "Visit date" },
										{ kind: "text", id: "notes", label: "Notes" },
									],
								},
							],
						},
					],
				},
			],
		});

		const form = doc.formOrder[doc.moduleOrder[0]][0];
		const repeat = doc.fieldOrder[form][0];
		expect(doc.fields[repeat].kind).toBe("repeat");

		const children = doc.fieldOrder[repeat];
		expect(children).toHaveLength(2);
		for (const childUuid of children) {
			expect(doc.fieldParent[childUuid]).toBe(repeat);
		}
	});
});

// ── formUuidByIds helper ────────────────────────────────────────────

describe("formUuidByIds", () => {
	const doc = makeDoc({
		appId: "app",
		appName: "App",
		modules: [
			{
				id: "reg",
				name: "Reg",
				forms: [
					{
						id: "register",
						name: "Register",
						type: "registration",
						fields: [],
					},
				],
			},
			{
				id: "visit",
				name: "Visit",
				forms: [
					{ id: "checkup", name: "Checkup", type: "followup", fields: [] },
				],
			},
		],
	});

	it("returns the form uuid for a module/form id pair", () => {
		const uuid = formUuidByIds(doc, "visit", "checkup");
		expect(doc.forms[uuid].id).toBe("checkup");
	});

	it("throws when the module id is unknown", () => {
		expect(() => formUuidByIds(doc, "nope", "checkup")).toThrow(/module/);
	});

	it("throws when the form id is not in that module", () => {
		expect(() => formUuidByIds(doc, "reg", "checkup")).toThrow(/form/);
	});
});
