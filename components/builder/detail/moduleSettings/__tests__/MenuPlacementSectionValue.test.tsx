// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { MenuPlacementSection } from "@/components/builder/detail/moduleSettings/MenuPlacementSection";
import type { Module, Uuid } from "@/lib/domain";

const ROOT = testUuid("placement-root");
const CHILD = testUuid("placement-child");
const modules: Record<Uuid, Module> = {
	[ROOT]: { uuid: ROOT, id: "care", name: "Care" },
	[CHILD]: {
		uuid: CHILD,
		id: "visits",
		name: "Visits",
		parentModuleUuid: ROOT,
	},
};

vi.mock("@/lib/doc/hooks/useEntity", () => ({
	useModule: (uuid: Uuid | undefined) =>
		uuid === undefined ? undefined : modules[uuid],
}));

vi.mock("@/lib/doc/hooks/useModuleIds", () => ({
	useModuleMenuHierarchy: () => ({
		rootModuleUuids: [ROOT],
		childModuleUuidsByRoot: { [ROOT]: [CHILD] },
	}),
}));

vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		inline: { moveModule: vi.fn(() => ({ ok: true })) },
	}),
}));

describe("MenuPlacementSection value", () => {
	it("shows the parent menu name instead of its stored UUID", () => {
		render(<MenuPlacementSection moduleUuid={CHILD} />);

		const trigger = screen.getByRole("combobox", { name: "Menu placement" });
		expect(trigger.textContent).toContain("Care");
		expect(trigger.textContent).not.toContain(ROOT);
	});

	it("shows Top level instead of the internal sentinel", () => {
		render(<MenuPlacementSection moduleUuid={ROOT} />);

		const trigger = screen.getByRole("combobox", { name: "Menu placement" });
		expect(trigger.textContent).toContain("Top level");
		expect(trigger.textContent).not.toContain("__top_level__");
	});
});
