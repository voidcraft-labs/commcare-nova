// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleAppearanceSection } from "@/components/builder/detail/moduleSettings/ModuleAppearanceSection";
import type { Uuid } from "@/lib/doc/types";

const state = vi.hoisted(() => ({
	commitMany: vi.fn(),
	module: {
		uuid: "module-1",
		name: "Clients",
		caseListOnly: true,
		icon: "home-icon",
		audioLabel: "home-audio",
		caseListConfig: {
			columns: [],
			searchInputs: [],
			icon: "case-icon",
			audioLabel: "case-audio",
		},
	},
	setModuleMedia: vi.fn(),
}));

vi.mock("@/lib/doc/hooks/useEntity", () => ({
	useModule: () => state.module,
}));
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		commitMany: state.commitMany,
		setModuleMedia: state.setModuleMedia,
	}),
}));
vi.mock("@/components/builder/media/MediaSlot", () => ({
	SingleAssetSlot: ({
		ariaLabel,
		value,
		onChange,
	}: {
		ariaLabel: string;
		value?: string;
		onChange: (next: string | undefined) => void;
	}) => (
		<button
			type="button"
			aria-label={ariaLabel}
			data-value={value}
			onClick={() =>
				onChange(
					ariaLabel === "App home tile icon"
						? "new-home-icon"
						: ariaLabel === "Case list link icon"
							? "new-case-icon"
							: undefined,
				)
			}
		/>
	),
}));

beforeEach(() => {
	state.module.caseListOnly = true;
	state.commitMany.mockReset();
	state.setModuleMedia.mockReset();
});

describe("ModuleAppearanceSection", () => {
	it("gives each case-list-only appearance slot one clearly named home", () => {
		render(<ModuleAppearanceSection moduleUuid={"module-1" as Uuid} />);

		expect(
			screen.getByRole("heading", { level: 3, name: "App home tile" }),
		).toBeDefined();
		expect(
			screen.getByRole("heading", { level: 3, name: "Case list link" }),
		).toBeDefined();
		expect(screen.getByText("Shown on the app's main menu")).toBeDefined();
		expect(
			screen.getByText("Shown on the link that opens this case list"),
		).toBeDefined();
		expect(screen.getAllByText("Spoken label")).toHaveLength(2);

		const homeIcon = screen.getByRole("button", {
			name: "App home tile icon",
		});
		const caseIcon = screen.getByRole("button", {
			name: "Case list link icon",
		});
		expect(homeIcon.getAttribute("data-value")).toBe("home-icon");
		expect(caseIcon.getAttribute("data-value")).toBe("case-icon");

		fireEvent.click(homeIcon);
		expect(state.setModuleMedia).toHaveBeenCalledWith("module-1", {
			icon: "new-home-icon",
			audioLabel: "home-audio",
		});

		fireEvent.click(caseIcon);
		expect(state.commitMany).toHaveBeenCalledWith([
			{
				kind: "setCaseListMeta",
				uuid: "module-1",
				patch: { icon: "new-case-icon", audioLabel: "case-audio" },
			},
		]);
	});

	it("clears one slot explicitly while preserving its sibling", () => {
		render(<ModuleAppearanceSection moduleUuid={"module-1" as Uuid} />);

		fireEvent.click(
			screen.getByRole("button", { name: "App home tile spoken label" }),
		);
		expect(state.setModuleMedia).toHaveBeenCalledWith("module-1", {
			icon: "home-icon",
			audioLabel: null,
		});

		fireEvent.click(
			screen.getByRole("button", { name: "Case list link spoken label" }),
		);
		expect(state.commitMany).toHaveBeenCalledWith([
			{
				kind: "setCaseListMeta",
				uuid: "module-1",
				patch: { icon: "case-icon", audioLabel: null },
			},
		]);
	});

	it("does not expose a case-list-link slot when that wire surface is absent", () => {
		state.module.caseListOnly = false;
		render(<ModuleAppearanceSection moduleUuid={"module-1" as Uuid} />);

		expect(
			screen.getByRole("heading", { level: 3, name: "App home tile" }),
		).toBeDefined();
		expect(
			screen.queryByRole("heading", { level: 3, name: "Case list link" }),
		).toBeNull();
	});
});
