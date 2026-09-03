// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type CommitOutcome,
	type HiddenField,
	type ImageField,
	type TextField,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { CaseWriteEditor } from "../CaseWriteEditor";

const mocks = vi.hoisted(() => ({
	context: {
		module: {
			caseType: "patient",
			caseListConfig: {
				selection: { kind: "multiple", maximum: 10 },
			},
		},
		form: { type: "followup" },
	} as {
		module: {
			caseType?: string;
			caseListConfig?: {
				selection?: { kind: "multiple"; maximum: number };
			};
		};
		form: { type: "registration" | "followup" | "close" | "survey" };
	} | null,
}));

vi.mock("@/lib/routing/hooks", () => ({
	useSelectedFormContext: () => mocks.context,
}));

vi.mock("@/lib/doc/hooks/useBlueprintDoc", () => ({
	useBlueprintDoc: (selector: (state: Record<string, unknown>) => unknown) =>
		selector({ userProperties: undefined, userPropertyOrder: undefined }),
}));

vi.mock("@/lib/doc/hooks/useCaseTypes", () => ({
	useEffectiveCaseTypes: () => [
		{
			name: "patient",
			properties: [
				{
					name: "phone",
					label: proseText("Phone"),
					data_type: "text",
				},
			],
		},
		{
			name: "visit",
			parent_type: "patient",
			relationship: "child",
			properties: [
				{
					name: "note",
					label: proseText("Visit note"),
					data_type: "text",
				},
			],
		},
	],
}));

vi.mock("@/lib/doc/hooks/useCaseWriteChoices", () => ({
	useCaseWriteChoiceVerdicts: () => ({
		verdicts: new Map(),
		evaluating: false,
		ensureVerdict: vi.fn(async () => ({ ok: true })),
	}),
}));

vi.mock("@/lib/doc/hooks/useProseProjection", () => ({
	useProseProjection: () => () => "Phone",
}));

const FIELD_UUID = asUuid("11111111-1111-4111-8111-111111111111");

function textField(overrides: Partial<TextField> = {}): TextField {
	return {
		uuid: FIELD_UUID,
		id: "phone",
		kind: "text",
		label: proseText("Phone"),
		caseWrite: { caseType: "patient", property: "phone" },
		...overrides,
	};
}

function renderEditor<F extends TextField | HiddenField | ImageField>(
	field: F,
) {
	const onChange = vi.fn(
		(_next: F["caseWrite"]): CommitOutcome => ({
			ok: true,
		}),
	);
	return {
		...render(
			<CaseWriteEditor
				field={field}
				value={field.caseWrite}
				onChange={onChange}
				label="Saves to"
				keyName="caseWrite"
			/>,
		),
		onChange,
	};
}

describe("CaseWriteEditor several-case guidance", () => {
	beforeEach(() => {
		mocks.context = {
			module: {
				caseType: "patient",
				caseListConfig: {
					selection: { kind: "multiple", maximum: 10 },
				},
			},
			form: { type: "followup" },
		};
	});

	it("explains blank primary-case writes and describes the destination control", () => {
		renderEditor(textField());

		const help = screen.getByText(
			"This question starts blank. Any answer someone enters updates this information on every selected case. Leaving it blank keeps each case's current value.",
		);
		const trigger = screen.getByRole("combobox", {
			name: "Saves to: Phone, #patient/phone",
		});
		expect(trigger.getAttribute("aria-describedby")).toBe(help.id);
	});

	it.each([
		{
			name: "default answer",
			field: textField({ default_value: xp("'Starting value'") }),
		},
		{
			name: "calculation",
			field: {
				uuid: FIELD_UUID,
				id: "phone",
				kind: "hidden" as const,
				calculate: xp("'Calculated value'"),
				caseWrite: { caseType: "patient", property: "phone" },
			} satisfies HiddenField,
		},
	])("warns when a primary-case write has a $name", ({ field }) => {
		renderEditor(field);

		expect(
			screen.getByText(
				"This question has a starting value or calculation. When it produces an answer, that answer updates this information on every selected case, even if no one changes it.",
			),
		).toBeDefined();
	});

	it("states the Preview behavior for a capture written to every selected case", () => {
		const field = {
			uuid: FIELD_UUID,
			id: "photo",
			kind: "image" as const,
			label: proseText("Photo"),
			caseWrite: {
				caseType: "patient",
				property: "phone",
				mode: "url" as const,
			},
		} satisfies ImageField;
		renderEditor(field);

		expect(
			screen.getByText(
				"This attachment starts blank. When someone submits a file, its stored link updates this information on every selected case. Preview leaves each case's current value because it does not create that stored link.",
			),
		).toBeDefined();
	});

	it("does not apply several-case guidance to a child-case destination", () => {
		renderEditor(
			textField({
				caseWrite: { caseType: "visit", property: "note" },
			}),
		);

		expect(screen.queryByText(/every selected case/)).toBeNull();
	});

	it.each(["registration", "survey"] as const)(
		"does not apply several-case guidance in a %s form",
		(formType) => {
			mocks.context = {
				module: {
					caseType: "patient",
					caseListConfig: {
						selection: { kind: "multiple", maximum: 10 },
					},
				},
				form: { type: formType },
			};
			renderEditor(textField());

			expect(screen.queryByText(/every selected case/)).toBeNull();
		},
	);

	it("does not apply several-case guidance in a one-case module", () => {
		mocks.context = {
			module: { caseType: "patient", caseListConfig: {} },
			form: { type: "followup" },
		};
		renderEditor(textField());

		expect(screen.queryByText(/every selected case/)).toBeNull();
	});
});
