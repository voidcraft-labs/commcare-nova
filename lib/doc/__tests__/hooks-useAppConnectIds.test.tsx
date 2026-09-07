// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, xp } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	type ConnectTargetState,
	planConnectTargetState,
} from "@/lib/doc/connectTargetState";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	connectIdsExcept,
	useAppConnectIds,
} from "@/lib/doc/hooks/useAppConnectIds";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { BlueprintDocContext } from "@/lib/doc/provider";
import {
	type BlueprintDocStoreApi,
	createBlueprintDocStore,
} from "@/lib/doc/store";
import { assertAdmittedDoc } from "./admittedDoc";

const FORM_A = testUuid("form-a");
const FORM_B = testUuid("form-b");

function setup() {
	const doc = buildDoc({
		appName: "Connect ids",
		connectType: "learn",
		modules: [
			{
				name: "Module A",
				forms: [
					{
						uuid: FORM_A,
						name: "Form A",
						type: "survey",
						connect: {
							learn_module: {
								id: "intro",
								name: "Intro",
								description: "First lesson",
								time_estimate: 5,
							},
							assessment: { id: "intro_quiz", user_score: xp("100") },
						},
						fields: [{ kind: "text", id: "answer" }],
					},
				],
			},
			{
				name: "Module B",
				forms: [
					{
						uuid: FORM_B,
						name: "Form B",
						type: "survey",
						connect: {
							learn_module: {
								id: "lesson_two",
								name: "Lesson two",
								description: "Second lesson",
								time_estimate: 5,
							},
						},
						fields: [{ kind: "text", id: "answer" }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { store, wrapper };
}

function switchConnect(
	store: BlueprintDocStoreApi,
	target: ConnectTargetState,
): void {
	const plan = planConnectTargetState(store.getState(), target);
	if (!plan.ok) throw new Error(plan.messages.join("\n"));
	const verdict = mutationCommitVerdict(
		store.getState(),
		plan.mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	store.getState().commitDoc(verdict.nextDoc, verdict.mutations);
}

describe("Connect id subscription", () => {
	it("tracks complete admitted mode transitions and preserves identity for unrelated edits", () => {
		const { store, wrapper } = setup();
		const { result } = renderHook(useAppConnectIds, { wrapper });
		expect(result.current).toEqual([
			{ formUuid: FORM_A, kind: "learn_module", id: "intro" },
			{ formUuid: FORM_A, kind: "assessment", id: "intro_quiz" },
			{ formUuid: FORM_B, kind: "learn_module", id: "lesson_two" },
		]);
		const previous = result.current;
		act(() =>
			store.getState().applyMany([{ kind: "setAppName", name: "Renamed app" }]),
		);
		expect(result.current).toBe(previous);
		act(() =>
			switchConnect(store, {
				mode: "deliver",
				participants: [
					{
						formUuid: FORM_B,
						connect: { deliver_unit: { id: "visit", name: "Visit" } },
					},
				],
			}),
		);
		expect(result.current).toEqual([
			{ formUuid: FORM_B, kind: "deliver_unit", id: "visit" },
		]);
		act(() => switchConnect(store, { mode: null }));
		expect(result.current).toEqual([]);
	});

	it("excludes only the edited slot, retaining its co-located assessment and cross-form ids", () => {
		const { wrapper } = setup();
		const { result } = renderHook(useAppConnectIds, { wrapper });
		expect(connectIdsExcept(result.current, FORM_A, "learn_module")).toEqual(
			new Set(["intro_quiz", "lesson_two"]),
		);
		expect(connectIdsExcept(result.current, FORM_B, "learn_module")).toEqual(
			new Set(["intro", "intro_quiz"]),
		);
	});
});
