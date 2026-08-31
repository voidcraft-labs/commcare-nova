// @vitest-environment happy-dom

import {
	cleanup,
	fireEvent,
	render as rtlRender,
	screen,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleBaseUiTransitions } from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { type CaseType, calculatedColumn } from "@/lib/domain";
import { ancestorPath, prop, relationStep, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { ColumnEditor } from "../../../ColumnEditor";

const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [{ name: "score", label: proseText("Score"), data_type: "int" }],
};
const PATIENT: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
};
const RELATED_COLUMN = calculatedColumn(
	testUuid("related-score-column"),
	"Household score",
	term(
		prop("patient", "score", ancestorPath(relationStep("parent", "household"))),
	),
);

function DocumentProvider({ children }: { readonly children: ReactNode }) {
	return (
		<BlueprintDocProvider appId="test-app">{children}</BlueprintDocProvider>
	);
}

function render(ui: ReactElement) {
	return rtlRender(ui, { wrapper: DocumentProvider });
}

afterEach(async () => {
	cleanup();
	await settleBaseUiTransitions();
});

async function readAsNumberChoice(searchIsEffective: boolean) {
	render(
		<ColumnEditor
			value={RELATED_COLUMN}
			onChange={vi.fn()}
			caseTypes={[HOUSEHOLD, PATIENT]}
			currentCaseType="patient"
			searchIsEffective={searchIsEffective}
		/>,
	);
	fireEvent.click(
		screen.getByRole("button", {
			name: "Value source: Other case information",
		}),
	);
	return screen.findByRole("menuitem", { name: /^Read as a number/ });
}

describe("calculated column Search admission", () => {
	it("blocks wrapping a parent property when Search is effective", async () => {
		const choice = await readAsNumberChoice(true);

		expect(choice.getAttribute("aria-disabled")).toBe("true");
		expect(choice.textContent).toContain(
			"Search can show one parent property by itself",
		);
	});

	it("keeps the same calculation available without Search", async () => {
		const choice = await readAsNumberChoice(false);

		expect(choice.getAttribute("aria-disabled")).not.toBe("true");
	});
});
