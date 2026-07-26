// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { useCaseOperations } from "@/lib/doc/hooks/useCaseOperations";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid, mutationSchema } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type CaseOperation,
	type LookupColumnId,
	type LookupTableId,
	orderedCaseOperations,
} from "@/lib/domain";
import { eq, literal, tableColumn, term } from "@/lib/domain/predicate";

const OPERATION = asUuid("10000000-0000-4000-8000-000000000001");
const SECOND = asUuid("10000000-0000-4000-8000-000000000002");
const THIRD = asUuid("10000000-0000-4000-8000-000000000003");
const PEER = asUuid("10000000-0000-4000-8000-000000000004");
const TABLE = "018f3e8a-7b2c-7def-8abc-1234567890ab" as LookupTableId;
const COLUMN = "018f3e8a-7b2c-7def-8abc-1234567890ad" as LookupColumnId;

function operation(
	uuid: ReturnType<typeof asUuid>,
	id: string,
	order: string,
): CaseOperation {
	return {
		uuid,
		id,
		order,
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property: "nickname", value: term(literal(id)) }],
	};
}

function fixture(
	operations: readonly CaseOperation[] = [operation(OPERATION, "first", "a")],
): {
	readonly doc: BlueprintDoc;
	readonly formUuid: ReturnType<typeof asUuid>;
} {
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "nickname", label: "Nickname", data_type: "text" },
					{ name: "note", label: "Note", data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [{ name: "Edit", type: "followup" }],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	doc.forms[formUuid].caseOperations = [...operations];
	return { doc, formUuid };
}

function mount(doc: BlueprintDoc, formUuid: ReturnType<typeof asUuid>) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocProvider appId={doc.appId} initialDoc={doc}>
			{children}
		</BlueprintDocProvider>
	);
	return renderHook(
		() => ({
			view: useCaseOperations(formUuid),
			api: useBlueprintDocApi(),
		}),
		{ wrapper },
	);
}

describe("useCaseOperations invocation-time concurrency", () => {
	it("refuses a carrier-bearing edit before the autosave diff can form a rolling-invalid PUT", () => {
		const { doc, formUuid } = fixture();
		const carrier = operation(OPERATION, "carrier", "a");
		carrier.condition = eq(tableColumn(TABLE, COLUMN), literal("enabled"));
		doc.forms[formUuid].caseOperations = [carrier];
		const { result } = mount(doc, formUuid);
		const before = result.current.api.getState();

		let outcome: ReturnType<typeof result.current.view.update> | undefined;
		act(() => {
			outcome = result.current.view.update({ ...carrier, id: "renamed" });
		});

		expect(outcome).toEqual({
			ok: false,
			messages: [
				"This case change uses lookup-table logic that Nova preserves but cannot safely edit from this surface.",
			],
		});
		const after = result.current.api.getState();
		expect(after).toEqual(before);
		const putMutations = diffDocsToMutations(before, after);
		expect(putMutations).toEqual([]);
		expect(
			mutationSchema.array().safeParse(JSON.parse(JSON.stringify(putMutations)))
				.success,
		).toBe(true);
	});

	it("moves a carrier-bearing operation through the actual carrier-blind autosave envelope", () => {
		const carrier = operation(OPERATION, "carrier", "a");
		carrier.condition = eq(tableColumn(TABLE, COLUMN), literal("enabled"));
		const { doc, formUuid } = fixture([
			carrier,
			operation(SECOND, "second", "c"),
		]);
		const { result } = mount(doc, formUuid);
		const before = result.current.api.getState();

		let outcome: ReturnType<typeof result.current.view.move> | undefined;
		act(() => {
			outcome = result.current.view.move(OPERATION, 1);
		});

		expect(outcome).toEqual({ ok: true, index: 1, total: 2 });
		const after = result.current.api.getState();
		expect(
			after.forms[formUuid].caseOperations?.find(
				(candidate) => candidate.uuid === OPERATION,
			)?.condition,
		).toEqual(carrier.condition);
		const putMutations = diffDocsToMutations(before, after);
		expect(putMutations).toEqual([
			expect.objectContaining({
				kind: "updateForm",
				caseOperationChange: expect.objectContaining({
					operation: "move",
					uuid: OPERATION,
				}),
				caseOperationPatch: expect.objectContaining({
					operation: "move",
					uuid: OPERATION,
					index: 1,
				}),
			}),
		]);
		const serialized = JSON.stringify(putMutations);
		expect(serialized).not.toContain("table-column");
		expect(serialized).not.toContain("table-lookup");
		expect(
			mutationSchema.array().safeParse(JSON.parse(serialized)).success,
		).toBe(true);
	});

	it("rejects stale deletes and same-key additions instead of reporting a no-op success", () => {
		const { doc, formUuid } = fixture();
		const deleted = mount(doc, formUuid);
		const staleDeleteView = deleted.result.current.view;
		act(() => {
			deleted.result.current.api.getState().applyMany([
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: {},
					caseOperationChange: { operation: "remove", uuid: OPERATION },
				},
			]);
		});
		let deletedOutcome: ReturnType<typeof staleDeleteView.update> | undefined;
		act(() => {
			deletedOutcome = staleDeleteView.update({
				...operation(OPERATION, "first", "a"),
				id: "mine",
			});
		});
		expect(deletedOutcome).toMatchObject({ ok: false });
		expect(
			deleted.result.current.api.getState().forms[formUuid].caseOperations,
		).toBeUndefined();

		const collided = mount(doc, formUuid);
		const staleCollisionView = collided.result.current.view;
		const peerVersion = operation(OPERATION, "first", "a");
		peerVersion.writes = [
			...(peerVersion.writes ?? []),
			{ property: "note", value: term(literal("peer")) },
		];
		act(() => {
			collided.result.current.api.getState().applyMany([
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: {},
					caseOperationChange: {
						operation: "update",
						uuid: OPERATION,
						value: peerVersion,
					},
				},
			]);
		});
		const mine = operation(OPERATION, "first", "a");
		mine.writes = [
			...(mine.writes ?? []),
			{ property: "note", value: term(literal("mine")) },
		];
		let collisionOutcome:
			| ReturnType<typeof staleCollisionView.update>
			| undefined;
		act(() => {
			collisionOutcome = staleCollisionView.update(mine);
		});
		expect(collisionOutcome).toMatchObject({ ok: false });
		expect(
			collided.result.current.api.getState().forms[formUuid].caseOperations?.[0]
				?.writes,
		).toEqual(peerVersion.writes);
	});

	it("composes an unrelated peer member and replans a move at the requested fresh rank", () => {
		const { doc, formUuid } = fixture([
			operation(OPERATION, "first", "a"),
			operation(SECOND, "second", "c"),
			operation(THIRD, "third", "e"),
		]);
		const { result } = mount(doc, formUuid);
		const staleView = result.current.view;
		const firstWithPeerWrite = operation(OPERATION, "first", "a");
		firstWithPeerWrite.writes = [
			...(firstWithPeerWrite.writes ?? []),
			{ property: "note", value: term(literal("peer")) },
		];
		act(() => {
			result.current.api.getState().applyMany([
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: {},
					caseOperationChange: {
						operation: "update",
						uuid: OPERATION,
						value: firstWithPeerWrite,
					},
				},
				{
					kind: "updateForm",
					uuid: formUuid,
					patch: {},
					caseOperationChange: {
						operation: "add",
						value: operation(PEER, "peer", "b"),
					},
				},
			]);
		});

		let updateOutcome: ReturnType<typeof staleView.update> | undefined;
		act(() => {
			updateOutcome = staleView.update({
				...operation(OPERATION, "first", "a"),
				id: "renamed",
			});
		});
		expect(updateOutcome).toEqual({ ok: true });
		expect(
			result.current.api
				.getState()
				.forms[formUuid].caseOperations?.find(
					(candidate) => candidate.uuid === OPERATION,
				),
		).toMatchObject({
			id: "renamed",
			writes: expect.arrayContaining([
				expect.objectContaining({ property: "note" }),
			]),
		});

		let moveOutcome: ReturnType<typeof staleView.move> | undefined;
		act(() => {
			moveOutcome = staleView.move(THIRD, 1);
		});
		expect(moveOutcome).toEqual({ ok: true, index: 1, total: 4 });
		expect(
			orderedCaseOperations(result.current.api.getState().forms[formUuid]).map(
				(candidate) => candidate.uuid,
			),
		).toEqual([OPERATION, THIRD, PEER, SECOND]);
	});
});
