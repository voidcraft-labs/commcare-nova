import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	authoredBlueprintIdentities,
	entryPointInventory,
	suggestEntryPointId,
} from "@/lib/domain";
import { diffDocsToMutations } from "../diffDocsToMutations";
import {
	planEntryPointAdd,
	planEntryPointUpdate,
} from "../entryPointMutations";
import { applyMutations } from "../mutations";
import { mutationTargetsInvalid } from "../mutationTargetAdmission";
import { type Mutation, mutationSchema } from "../types";

const fixture = () =>
	buildDoc({
		appName: "Links",
		modules: [
			{
				uuid: "module",
				name: "Visits",
				forms: [{ uuid: "form", name: "Survey", type: "survey", fields: [] }],
			},
		],
	});
const target = {
	kind: "form",
	moduleUuid: testUuid("module"),
	formUuid: testUuid("form"),
} as const;
const entryPoint = { uuid: testUuid("endpoint"), id: "survey" };
const add: Mutation = { kind: "addEntryPoint", target, entryPoint };
const apply = (
	doc: ReturnType<typeof fixture>,
	mutations: readonly Mutation[],
) =>
	produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
describe("owned entry-point mutations", () => {
	it("replays granular add, edit, clear and undo without replacing the owner", () => {
		const doc = fixture(),
			added = apply(doc, [add]);
		const edited = apply(added, [
			{
				kind: "updateEntryPoint",
				entryPointUuid: entryPoint.uuid,
				patch: { id: "visit", ignoreDisplayConditions: true },
			},
		]);
		expect(entryPointInventory(edited)[0].entryPoint).toEqual({
			...entryPoint,
			id: "visit",
			ignoreDisplayConditions: true,
		});
		const diff = diffDocsToMutations(added, edited);
		expect(diff).toEqual([
			{
				kind: "updateEntryPoint",
				entryPointUuid: entryPoint.uuid,
				patch: { id: "visit", ignoreDisplayConditions: true },
			},
		]);
		expect(
			entryPointInventory(apply(edited, diffDocsToMutations(edited, doc))),
		).toEqual([]);
		expect(authoredBlueprintIdentities(added)).toContainEqual({
			uuid: entryPoint.uuid,
			kind: "entryPoint",
			ownerUuid: target.formUuid,
		});
		expect(suggestEntryPointId(added, target)).toBe("visits_survey");
	});
	it("refuses peer-deleted targets, singleton collisions and foreign owner references", () => {
		const doc = fixture();
		expect(mutationTargetsInvalid(doc, [add, add])).toBe(true);
		expect(
			mutationTargetsInvalid(doc, [
				{
					kind: "updateEntryPoint",
					entryPointUuid: entryPoint.uuid,
					patch: { id: "new" },
				},
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(doc, [
				{ ...add, target: { ...target, moduleUuid: testUuid("foreign") } },
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(doc, [
				add,
				{ kind: "removeEntryPoint", entryPointUuid: entryPoint.uuid },
			]),
		).toBe(false);
	});
	it("tracks same-batch owner birth and deletion, and refuses identity reuse", () => {
		const doc = fixture();
		const born: Mutation = {
			kind: "addForm",
			moduleUuid: target.moduleUuid,
			form: {
				uuid: testUuid("born"),
				id: "born",
				name: "Born",
				type: "survey",
			},
		};
		expect(
			mutationTargetsInvalid(doc, [
				born,
				{ ...add, target: { ...target, formUuid: testUuid("born") } },
			]),
		).toBe(false);
		expect(
			mutationTargetsInvalid(doc, [
				add,
				{ kind: "removeForm", uuid: target.formUuid },
				{
					kind: "updateEntryPoint",
					entryPointUuid: entryPoint.uuid,
					patch: { id: "changed" },
				},
			]),
		).toBe(true);
		expect(
			mutationTargetsInvalid(doc, [
				{ ...add, entryPoint: { ...entryPoint, uuid: target.moduleUuid } },
			]),
		).toBe(true);
	});
	it("clears visibility bypass durably and refuses immutable UUID patches", () => {
		const doc = apply(fixture(), [
			{ ...add, entryPoint: { ...entryPoint, ignoreDisplayConditions: true } },
		]);
		const clear: Mutation = {
			kind: "updateEntryPoint",
			entryPointUuid: entryPoint.uuid,
			patch: { ignoreDisplayConditions: null },
		};
		const next = apply(doc, [JSON.parse(JSON.stringify(clear))]);
		expect(entryPointInventory(next)[0].entryPoint).toEqual(entryPoint);
		expect(
			mutationSchema.safeParse({
				kind: "updateEntryPoint",
				entryPointUuid: entryPoint.uuid,
				patch: { uuid: testUuid("other") },
			}).success,
		).toBe(false);
	});

	it("refuses raw generic slot writes and invalid or reused external IDs", () => {
		const doc = fixture();
		expect(
			mutationSchema.safeParse({
				kind: "updateForm",
				uuid: target.formUuid,
				patch: { entryPoint },
			}).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse({
				kind: "updateModule",
				uuid: target.moduleUuid,
				patch: { caseListEntryPoint: entryPoint },
			}).success,
		).toBe(false);
		expect(
			planEntryPointAdd(doc, target, { ...entryPoint, id: " Bad ID " }),
		).toMatchObject({ ok: false });
		const added = apply(doc, [add]);
		expect(
			planEntryPointAdd(
				added,
				{ kind: "module", moduleUuid: target.moduleUuid },
				{ uuid: testUuid("second"), id: "survey" },
			),
		).toMatchObject({ ok: false });
		expect(
			planEntryPointUpdate(added, entryPoint.uuid, {
				ignoreDisplayConditions: null,
			}),
		).toMatchObject({ ok: true });
	});
});
