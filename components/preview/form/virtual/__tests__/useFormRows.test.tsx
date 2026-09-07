// @vitest-environment happy-dom

/**
 * useFormRows integration tests: subscription shape, memoization, and
 * collapse reactivity against a real BlueprintDoc store.
 *
 * Uses `BlueprintDocProvider` (the public provider surface) rather than
 * creating the store directly, so the test respects the store-boundary
 * rule enforced by Biome's `noRestrictedImports`.
 *
 * Fixtures are normalized, schema-admitted survey documents. These checks
 * exercise subscriptions and memoization only; native browser tests own rendering.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { Uuid } from "@/lib/doc/types";
import { blueprintDocSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { EMPTY_COLLAPSE, useFormRows } from "../useFormRows";

// ── Setup ──────────────────────────────────────────────────────────────

const MODULE_UUID = testUuid("module-1-0000-0000-0000-000000000000");
const FORM_UUID = testUuid("form-1-0000-0000-0000-000000000001");
const Q_A = testUuid("qst-a-0000-0000-0000-000000000001");
const Q_B = testUuid("qst-b-0000-0000-0000-000000000002");

const TEST_DOC = buildDoc({
	appId: "app-rows",
	appName: "Rows test",
	modules: [
		{
			uuid: MODULE_UUID,
			name: "Visits",
			forms: [
				{
					uuid: FORM_UUID,
					name: "Visit",
					type: "survey",
					fields: [
						f({ uuid: Q_A, id: "a", kind: "text", label: proseText("A") }),
						f({ uuid: Q_B, id: "b", kind: "text", label: proseText("B") }),
					],
				},
			],
		},
	],
});
blueprintDocSchema.parse(toPersistableDoc(TEST_DOC));

function wrapper({ children }: { children: ReactNode }) {
	return (
		<BlueprintDocProvider initialDoc={TEST_DOC} appId="app-rows">
			{children}
		</BlueprintDocProvider>
	);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("useFormRows", () => {
	it("keeps the row projection stable across unrelated document edits", () => {
		const { result } = renderHook(
			() => ({
				rows: useFormRows({
					formUuid: FORM_UUID,
					includeInsertionPoints: true,
					collapsed: EMPTY_COLLAPSE,
				}),
				storeApi: useBlueprintDocApi(),
			}),
			{ wrapper },
		);
		const before = result.current.rows;
		act(() => {
			result.current.storeApi
				.getState()
				.applyMany([{ kind: "setAppName", name: "Renamed" }]);
		});
		expect(result.current.rows).toBe(before);
	});

	it("updates when fields are added to the form", () => {
		const { result } = renderHook(
			() => ({
				rows: useFormRows({
					formUuid: FORM_UUID,
					includeInsertionPoints: false,
					collapsed: EMPTY_COLLAPSE,
				}),
				/** Imperative store access for test mutations: goes through
				 *  the public hook API, not a raw store import. */
				storeApi: useBlueprintDocApi(),
			}),
			{ wrapper },
		);
		expect(result.current.rows.filter((r) => r.kind === "field")).toHaveLength(
			2,
		);

		act(() => {
			result.current.storeApi.getState().applyMany([
				{
					kind: "addField",
					parentUuid: FORM_UUID,
					field: {
						uuid: testUuid("qst-c-0000-0000-0000-000000000003"),
						id: "c",
						kind: "text",
						label: proseText("C"),
					},
				},
			]);
		});
		expect(result.current.rows.filter((r) => r.kind === "field")).toHaveLength(
			3,
		);
	});

	it("recomputes when the collapsed set reference changes", () => {
		const groupUuid = testUuid("grp-x-0000-0000-0000-000000000009");
		const childUuid = testUuid("qst-z-0000-0000-0000-00000000000a");

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
					field: {
						uuid: groupUuid,
						id: "sec",
						kind: "group",
						label: proseText("Sec"),
					},
				},
				{
					kind: "addField",
					parentUuid: groupUuid,
					field: {
						uuid: childUuid,
						id: "z",
						kind: "text",
						label: proseText("Z"),
					},
				},
			]);
		});

		/* Group is expanded: all 3 field rows present (form's A + B,
		 * plus group's child z). */
		expect(result.current.rows.filter((r) => r.kind === "field")).toHaveLength(
			3,
		);

		rerender({ collapsed: new Set([groupUuid]) });
		/* Group is collapsed: child is gone, only bracket rows remain. */
		expect(result.current.rows.filter((r) => r.kind === "field")).toHaveLength(
			2,
		);
		expect(
			result.current.rows.filter(
				(r) => r.kind === "group-open" || r.kind === "group-close",
			),
		).toHaveLength(2);
	});
});
