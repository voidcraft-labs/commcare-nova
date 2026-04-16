// @vitest-environment happy-dom

/**
 * useFormRows integration tests — subscription shape, memoization, and
 * collapse reactivity against a real BlueprintDoc store.
 *
 * Uses `BlueprintDocProvider` (the public provider surface) rather than
 * creating the store directly, so the test respects the store-boundary
 * rule enforced by Biome's `noRestrictedImports`.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid, type Uuid } from "@/lib/doc/types";
import type { AppBlueprint } from "@/lib/schemas/blueprint";
import { EMPTY_COLLAPSE, useFormRows } from "../useFormRows";

// ── Setup ──────────────────────────────────────────────────────────────

const TEST_BLUEPRINT: AppBlueprint = {
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

const FORM_UUID = asUuid("form-1-0000-0000-0000-000000000001");

function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider initialBlueprint={TEST_BLUEPRINT} appId="app-rows">
			{children}
		</BlueprintDocProvider>
	);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("useFormRows", () => {
	it("returns live rows that reflect the doc state", () => {
		const { result } = renderHook(
			() =>
				useFormRows({
					formUuid: FORM_UUID,
					includeInsertionPoints: true,
					collapsed: EMPTY_COLLAPSE,
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
		const { result } = renderHook(
			() => ({
				rows: useFormRows({
					formUuid: FORM_UUID,
					includeInsertionPoints: false,
					collapsed: EMPTY_COLLAPSE,
				}),
				/** Imperative store access for test mutations — goes through
				 *  the public hook API, not a raw store import. */
				storeApi: useBlueprintDocApi(),
			}),
			{ wrapper },
		);
		expect(
			result.current.rows.filter((r) => r.kind === "question"),
		).toHaveLength(2);

		act(() => {
			result.current.storeApi.getState().apply({
				kind: "addQuestion",
				parentUuid: FORM_UUID,
				question: {
					uuid: asUuid("qst-c-0000-0000-0000-000000000003"),
					id: "c",
					type: "text",
				},
			});
		});
		expect(
			result.current.rows.filter((r) => r.kind === "question"),
		).toHaveLength(3);
	});

	it("recomputes when the collapsed set reference changes", () => {
		const groupUuid = asUuid("grp-x-0000-0000-0000-000000000009");
		const childUuid = asUuid("qst-z-0000-0000-0000-00000000000a");

		const { result, rerender } = renderHook(
			(props: { collapsed: Set<Uuid> }) => ({
				rows: useFormRows({
					formUuid: FORM_UUID,
					includeInsertionPoints: false,
					collapsed: props.collapsed,
				}),
				storeApi: useBlueprintDocApi(),
			}),
			{ wrapper, initialProps: { collapsed: new Set<Uuid>() } },
		);

		/* Add a group + child so collapse has something to act on. */
		act(() => {
			result.current.storeApi.getState().applyMany([
				{
					kind: "addQuestion",
					parentUuid: FORM_UUID,
					question: { uuid: groupUuid, id: "sec", type: "group" },
				},
				{
					kind: "addQuestion",
					parentUuid: groupUuid,
					question: { uuid: childUuid, id: "z", type: "text" },
				},
			]);
		});

		/* Group is expanded — all 3 question rows present (form's A + B,
		 * plus group's child z). */
		expect(
			result.current.rows.filter((r) => r.kind === "question"),
		).toHaveLength(3);

		rerender({ collapsed: new Set([groupUuid]) });
		/* Group is collapsed — child is gone, only bracket rows remain. */
		expect(
			result.current.rows.filter((r) => r.kind === "question"),
		).toHaveLength(2);
		expect(
			result.current.rows.filter(
				(r) => r.kind === "group-open" || r.kind === "group-close",
			),
		).toHaveLength(2);
	});
});
