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

const APP_ID = "app-repeat-a11y";
const QUESTION = "Related patient case id";

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

		const textboxes = screen.getAllByRole("textbox", { name: QUESTION });
		expect(textboxes).toHaveLength(2);
		const labelIds = textboxes.map((textbox) =>
			textbox.getAttribute("aria-labelledby"),
		);
		expect(labelIds.every((id) => id !== null)).toBe(true);
		expect(new Set(labelIds).size).toBe(2);
		for (const labelId of labelIds) {
			expect(document.getElementById(labelId ?? "")?.textContent).toContain(
				QUESTION,
			);
		}
	});
});
