// @vitest-environment happy-dom

/**
 * useFormRows integration tests — subscription shape, memoization, and
 * collapse reactivity against a real BlueprintDoc store.
 *
 * Uses `BlueprintDocProvider` (the public provider surface) rather than
 * creating the store directly, so the test respects the store-boundary
 * rule enforced by Biome's `noRestrictedImports`.
 *
 * Fixtures are built in the normalized `BlueprintDoc` shape directly — no
 * legacy `AppBlueprint` / `Question` types cross the test boundary.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc } from "@/lib/doc/types";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { EMPTY_COLLAPSE, useFormRows } from "../useFormRows";

// ── Setup ──────────────────────────────────────────────────────────────

const MODULE_UUID = asUuid("module-1-0000-0000-0000-000000000000");
const FORM_UUID = asUuid("form-1-0000-0000-0000-000000000001");
const Q_A = asUuid("qst-a-0000-0000-0000-000000000001");
const Q_B = asUuid("qst-b-0000-0000-0000-000000000002");

const TEST_DOC: BlueprintDoc = {
	appId: "app-rows",
	appName: "Rows Test",
	connectType: null,
	caseTypes: null,
	modules: {
		[MODULE_UUID]: { uuid: MODULE_UUID, id: "m", name: "M" },
	},
	forms: {
		[FORM_UUID]: {
			uuid: FORM_UUID,
			id: "f",
			name: "F",
			type: "registration",
		},
	},
	fields: {
		[Q_A]: { uuid: Q_A, id: "a", kind: "text", label: "A" },
		[Q_B]: { uuid: Q_B, id: "b", kind: "text", label: "B" },
	},
	moduleOrder: [MODULE_UUID],
	formOrder: { [MODULE_UUID]: [FORM_UUID] },
	fieldOrder: { [FORM_UUID]: [Q_A, Q_B] },
	fieldParent: {},
};

function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider initialDoc={TEST_DOC} appId="app-rows">
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

	it("updates when fields are added to the form", () => {
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
				kind: "addField",
				parentUuid: FORM_UUID,
				field: {
					uuid: asUuid("qst-c-0000-0000-0000-000000000003"),
					id: "c",
					kind: "text",
					label: "C",
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
					kind: "addField",
					parentUuid: FORM_UUID,
					field: { uuid: groupUuid, id: "sec", kind: "group", label: "Sec" },
				},
				{
					kind: "addField",
					parentUuid: groupUuid,
					field: { uuid: childUuid, id: "z", kind: "text", label: "Z" },
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
