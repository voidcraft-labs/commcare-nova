import { asUuid } from "@/lib/domain";
// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderLocalizationProvider } from "@/components/builder/localization/BuilderLocalizationProvider";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { proseText } from "@/lib/domain/prose";
import { DEFAULT_RUNTIME_STATE } from "@/lib/preview/engine/engineController";
import type { FieldState } from "@/lib/preview/engine/types";
import { FormLayoutProvider } from "../FormLayoutContext";
import { InteractiveFormRenderer } from "../InteractiveFormRenderer";

const { controller, useEngineStateAtMock } = vi.hoisted(() => ({
	controller: {
		addRepeat: vi.fn(),
		removeRepeat: vi.fn(),
		setValueAt: vi.fn(),
		touchAt: vi.fn(),
		// Repeat rows keep a stable render key across index compaction. The
		// value only has to be distinct per instance for these assertions;
		// what they check is that each row's accessible name stays unique.
		getRepeatInstanceKey: vi.fn(
			(uuid: string, index: number) => `${uuid}:${index}`,
		),
	},
	useEngineStateAtMock: vi.fn(),
}));

vi.mock("@/lib/preview/hooks/useEngineController", () => ({
	useEngineController: () => controller,
}));
vi.mock("@/lib/preview/hooks/useEngineState", () => ({
	useEngineStateAt: useEngineStateAtMock,
}));
// `InteractiveField` reads the app id for the capture lane. This suite mounts
// the renderer without the builder session, so stub the id alongside the mode
// rather than standing up a provider the accessible-name assertions never use.
vi.mock("@/lib/session/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/session/hooks")>(
		"@/lib/session/hooks",
	);
	return {
		...actual,
		useEditMode: () => "preview" as const,
		useAppId: () => "app-repeat-a11y",
	};
});
vi.mock("../fields/geopoint/googleMaps", () => ({
	googleMapsConfigured: () => false,
	loadGeocoding: vi.fn(),
}));
vi.mock("../fields/geopoint/useInView", () => ({ useInView: () => false }));

const APP_ID = "app-repeat-a11y";
const QUESTION = "Related patient case id";
const NUMBER_QUESTION = "Household size";
const DATE_QUESTION = "Visit date";
const SINGLE_SELECT_QUESTION = "Visit outcome";
const MULTI_SELECT_QUESTION = "Symptoms observed";
const GEOPOINT_QUESTION = "Visit location";

beforeEach(() => {
	useEngineStateAtMock.mockImplementation(
		(_uuid: string, path: string | undefined): FieldState => ({
			...DEFAULT_RUNTIME_STATE,
			path: path ?? "",
			...(path === "/data/visits" ? { repeatCount: 2 } : {}),
		}),
	);
});

describe("InteractiveFormRenderer repeated-field accessibility", () => {
	it("gives every repeated textbox its visible question as a collision-free accessible name", () => {
		const doc = buildDoc({
			appId: APP_ID,
			modules: [
				{
					name: "Patients",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "visits",
									label: proseText("Visits"),
									children: [
										f({
											kind: "text",
											id: "related_patient_case_id",
											label: QUESTION,
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		if (moduleUuid === undefined) throw new Error("fixture has no module");
		const formUuid = doc.formOrder[moduleUuid][0];
		if (formUuid === undefined) throw new Error("fixture has no form");

		render(
			<BlueprintDocProvider appId={APP_ID} initialDoc={doc}>
				<BuilderLocalizationProvider>
					<FormLayoutProvider>
						<InteractiveFormRenderer parentEntityId={formUuid} />
					</FormLayoutProvider>
				</BuilderLocalizationProvider>
			</BlueprintDocProvider>,
		);

		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("textbox", { name: nameContaining(QUESTION) }),
			QUESTION,
		);
	});

	it("gives repeated number, date, select, and geopoint controls their own visible question labels", () => {
		const doc = buildDoc({
			appId: APP_ID,
			modules: [
				{
					name: "Patients",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "repeat",
									id: "visits",
									label: proseText("Visits"),
									children: [
										f({
											kind: "int",
											id: "household_size",
											label: NUMBER_QUESTION,
										}),
										f({
											kind: "date",
											id: "visit_date",
											label: DATE_QUESTION,
										}),
										f({
											kind: "single_select",
											id: "visit_outcome",
											label: SINGLE_SELECT_QUESTION,
											optionsSource: {
												kind: "inline",
												options: [
													{
														uuid: asUuid(
															"e5613cee-bae7-4f63-ae37-1fe9018c24b0",
														),
														value: "completed",
														label: "Completed",
													},
													{
														uuid: asUuid(
															"85b4f614-cb2c-49db-aa34-8aeccc3a7b33",
														),
														value: "referred",
														label: "Referred",
													},
												],
											},
										}),
										f({
											kind: "multi_select",
											id: "symptoms",
											label: MULTI_SELECT_QUESTION,
											optionsSource: {
												kind: "inline",
												options: [
													{
														uuid: asUuid(
															"a4fed596-c808-447e-a8a2-49d1d53bd8fb",
														),
														value: "cough",
														label: "Cough",
													},
													{
														uuid: asUuid(
															"9b39b5cc-c91a-46aa-a1f2-82a2b9183c82",
														),
														value: "fever",
														label: "Fever",
													},
												],
											},
										}),
										f({
											kind: "geopoint",
											id: "visit_location",
											label: GEOPOINT_QUESTION,
										}),
									],
								}),
							],
						},
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0];
		if (moduleUuid === undefined) throw new Error("fixture has no module");
		const formUuid = doc.formOrder[moduleUuid][0];
		if (formUuid === undefined) throw new Error("fixture has no form");

		render(
			<BlueprintDocProvider appId={APP_ID} initialDoc={doc}>
				<BuilderLocalizationProvider>
					<FormLayoutProvider>
						<InteractiveFormRenderer parentEntityId={formUuid} />
					</FormLayoutProvider>
				</BuilderLocalizationProvider>
			</BlueprintDocProvider>,
		);

		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("spinbutton", {
				name: nameContaining(NUMBER_QUESTION),
			}),
			NUMBER_QUESTION,
		);
		// A date question is the design system's calendar picker, so its
		// labelled element is the popover trigger: there is no native
		// `<input type="date">` in the previewed app.
		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("button", { name: nameContaining(DATE_QUESTION) }),
			DATE_QUESTION,
		);
		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("group", {
				name: nameContaining(SINGLE_SELECT_QUESTION),
			}),
			SINGLE_SELECT_QUESTION,
		);
		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("group", {
				name: nameContaining(MULTI_SELECT_QUESTION),
			}),
			MULTI_SELECT_QUESTION,
		);
		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("group", { name: nameContaining(GEOPOINT_QUESTION) }),
			GEOPOINT_QUESTION,
		);
	});
});

/**
 * Every instance must carry the visible question in its accessible name, and
 * each must point at its OWN label node: that pair is what makes a repeated
 * question unambiguous to a screen reader.
 *
 * Matching is by containment, not equality: the renderer wraps the question in
 * an sr-only position announcement (and a required announcement where it
 * applies), so the accessible name is deliberately richer than the visible
 * prompt.
 */
function nameContaining(question: string): RegExp {
	return new RegExp(question.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

function expectCollisionFreeVisibleLabels(
	elements: readonly HTMLElement[],
	question: string,
): void {
	expect(elements).toHaveLength(2);
	const labelIds = elements.map((element) =>
		element.getAttribute("aria-labelledby"),
	);
	expect(labelIds.every((id) => id !== null)).toBe(true);
	expect(new Set(labelIds).size).toBe(2);
	for (const labelId of labelIds) {
		expect(document.getElementById(labelId ?? "")?.textContent).toContain(
			question,
		);
	}
}
