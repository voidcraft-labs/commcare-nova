// @vitest-environment happy-dom
//
// components/preview/screens/__tests__/ModuleScreen.test.tsx
//
// Pins the ModuleScreen "Case List" affordance card. Per Task 8.5,
// case-typed modules surface a violet-gradient affordance card
// BEFORE the form list that navigates to the case list authoring
// surface. Non-case modules don't render the card.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { asUuid } from "@/lib/doc/types";

const navigateMock = {
	goHome: vi.fn(),
	openModule: vi.fn(),
	openCaseList: vi.fn(),
	openCaseDetail: vi.fn(),
	openForm: vi.fn(),
	push: vi.fn(),
	replace: vi.fn(),
	back: vi.fn(),
	up: vi.fn(),
};

vi.mock("@/lib/routing/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/routing/hooks")>(
		"@/lib/routing/hooks",
	);
	return {
		...actual,
		useLocation: () => ({ kind: "module", moduleUuid: MODULE_UUID }),
		useNavigate: () => navigateMock,
	};
});

vi.mock("@/lib/session/hooks", async () => {
	const actual = await vi.importActual<typeof import("@/lib/session/hooks")>(
		"@/lib/session/hooks",
	);
	return {
		...actual,
		useEditMode: () => "edit" as const,
		useBuilderIsReady: () => true,
	};
});

import { ModuleScreen } from "../ModuleScreen";

const MODULE_UUID = asUuid("mod-1");

/**
 * Render ModuleScreen against a doc seeded with a single module.
 * The `caseType` parameter controls whether the module is
 * case-typed; passing `undefined` exercises the "no case list
 * affordance" arm.
 */
function renderModuleScreen(opts: { caseType?: string } = {}) {
	return render(
		<BlueprintDocProvider
			appId="app-module-screen-test"
			initialDoc={{
				appId: "app-module-screen-test",
				appName: "Module screen test app",
				connectType: null,
				caseTypes: [],
				modules: {
					[MODULE_UUID]: {
						uuid: MODULE_UUID,
						id: "patient_module",
						name: "Patient module",
						caseType: opts.caseType,
					},
				},
				forms: {},
				fields: {},
				moduleOrder: [MODULE_UUID],
				formOrder: { [MODULE_UUID]: [] },
				fieldOrder: {},
			}}
		>
			<ModuleScreen screen={{ type: "module", moduleIndex: 0 }} />
		</BlueprintDocProvider>,
	);
}

describe("ModuleScreen — Case List affordance", () => {
	it("renders the Case List card when the module has a caseType", () => {
		renderModuleScreen({ caseType: "patient" });
		// The affordance card surfaces with the section's display title.
		expect(screen.getByRole("button", { name: /Case List/i })).toBeDefined();
	});

	it("does NOT render the Case List card when the module has no caseType", () => {
		renderModuleScreen({ caseType: undefined });
		expect(screen.queryByRole("button", { name: /Case List/i })).toBeNull();
	});

	it("navigates to the case list URL via openCaseList on click", () => {
		renderModuleScreen({ caseType: "patient" });
		const card = screen.getByRole("button", { name: /Case List/i });
		fireEvent.click(card);
		expect(navigateMock.openCaseList).toHaveBeenCalledOnce();
		expect(navigateMock.openCaseList).toHaveBeenCalledWith(MODULE_UUID);
	});

	it("renders the case type as a badge on the affordance card", () => {
		renderModuleScreen({ caseType: "patient" });
		const card = screen.getByRole("button", { name: /Case List/i });
		// Case-type appears as a monospace pill — the user immediately
		// sees which case-type's case list this affordance configures.
		expect(card.textContent).toMatch(/patient/i);
	});
});
