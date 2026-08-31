// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FormLinksView } from "@/lib/doc/hooks/useFormLinks";
import type { FormLink, FormLinkTarget } from "@/lib/domain";
import { opaqueXPathExpression } from "@/lib/domain/xpath";
import {
	COMPLETE_SELECTION_NEEDS_FORM_LIST,
	SEVERAL_CASES_CARRY_AUTOMATICALLY,
	SEVERAL_CASES_MANUAL_CARRY_NEEDS_REPAIR,
} from "../afterSubmitCopy";
import { CarryValuesSection } from "../CarryValuesSection";

vi.mock("@/components/builder/XPathField", () => ({
	XPathField: () => <div data-testid="carried-value-editor" />,
}));

vi.mock("@/lib/doc/hooks/useXPathSlots", () => ({
	useParseXPathForForm: () => (text: string) => text,
	useXPathProjection: () => ({ text: "" }),
}));

const SOURCE = testUuid("carry-source");
const TARGET_MODULE = testUuid("carry-target-module");
const TARGET_FORM = testUuid("carry-target-form");
const target: FormLinkTarget = {
	type: "form",
	moduleUuid: TARGET_MODULE,
	formUuid: TARGET_FORM,
};
const link: FormLink = {
	uuid: testUuid("carry-link"),
	target,
};

function automaticView(manualAllowed: boolean): FormLinksView {
	return {
		carryVerdict: () => ({
			kind: "automatic",
			carried: [{ datumId: "case_id", sourceDatumId: "case_id" }],
		}),
		requiredDatums: () => [{ id: "case_id", caseType: "patient" }],
		manualCarryVerdict: () =>
			manualAllowed
				? { ok: true }
				: {
						ok: false,
						reason: "selection-cardinality",
						sourceCardinality: "multiple",
						targetCardinality: "multiple",
						sourceMaximum: 10,
						targetMaximum: 10,
					},
	} as unknown as FormLinksView;
}

function renderSection(
	view: FormLinksView,
	current: FormLink = link,
	onCommit = vi.fn(() => ({ ok: true as const })),
) {
	return render(
		<CarryValuesSection
			formUuid={SOURCE}
			link={current}
			view={view}
			canEdit
			onCommit={onCommit}
		/>,
	);
}

describe("CarryValuesSection", () => {
	it("explains automatic collection carry without offering an invalid manual mode", () => {
		renderSection(automaticView(false));

		expect(screen.getByText(SEVERAL_CASES_CARRY_AUTOMATICALLY)).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /Work it out here/ }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Carry it automatically/ }),
		).toBeNull();
	});

	it("keeps the manual choice when the shared admission verdict allows it", () => {
		renderSection(automaticView(true));

		expect(
			screen.getByRole("button", { name: /Carry it automatically/ }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Work it out here/ }),
		).toBeTruthy();
	});

	it("locks an invalid manual map and repairs it by carrying the collection automatically", () => {
		const onCommit = vi.fn(() => ({ ok: true as const }));
		const staleManual: FormLink = {
			...link,
			datums: [
				{ name: "case_id", xpath: opaqueXPathExpression("'patient-id'") },
			],
		};
		renderSection(automaticView(false), staleManual, onCommit);

		const automatic = screen.getByRole("button", {
			name: /Carry it automatically/,
		});
		const manual = screen.getByRole("button", { name: /Work it out here/ });
		expect(automatic.hasAttribute("disabled")).toBe(false);
		expect(automatic.getAttribute("aria-pressed")).toBe("false");
		expect(manual.hasAttribute("disabled")).toBe(true);
		expect(manual.getAttribute("aria-pressed")).toBe("true");
		expect(
			screen.getByText(SEVERAL_CASES_MANUAL_CARRY_NEEDS_REPAIR),
		).toBeTruthy();
		expect(screen.queryByText(SEVERAL_CASES_CARRY_AUTOMATICALLY)).toBeNull();
		expect(screen.queryByTestId("carried-value-editor")).toBeNull();

		fireEvent.click(automatic);
		fireEvent.click(
			screen.getByRole("button", { name: "Carry it automatically" }),
		);
		expect(onCommit).toHaveBeenCalledWith(link);
	});

	it("directs an impossible manual carry to the destination's form list", () => {
		const impossible = {
			...automaticView(false),
			carryVerdict: () => ({
				kind: "manual-required" as const,
				datumIds: ["case_id"],
			}),
		} as FormLinksView;
		const staleManual: FormLink = {
			...link,
			datums: [
				{ name: "case_id", xpath: opaqueXPathExpression("'patient-id'") },
			],
		};

		renderSection(impossible, staleManual);

		expect(screen.getByText(COMPLETE_SELECTION_NEEDS_FORM_LIST)).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: /Work it out here/ }),
		).toBeNull();
		expect(screen.queryByTestId("carried-value-editor")).toBeNull();
	});
});
