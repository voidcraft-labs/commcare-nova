// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { BlueprintDocProvider } from "@/lib/doc/provider";
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
	},
	useEngineStateAtMock: vi.fn(),
}));

vi.mock("@/lib/preview/hooks/useEngineController", () => ({
	useEngineController: () => controller,
}));
vi.mock("@/lib/preview/hooks/useEngineState", () => ({
	useEngineStateAt: useEngineStateAtMock,
}));
vi.mock("@/lib/session/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/session/hooks")>(
		"@/lib/session/hooks",
	);
	return { ...actual, useEditMode: () => "preview" as const };
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
									label: "Visits",
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
				<FormLayoutProvider>
					<InteractiveFormRenderer parentEntityId={formUuid} />
				</FormLayoutProvider>
			</BlueprintDocProvider>,
		);

		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("textbox", { name: QUESTION }),
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
									label: "Visits",
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
											options: [
												{ value: "completed", label: "Completed" },
												{ value: "referred", label: "Referred" },
											],
										}),
										f({
											kind: "multi_select",
											id: "symptoms",
											label: MULTI_SELECT_QUESTION,
											options: [
												{ value: "cough", label: "Cough" },
												{ value: "fever", label: "Fever" },
											],
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
				<FormLayoutProvider>
					<InteractiveFormRenderer parentEntityId={formUuid} />
				</FormLayoutProvider>
			</BlueprintDocProvider>,
		);

		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("spinbutton", { name: NUMBER_QUESTION }),
			NUMBER_QUESTION,
		);
		expectCollisionFreeVisibleLabels(
			screen.getAllByLabelText(DATE_QUESTION, {
				selector: 'input[type="date"]',
			}),
			DATE_QUESTION,
		);
		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("group", { name: SINGLE_SELECT_QUESTION }),
			SINGLE_SELECT_QUESTION,
		);
		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("group", { name: MULTI_SELECT_QUESTION }),
			MULTI_SELECT_QUESTION,
		);
		expectCollisionFreeVisibleLabels(
			screen.getAllByRole("group", { name: GEOPOINT_QUESTION }),
			GEOPOINT_QUESTION,
		);
	});
});

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
