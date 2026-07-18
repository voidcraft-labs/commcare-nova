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

		it("addModule with backward-compatible column surface orders", () => {
			const columnUuid = asUuid("66666666-6666-6666-6666-666666666666");
			expectRoundTrip({
				kind: "addModule",
				module: {
					...module_,
					caseListConfig: {
						columns: [
							{
								uuid: columnUuid,
								kind: "plain",
								field: "case_name",
								header: "Name",
								order: "generic-a",
							},
						],
						searchInputs: [],
					},
				},
				columnSurfaceOrders: [
					{ uuid: columnUuid, listOrder: "list-a", detailOrder: "detail-z" },
				],
			});
		});

		it("rejects an update-only Search patch on addModule", () => {
			expect(
				mutationSchema.safeParse({
					kind: "addModule",
					module: module_,
					caseSearchConfigPatch: { searchScreenTitle: "Find cases" },
				}).success,
			).toBe(false);
		});

		it("rejects owner-only addModule state that disagrees with its fallback", () => {
			expect(
				mutationSchema.safeParse({
					kind: "addModule",
					module: {
						...module_,
						caseSearchConfig: {
							excludedOwnerIds: {
								kind: "term",
								term: { kind: "literal", value: "owner-b" },
							},
							searchButtonDisplayCondition: { kind: "match-none" },
						},
					},
					caseSearchConfigValue: {
						searchActionEnabled: false,
						excludedOwnerIds: {
							kind: "term",
							term: { kind: "literal", value: "owner-a" },
						},
					},
				}).success,
			).toBe(false);
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

		// Empty patches must round-trip — the agent can emit updateModule
		// with `{}` when coalescing no-op edits, and tightening the schema
		// to require non-empty patches would silently drop those events.
		it("updateModule with empty patch", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {},
			});
		});

		it("updateModule with a backward-compatible case-list ensure", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseListConfig: { columns: [], searchInputs: [] } },
				ensureCaseListConfig: true,
			});
		});

		it("updateModule carries full-config surface orders outside its strict legacy patch", () => {
			const columnUuid = asUuid("66666666-6666-6666-6666-666666666666");
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {
					caseListConfig: {
						columns: [
							{
								uuid: columnUuid,
								kind: "plain",
								field: "case_name",
								header: "Name",
								order: "generic-a",
							},
						],
						searchInputs: [],
					},
				},
				columnSurfaceOrders: [
					{ uuid: columnUuid, listOrder: "list-a", detailOrder: "detail-z" },
				],
			});
		});

		it("rejects current-only surface orders nested in a full module patch", () => {
			expect(
				mutationSchema.safeParse({
					kind: "updateModule",
					uuid: moduleUuid,
					patch: {
						caseListConfig: {
							columns: [
								{
									uuid: asUuid("66666666-6666-6666-6666-666666666666"),
									kind: "plain",
									field: "case_name",
									header: "Name",
									listOrder: "nested-new-key",
								},
							],
							searchInputs: [],
						},
					},
				}).success,
			).toBe(false);
		});

		it("rejects a case-list ensure without its legacy empty fallback", () => {
			expect(
				mutationSchema.safeParse({
					kind: "updateModule",
					uuid: moduleUuid,
					patch: {},
					ensureCaseListConfig: true,
				}).success,
			).toBe(false);
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

		// See updateModule — empty patches are a valid coalesced-no-op shape.
		it("updateForm with empty patch", () => {
			expectRoundTrip({
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
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
				targetKind: "text",
				patch: { label: "Updated Label", hint: "Enter name" },
			});
		});

		// See updateModule — empty patches are a valid coalesced-no-op shape.
		it("updateField with empty patch", () => {
			expectRoundTrip({
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: {},
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

	describe("case-list column surface order", () => {
		const columnUuid = asUuid("66666666-6666-6666-6666-666666666666");
		const column = {
			uuid: columnUuid,
			kind: "plain" as const,
			field: "case_name",
			header: "Name",
		};

		it("addColumn carries surface orders outside its strict legacy fallback", () => {
			expectRoundTrip({
				kind: "addColumn",
				moduleUuid,
				column,
				surfaceOrders: { listOrder: "list-a", detailOrder: "detail-z" },
			});
		});

		it("rejects add/update fallbacks with nested current-only surface keys", () => {
			for (const kind of ["addColumn", "updateColumn"] as const) {
				expect(
					mutationSchema.safeParse({
						kind,
						moduleUuid,
						...(kind === "updateColumn" && { uuid: columnUuid }),
						column: { ...column, listOrder: "nested" },
					}).success,
				).toBe(false);
			}
		});

		it("updateColumn with the legacy full-body shape", () => {
			expectRoundTrip({
				kind: "updateColumn",
				moduleUuid,
				uuid: columnUuid,
				column,
			});
		});

		it("updateColumn with content visibility and sort preservation", () => {
			expectRoundTrip({
				kind: "updateColumn",
				moduleUuid,
				uuid: columnUuid,
				column,
				preserveVisibility: true,
				preserveSort: true,
			});
		});

		it("updateColumn with a backward-compatible sort patch", () => {
			expectRoundTrip({
				kind: "updateColumn",
				moduleUuid,
				uuid: columnUuid,
				column: {
					...column,
					sort: { direction: "desc", priority: 1 },
				},
				sortPatch: { direction: "desc", priority: 1 },
			});
		});

		it("rejects a sort patch that contradicts its fallback", () => {
			expect(
				mutationSchema.safeParse({
					kind: "updateColumn",
					moduleUuid,
					uuid: columnUuid,
					column: { ...column, sort: { direction: "asc", priority: 0 } },
					sortPatch: { direction: "desc", priority: 0 },
				}).success,
			).toBe(false);
		});

		it("updateColumn with a backward-compatible visibility patch", () => {
			expectRoundTrip({
				kind: "updateColumn",
				moduleUuid,
				uuid: columnUuid,
				column: { ...column, visibleInList: false },
				visibilityPatch: { surface: "list", visible: false },
			});
		});

		it("rejects a visibility patch combined with content preservation", () => {
			expect(
				mutationSchema.safeParse({
					kind: "updateColumn",
					moduleUuid,
					uuid: columnUuid,
					column: { ...column, visibleInList: false },
					preserveVisibility: true,
					visibilityPatch: { surface: "list", visible: false },
				}).success,
			).toBe(false);
		});

		it.each([
			"list",
			"detail",
		] as const)("rejects a %s visibility patch that contradicts its fallback column", (surface) => {
			expect(
				mutationSchema.safeParse({
					kind: "updateColumn",
					moduleUuid,
					uuid: columnUuid,
					column,
					visibilityPatch: { surface, visible: false },
				}).success,
			).toBe(false);
		});

		it("moveColumn with a Results surface patch", () => {
			expectRoundTrip({
				kind: "moveColumn",
				moduleUuid,
				uuid: columnUuid,
				order: "list-a",
				surfaceOrderPatch: { surface: "list", order: "list-a" },
			});
		});

		it("moveColumn clears a Results override with a generic fallback", () => {
			expectRoundTrip({
				kind: "moveColumn",
				moduleUuid,
				uuid: columnUuid,
				order: "generic-a",
				surfaceOrderPatch: { surface: "list", order: null },
			});
		});

		it("moveColumn with a Details surface patch", () => {
			expectRoundTrip({
				kind: "moveColumn",
				moduleUuid,
				uuid: columnUuid,
				order: "detail-z",
				surfaceOrderPatch: { surface: "detail", order: "detail-z" },
			});
		});

		it("moveColumn clears a Details override with a generic fallback", () => {
			expectRoundTrip({
				kind: "moveColumn",
				moduleUuid,
				uuid: columnUuid,
				order: "generic-z",
				surfaceOrderPatch: { surface: "detail", order: null },
			});
		});

		it("rejects a surface patch that disagrees with its legacy fallback", () => {
			expect(
				mutationSchema.safeParse({
					kind: "moveColumn",
					moduleUuid,
					uuid: columnUuid,
					order: "legacy-a",
					surfaceOrderPatch: { surface: "list", order: "semantic-z" },
				}).success,
			).toBe(false);
		});
	});

	describe("case-search semantic operations", () => {
		const ownerRule = {
			kind: "term" as const,
			term: { kind: "literal" as const, value: "owner-a" },
		};

		it("enables with an origin-compatible fallback", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseSearchConfig: {} },
				caseSearchConfigOperation: "enable",
			});
		});

		it("conditionally disables with a null fallback", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseSearchConfig: null },
				caseSearchConfigOperation: "disable-if-unused",
			});
		});

		it("conditionally removes a cleared Search bag with a null fallback", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseSearchConfig: null },
				caseSearchConfigOperation: "remove-if-no-authored-settings",
			});
		});

		it("cleans up the final input with an owner-only legacy fallback", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {
					caseSearchConfig: {
						excludedOwnerIds: ownerRule,
						searchButtonDisplayCondition: { kind: "match-none" },
					},
				},
				caseSearchConfigOperation: "cleanup-after-final-input",
			});
		});

		it("stores owner-only state outside the strict legacy patch", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: {
					caseSearchConfig: {
						excludedOwnerIds: ownerRule,
						searchButtonDisplayCondition: { kind: "match-none" },
					},
				},
				caseSearchConfigOperation: "set-owner-only",
				caseSearchConfigValue: {
					searchActionEnabled: false,
					excludedOwnerIds: ownerRule,
				},
			});
		});

		it("merges one Search setting with an agreeing legacy snapshot", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseSearchConfig: { searchScreenTitle: "Find cases" } },
				caseSearchConfigPatch: { searchScreenTitle: "Find cases" },
			});
		});

		it("clears one Search setting with an agreeing null fallback", () => {
			expectRoundTrip({
				kind: "updateModule",
				uuid: moduleUuid,
				patch: { caseSearchConfig: null },
				caseSearchConfigPatch: { excludedOwnerIds: null },
			});
		});

		it("rejects a Search setting patch that contradicts its fallback", () => {
			expect(
				mutationSchema.safeParse({
					kind: "updateModule",
					uuid: moduleUuid,
					patch: { caseSearchConfig: { searchScreenTitle: "Old fallback" } },
					caseSearchConfigPatch: { searchScreenTitle: "New semantic" },
				}).success,
			).toBe(false);
		});

		it("rejects owner-only settings that disagree with the fallback", () => {
			expect(
				mutationSchema.safeParse({
					kind: "updateModule",
					uuid: moduleUuid,
					patch: {
						caseSearchConfig: {
							excludedOwnerIds: {
								kind: "term",
								term: { kind: "literal", value: "owner-b" },
							},
							searchButtonDisplayCondition: { kind: "match-none" },
						},
					},
					caseSearchConfigOperation: "set-owner-only",
					caseSearchConfigValue: {
						searchActionEnabled: false,
						excludedOwnerIds: ownerRule,
					},
				}).success,
			).toBe(false);
		});

		it("rejects the private intent bit inside any legacy patch", () => {
			expect(
				mutationSchema.safeParse({
					kind: "updateModule",
					uuid: moduleUuid,
					patch: {
						caseSearchConfig: {
							searchActionEnabled: false,
							excludedOwnerIds: ownerRule,
						},
					},
				}).success,
			).toBe(false);
		});
	});

	describe("Search-input rename compatibility", () => {
		const inputUuid = asUuid("77777777-7777-4777-8777-777777777777");

		it("carries the desired name outside the origin-compatible row", () => {
			expectRoundTrip({
				kind: "updateSearchInput",
				moduleUuid,
				uuid: inputUuid,
				searchInput: {
					uuid: inputUuid,
					kind: "simple",
					name: "old_name",
					label: "Name",
					type: "text",
					property: "case_name",
				},
				renamedTo: "new_name",
			});
		});

		it("rejects a rename extension identical to its fallback", () => {
			expect(
				mutationSchema.safeParse({
					kind: "updateSearchInput",
					moduleUuid,
					uuid: inputUuid,
					searchInput: {
						uuid: inputUuid,
						kind: "simple",
						name: "same_name",
						label: "Name",
						type: "text",
						property: "case_name",
					},
					renamedTo: "same_name",
				}).success,
			).toBe(false);
		});
	});

	it("rejects an unknown mutation kind", () => {
		const bad = { kind: "totallyMadeUp", uuid: moduleUuid };
		expect(() => mutationSchema.parse(bad)).toThrow();
	});
});
