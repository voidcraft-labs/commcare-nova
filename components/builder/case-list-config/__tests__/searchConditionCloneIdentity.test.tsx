// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { produce } from "immer";
import { type ReactNode, StrictMode, useLayoutEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	advancedSearchInputDef,
	asUuid,
	type BlueprintDoc,
	type CaseType,
	type SearchInputDef,
} from "@/lib/domain";
import {
	and,
	dateLiteral,
	eq,
	literal,
	lt,
	prop,
} from "@/lib/domain/predicate";
import {
	CaseListWorkspaceCanvas,
	CaseListWorkspaceProvider,
	useCaseListWorkspace,
} from "../CaseListConfigWorkspace";

const MODULE_UUID = asUuid("00000000-0000-4000-8000-000000000001");
const INPUT_UUID = asUuid("00000000-0000-4000-8000-000000000011");

const CASE_TYPES: readonly CaseType[] = [
	{
		name: "client",
		properties: [
			{ name: "case_name", label: "Client name", data_type: "text" },
			{ name: "dob", label: "Date of birth", data_type: "date" },
			{ name: "region", label: "Region", data_type: "text" },
		],
	},
];

const testStore = vi.hoisted(() => ({
	doc: undefined as BlueprintDoc | undefined,
	notify: undefined as (() => void) | undefined,
}));
const mutationApi = vi.hoisted(() => ({
	commitMany: vi.fn(),
	moveColumnOnSurface: vi.fn(),
	moveSearchInputToIndex: vi.fn(),
	updateModule: vi.fn(),
}));
/* The workspace controller reads its module + tab from the URL; the harness
 * below feeds them here so the mocked `useLocation` reports the right screen. */
const harness = vi.hoisted(() => ({ moduleUuid: "" }));

vi.mock("@/lib/doc/hooks/useEntity", () => ({
	useModule: (uuid: string) => testStore.doc?.modules[uuid],
}));
vi.mock("@/lib/doc/hooks/useCaseTypes", () => ({
	useEffectiveCaseTypes: () =>
		Object.values(testStore.doc?.caseTypes ?? {}) as CaseType[],
}));
vi.mock("@/lib/doc/hooks/useCaseWorkspaceVerdicts", () => ({
	useCaseWorkspaceBoundaryVerdicts: () => ({
		filterBroken: false,
		searchInputsBroken: false,
		searchButtonConditionBroken: false,
		excludedOwnerIdsBroken: false,
		brokenColumnUuids: new Set<string>(),
	}),
}));
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		moveColumnOnSurface: mutationApi.moveColumnOnSurface,
		moveSearchInputToIndex: mutationApi.moveSearchInputToIndex,
		commitMany: mutationApi.commitMany,
		inline: {
			commitMany: mutationApi.commitMany,
			updateModule: mutationApi.updateModule,
		},
	}),
}));
vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => ({
		openSearchConfig: vi.fn(),
		openCaseList: vi.fn(),
		openDetailConfig: vi.fn(),
	}),
	useLocation: () => ({
		kind: "search-config",
		moduleUuid: harness.moduleUuid,
	}),
}));
vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => "app-1",
	useCanEdit: () => true,
	usePreviewing: () => false,
}));
vi.mock("@/lib/ui/hooks/useIsBreakpoint", () => ({
	useIsBreakpoint: () => false,
}));
vi.mock("@/lib/ui/hooks/useKeyboardShortcuts", () => ({
	useKeyboardShortcuts: () => undefined,
}));
vi.mock("@/components/builder/ContentFrame", () => ({
	ContentFrame: ({ children }: { readonly children: ReactNode }) => (
		<div>{children}</div>
	),
}));
vi.mock("../canvas/SearchCanvas", () => ({
	SearchCanvas: ({
		searchInputs,
		onSelect,
	}: {
		readonly searchInputs: readonly SearchInputDef[];
		readonly onSelect: (next: {
			readonly type: "input";
			readonly uuid: string;
		}) => void;
	}) => (
		<div>
			{searchInputs.map((input) => (
				<button
					key={input.uuid}
					type="button"
					data-case-search-field={input.uuid}
					onClick={() => onSelect({ type: "input", uuid: input.uuid })}
				>
					{input.label}
				</button>
			))}
		</div>
	),
}));
vi.mock("../inspector/SearchInputEditor", () => ({
	SearchInputEditor: ({
		onEditCondition,
	}: {
		readonly onEditCondition: () => void;
	}) => (
		<button type="button" onClick={onEditCondition}>
			Edit condition
		</button>
	),
}));
vi.mock("../canvas/CaseListCanvas", () => ({ CaseListCanvas: () => null }));
vi.mock("../canvas/DetailCanvas", () => ({ DetailCanvas: () => null }));
vi.mock("../configValidity", () => ({
	caseListConfigVerdicts: () => ({
		errorAreas: { search: false, list: false, detail: false },
		brokenColumns: new Set<string>(),
		filterBroken: false,
		searchButtonConditionBroken: false,
		excludedOwnerIdsBroken: false,
	}),
}));

function makeDoc(): BlueprintDoc {
	const predicate = and(
		lt(prop("client", "dob"), dateLiteral("2026-01-01")),
		eq(prop("client", "region"), literal("North")),
	);
	const input = advancedSearchInputDef(
		INPUT_UUID,
		"case_name",
		"Client name",
		"text",
		predicate,
	);
	return buildDoc({
		appName: "Search clone identity",
		caseTypes: [...CASE_TYPES],
		modules: [
			{
				uuid: MODULE_UUID,
				name: "Clients",
				caseType: "client",
				caseListConfig: { columns: [], searchInputs: [input] },
				forms: [
					{
						name: "Register client",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Client name",
								case_property_on: "client",
							}),
						],
					},
				],
			},
		],
	});
}

/* The workspace is now split into a shared controller (mounted by
 * `CaseListWorkspaceProvider`, reading the URL) feeding the center canvas and
 * the right-rail inspector. This harness reunites them, standing in for the old
 * single `CaseListConfigWorkspace` component. */
function HarnessInspector() {
	const ws = useCaseListWorkspace();
	if (!ws?.inspector) return null;
	return <aside>{ws.inspector.body}</aside>;
}

function CaseListConfigWorkspace({
	moduleUuid,
}: {
	moduleUuid: ReturnType<typeof asUuid>;
	tab: "search";
}) {
	harness.moduleUuid = moduleUuid;
	return (
		<CaseListWorkspaceProvider>
			<CaseListWorkspaceCanvas />
			<HarnessInspector />
		</CaseListWorkspaceProvider>
	);
}

function ReducerBackedWorkspace() {
	const [, setRevision] = useState(0);
	useLayoutEffect(() => {
		testStore.notify = () => setRevision((revision) => revision + 1);
		return () => {
			testStore.notify = undefined;
		};
	}, []);
	return <CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />;
}

function groupedDateInput(): HTMLInputElement {
	const region = [
		...document.querySelectorAll<HTMLElement>("[data-workbench-focus-id]"),
	].find((candidate) => candidate.dataset.workbenchFocusId === '["and",0]');
	const input = region?.querySelector<HTMLInputElement>('input[type="date"]');
	if (input === undefined || input === null) {
		throw new Error("Missing grouped Search date input");
	}
	return input;
}

describe("Search condition identity through document mutations", () => {
	beforeEach(() => {
		testStore.doc = makeDoc();
		testStore.notify = undefined;
		mutationApi.commitMany.mockReset();
		mutationApi.commitMany.mockImplementation((batch: readonly Mutation[]) => {
			const current = testStore.doc;
			if (current === undefined) throw new Error("Missing test document");
			testStore.doc = produce(current, (draft) => {
				applyMutations(draft, [...batch]);
			});
			testStore.notify?.();
			return { ok: true } as const;
		});
	});

	it("keeps the focused grouped date mounted through planner and reducer clones", () => {
		render(
			<StrictMode>
				<ReducerBackedWorkspace />
			</StrictMode>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Client name" }));
		fireEvent.click(screen.getByRole("button", { name: "Edit condition" }));
		const input = groupedDateInput();
		input.focus();

		fireEvent.change(input, { target: { value: "2026-02-02" } });

		expect(mutationApi.commitMany).toHaveBeenCalledOnce();
		expect(mutationApi.commitMany.mock.calls[0]?.[0]?.[0]).toMatchObject({
			kind: "updateSearchInput",
			moduleUuid: MODULE_UUID,
			uuid: INPUT_UUID,
		});
		expect(input.isConnected).toBe(true);
		expect(groupedDateInput()).toBe(input);
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe("2026-02-02");

		const saved =
			testStore.doc?.modules[MODULE_UUID]?.caseListConfig?.searchInputs[0];
		expect(saved?.kind).toBe("advanced");
		if (saved?.kind !== "advanced") throw new Error("Expected advanced input");
		expect(JSON.stringify(saved.predicate)).toContain("2026-02-02");
	});
});
