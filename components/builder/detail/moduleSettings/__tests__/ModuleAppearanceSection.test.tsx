// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModuleAppearanceSection } from "@/components/builder/detail/moduleSettings/ModuleAppearanceSection";
import type { Uuid } from "@/lib/doc/types";

const state = vi.hoisted(() => ({
	commitMany: vi.fn(),
	module: {
		uuid: "80000000-0000-4000-8000-000000000001",
		name: "Clients",
		caseListOnly: true,
		icon: "80000000-0000-4000-8000-000000000002",
		audioLabel: "80000000-0000-4000-8000-000000000003",
		caseListConfig: {
			columns: [],
			searchInputs: [],
			icon: "80000000-0000-4000-8000-000000000004",
			audioLabel: "80000000-0000-4000-8000-000000000005",
		},
		parentModuleUuid: undefined as string | undefined,
	},
	parentModule: {
		uuid: "80000000-0000-4000-8000-000000000008",
		name: "Care",
	},
	setModuleMedia: vi.fn(),
}));

vi.mock("@/lib/doc/hooks/useEntity", () => ({
	useModule: (uuid: string | undefined) => {
		if (uuid === state.module.uuid) return state.module;
		if (uuid === state.parentModule.uuid) return state.parentModule;
		return undefined;
	},
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
					ariaLabel === "Menu tile icon"
						? "80000000-0000-4000-8000-000000000006"
						: ariaLabel === "Case list link icon"
							? "80000000-0000-4000-8000-000000000007"
							: undefined,
				)
			}
		/>
	),
}));

beforeEach(() => {
	state.module.caseListOnly = true;
	state.module.parentModuleUuid = undefined;
	state.commitMany.mockReset();
	state.setModuleMedia.mockReset();
});

describe("ModuleAppearanceSection", () => {
	it("gives each case-list-only appearance slot one clearly named home", () => {
		render(
			<ModuleAppearanceSection
				moduleUuid={"80000000-0000-4000-8000-000000000001" as Uuid}
			/>,
		);

		expect(
			screen.getByRole("heading", { level: 3, name: "Menu tile" }),
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
			name: "Menu tile icon",
		});
		const caseIcon = screen.getByRole("button", {
			name: "Case list link icon",
		});
		expect(homeIcon.getAttribute("data-value")).toBe(
			"80000000-0000-4000-8000-000000000002",
		);
		expect(caseIcon.getAttribute("data-value")).toBe(
			"80000000-0000-4000-8000-000000000004",
		);

		fireEvent.click(homeIcon);
		expect(state.setModuleMedia).toHaveBeenCalledWith(
			"80000000-0000-4000-8000-000000000001",
			{
				icon: "80000000-0000-4000-8000-000000000006",
				audioLabel: "80000000-0000-4000-8000-000000000003",
			},
		);

		fireEvent.click(caseIcon);
		expect(state.commitMany).toHaveBeenCalledWith([
			{
				kind: "setCaseListMeta",
				uuid: "80000000-0000-4000-8000-000000000001",
				patch: {
					icon: "80000000-0000-4000-8000-000000000007",
					audioLabel: "80000000-0000-4000-8000-000000000005",
				},
			},
		]);
	});

	it("clears one slot explicitly while preserving its sibling", () => {
		render(
			<ModuleAppearanceSection
				moduleUuid={"80000000-0000-4000-8000-000000000001" as Uuid}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Menu tile spoken label" }),
		);
		expect(state.setModuleMedia).toHaveBeenCalledWith(
			"80000000-0000-4000-8000-000000000001",
			{
				icon: "80000000-0000-4000-8000-000000000002",
				audioLabel: null,
			},
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Case list link spoken label" }),
		);
		expect(state.commitMany).toHaveBeenCalledWith([
			{
				kind: "setCaseListMeta",
				uuid: "80000000-0000-4000-8000-000000000001",
				patch: {
					icon: "80000000-0000-4000-8000-000000000004",
					audioLabel: null,
				},
			},
		]);
	});

	it("does not expose a case-list-link slot when that wire surface is absent", () => {
		state.module.caseListOnly = false;
		render(
			<ModuleAppearanceSection
				moduleUuid={"80000000-0000-4000-8000-000000000001" as Uuid}
			/>,
		);

		expect(
			screen.getByRole("heading", { level: 3, name: "Menu tile" }),
		).toBeDefined();
		expect(
			screen.queryByRole("heading", { level: 3, name: "Case list link" }),
		).toBeNull();
	});

	it("names the parent menu for a child module tile", () => {
		state.module.parentModuleUuid = state.parentModule.uuid;
		render(
			<ModuleAppearanceSection
				moduleUuid={"80000000-0000-4000-8000-000000000001" as Uuid}
			/>,
		);

		expect(screen.getByText("Shown inside Care")).toBeDefined();
	});
});
