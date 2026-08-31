// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FormLinksView } from "@/lib/doc/hooks/useFormLinks";
import type { FormLink, FormLinkTarget } from "@/lib/domain";
import { SEVERAL_CASES_CARRY_AUTOMATICALLY } from "../afterSubmitCopy";
import { CarryValuesSection } from "../CarryValuesSection";

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

function renderSection(view: FormLinksView) {
	return render(
		<CarryValuesSection
			formUuid={SOURCE}
			link={link}
			view={view}
			canEdit
			onCommit={vi.fn(() => ({ ok: true as const }))}
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
});
