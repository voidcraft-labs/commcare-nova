// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppTreeRail } from "@/components/builder/appTree/AppTreeRail";
import { ModuleCard } from "@/components/builder/appTree/ModuleCard";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { SearchResult } from "@/lib/doc/hooks/useSearchFilter";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";

const selection = vi.hoisted(() => ({ onSelect: vi.fn() }));

vi.mock("@/components/builder/appTree/useAppTreeSelection", async () => {
	const actual = await vi.importActual<
		typeof import("@/components/builder/appTree/useAppTreeSelection")
	>("@/components/builder/appTree/useAppTreeSelection");
	return { ...actual, useAppTreeSelection: () => selection.onSelect };
});

vi.mock(
	"@/components/builder/localization/BuilderLocalizationProvider",
	() => ({ useLocalizedText: () => undefined }),
);

vi.mock("@/components/builder/PeerBadge", () => ({ PeerBadge: () => null }));

vi.mock("@/components/shadcn/tooltip", () => ({
	SimpleTooltip: ({ children }: { children: ReactElement }) => children,
}));

vi.mock("@/lib/session/hooks", () => ({ useCanEdit: () => false }));

vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		removeModule: vi.fn(() => false),
		moveModule: vi.fn(() => ({ ok: true })),
		createForm: vi.fn(() => ({ ok: false, messages: [] })),
		inline: {
			createSurveyModule: vi.fn(() => ({ ok: false, messages: [] })),
			createCaseListModule: vi.fn(() => ({ ok: false, messages: [] })),
		},
	}),
}));

vi.mock("@/lib/routing/hooks", () => ({
	useIsCaseListSelected: () => false,
	useIsFormSelected: () => false,
	useIsModuleSelected: () => false,
	useLocation: () => ({ kind: "home" }),
	useNavigate: () => ({
		goHome: vi.fn(),
		openAppSetup: vi.fn(),
		openCaseList: vi.fn(),
		openForm: vi.fn(),
		openModule: vi.fn(),
		openProjectData: vi.fn(),
	}),
}));

class ResizeObserverStub {
	observe() {}
	disconnect() {}
}

function fixture() {
	const doc = buildDoc({
		modules: [
			{
				uuid: "care-menu",
				name: "Care",
				caseType: "client",
				caseListOnly: true,
			},
			{
				uuid: "visits-menu",
				name: "Visits",
				forms: [{ name: "Follow up", type: "survey" }],
			},
		],
	});
	const rootUuid = doc.moduleOrder[0];
	const childUuid = doc.moduleOrder[1];
	doc.modules[childUuid].parentModuleUuid = rootUuid;
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	return { store, rootUuid, childUuid };
}

function DocProvider({
	store,
	children,
}: {
	store: ReturnType<typeof createBlueprintDocStore>;
	children: ReactNode;
}) {
	return (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
}

describe("case-list-only parent menu destinations", () => {
	beforeEach(() => {
		selection.onSelect.mockClear();
		vi.stubGlobal("ResizeObserver", ResizeObserverStub);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("opens the expanded tree parent as a menu while keeping Cases separate", () => {
		const { store, rootUuid, childUuid } = fixture();
		const searchResult: SearchResult = {
			matchMap: new Map(),
			forceExpand: new Set([rootUuid]),
			visibleModuleUuids: new Set([rootUuid, childUuid]),
			visibleFormUuids: new Set(),
			visibleFieldUuids: new Set(),
		};
		render(
			<DocProvider store={store}>
				<ul>
					<ModuleCard
						moduleUuid={rootUuid}
						onSelect={selection.onSelect}
						collapsed={new Set()}
						toggle={vi.fn()}
						searchResult={searchResult}
						childModuleUuids={[childUuid]}
						rootModuleUuids={[rootUuid]}
						childModuleUuidsByRoot={{ [rootUuid]: [childUuid] }}
						siblingModuleUuids={[rootUuid]}
						onPlacementCommitted={vi.fn()}
					/>
				</ul>
			</DocProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Care" }));
		expect(selection.onSelect).toHaveBeenLastCalledWith({
			kind: "module",
			moduleUuid: rootUuid,
		});
		expect(screen.getByRole("button", { name: /^Cases/ })).toBeDefined();
	});

	it("opens the compact rail parent as a menu while keeping its case list entry", () => {
		const { store, rootUuid } = fixture();
		render(
			<DocProvider store={store}>
				<AppTreeRail onExpand={vi.fn()} />
			</DocProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Care" }));
		expect(selection.onSelect).toHaveBeenLastCalledWith({
			kind: "module",
			moduleUuid: rootUuid,
		});
		expect(
			screen.getByRole("button", { name: "Care, case list and search" }),
		).toBeDefined();
	});
});
