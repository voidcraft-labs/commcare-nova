// @vitest-environment happy-dom

/**
 * useFormRows integration tests — verify subscription shape, memoization,
 * and freeze-on-drag behavior against a real BlueprintDoc store.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import type { FormRow } from "../rowModel";
import { EMPTY_COLLAPSE, useFormRows } from "../useFormRows";

// ── Setup ──────────────────────────────────────────────────────────────

function setup() {
	const store = createBlueprintDocStore();
	const bp: AppBlueprint = {
		app_name: "Rows Test",
		connect_type: undefined,
		modules: [
			{
				uuid: "module-1-0000-0000-0000-000000000000",
				name: "M",
				forms: [
					{
						uuid: "form-1-0000-0000-0000-000000000001",
						name: "F",
						type: "registration",
						questions: [
							{
								uuid: "qst-a-0000-0000-0000-000000000001",
								id: "a",
								type: "text",
								label: "A",
							},
							{
								uuid: "qst-b-0000-0000-0000-000000000002",
								id: "b",
								type: "text",
								label: "B",
							},
						],
					},
				],
			},
		],
		case_types: null,
	};
	store.getState().load(bp, "app-rows");
	const moduleUuid = store.getState().moduleOrder[0];
	const formUuid = store.getState().formOrder[moduleUuid][0];
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper, formUuid };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("useFormRows", () => {
	it("returns live rows that reflect the doc state", () => {
		const { wrapper, formUuid } = setup();
		const { result } = renderHook(
			() =>
				useFormRows({
					formUuid,
					includeInsertionPoints: true,
					collapsed: EMPTY_COLLAPSE,
					frozen: false,
				}),
			{ wrapper },
		);
		const kinds = result.current.map((r) => r.kind);
		// ins(0), q(a), ins(1), q(b), ins(2)
		expect(kinds).toEqual([
			"insertion",
			"question",
			"insertion",
			"question",
			"insertion",
		]);
	});

	it("updates when questions are added to the form", () => {
		const { store, wrapper, formUuid } = setup();
		const { result } = renderHook(
			() =>
				useFormRows({
					formUuid,
					includeInsertionPoints: false,
					collapsed: EMPTY_COLLAPSE,
					frozen: false,
				}),
			{ wrapper },
		);
		expect(result.current.filter((r) => r.kind === "question")).toHaveLength(2);

		act(() => {
			store.getState().apply({
				kind: "addQuestion",
				parentUuid: formUuid,
				question: {
					uuid: asUuid("qst-c-0000-0000-0000-000000000003"),
					id: "c",
					type: "text",
				},
			});
		});
		expect(result.current.filter((r) => r.kind === "question")).toHaveLength(3);
	});

	it("freezes the row array identity while frozen=true, releases on false", () => {
		const { store, wrapper, formUuid } = setup();
		const { result, rerender } = renderHook(
			(props: { frozen: boolean }) =>
				useFormRows({
					formUuid,
					includeInsertionPoints: false,
					collapsed: EMPTY_COLLAPSE,
					frozen: props.frozen,
				}),
			{ wrapper, initialProps: { frozen: false } },
		);
		const liveBefore = result.current;

		// Freeze — subsequent reads should return the captured array even
		// if the doc changes in the meantime.
		rerender({ frozen: true });
		const frozenRef: FormRow[] = result.current;
		expect(frozenRef).toBe(liveBefore);

		act(() => {
			store.getState().apply({
				kind: "addQuestion",
				parentUuid: formUuid,
				question: {
					uuid: asUuid("qst-d-0000-0000-0000-000000000004"),
					id: "d",
					type: "text",
				},
			});
		});
		// Still frozen — identity preserved, length unchanged.
		expect(result.current).toBe(frozenRef);
		expect(result.current.filter((r) => r.kind === "question")).toHaveLength(2);

		// Release — live rows now reflect the new question.
		rerender({ frozen: false });
		expect(result.current).not.toBe(frozenRef);
		expect(result.current.filter((r) => r.kind === "question")).toHaveLength(3);
	});

	it("captures rows on first render when initially frozen=true", () => {
		// Pins the edge case where a component mounts during an in-flight
		// drag. The initial liveRows are captured on the first render and
		// must be preserved while frozen, ignoring any store mutations.
		const { store, wrapper, formUuid } = setup();
		const { result } = renderHook(
			() =>
				useFormRows({
					formUuid,
					includeInsertionPoints: false,
					collapsed: EMPTY_COLLAPSE,
					frozen: true,
				}),
			{ wrapper },
		);
		const initial = result.current;
		act(() => {
			store.getState().apply({
				kind: "addQuestion",
				parentUuid: formUuid,
				question: {
					uuid: asUuid("qst-e-0000-0000-0000-000000000005"),
					id: "e",
					type: "text",
				},
			});
		});
		expect(result.current).toBe(initial);
		expect(result.current.filter((r) => r.kind === "question")).toHaveLength(2);
	});

	it("recomputes when the collapsed set reference changes", () => {
		const { store, wrapper } = setup();
		// Add a group + child so collapse has something to act on.
		const formUuid =
			store.getState().formOrder[store.getState().moduleOrder[0]][0];
		const groupUuid = asUuid("grp-x-0000-0000-0000-000000000009");
		const childUuid = asUuid("qst-z-0000-0000-0000-00000000000a");
		act(() => {
			store.getState().applyMany([
				{
					kind: "addQuestion",
					parentUuid: formUuid,
					question: { uuid: groupUuid, id: "sec", type: "group" },
				},
				{
					kind: "addQuestion",
					parentUuid: groupUuid,
					question: { uuid: childUuid, id: "z", type: "text" },
				},
			]);
		});

		const { result, rerender } = renderHook(
			(props: { collapsed: Set<Uuid> }) =>
				useFormRows({
					formUuid,
					includeInsertionPoints: false,
					collapsed: props.collapsed,
					frozen: false,
				}),
			{ wrapper, initialProps: { collapsed: new Set<Uuid>() } },
		);
		// Group is expanded — all 3 question rows present (form's A + B,
		// plus group's child z).
		expect(result.current.filter((r) => r.kind === "question")).toHaveLength(3);

		rerender({ collapsed: new Set([groupUuid]) });
		// Group is collapsed — child is gone, only bracket rows remain.
		expect(result.current.filter((r) => r.kind === "question")).toHaveLength(2);
		expect(
			result.current.filter(
				(r) => r.kind === "group-open" || r.kind === "group-close",
			),
		).toHaveLength(2);
	});
});
