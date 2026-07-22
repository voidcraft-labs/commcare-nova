// @vitest-environment happy-dom

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { produce } from "immer";
import { type ReactNode, StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { applyMutations as replayMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import {
	advancedSearchInputDef,
	asUuid,
	type BlueprintDoc,
	type CaseSearchConfig,
	type CaseType,
	type Column,
	caseSearchConfigAfterFinalInputRemoval,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	eq,
	input as inputRef,
	matchAll,
	matchNone,
	type Predicate,
	predicateReferencesSearchInput,
	prop,
	sessionContext,
	term,
	type ValueExpression,
	whenInput,
} from "@/lib/domain/predicate";
import {
	CaseListWorkspaceCanvas,
	CaseListWorkspaceProvider,
	type CaseListWorkspaceTab,
	useCaseListWorkspace,
} from "../CaseListConfigWorkspace";
import { searchInputRemovalDependencies } from "../searchInputRemovalDependencies";

interface MutableWorkspaceModule {
	uuid: ReturnType<typeof asUuid>;
	id: string;
	name: string;
	caseType: string;
	caseListOnly: boolean;
	caseListConfig: {
		columns: Column[];
		searchInputs: SearchInputDef[];
		filter?: Predicate;
	};
	caseSearchConfig?: CaseSearchConfig;
}

const testState = vi.hoisted(() => ({
	module: undefined as unknown,
	caseTypes: [] as unknown[],
	brokenColumnUuids: [] as string[],
}));
const mutationApi = vi.hoisted(() => ({
	commitMany: vi.fn(),
	inlineCommitMany: vi.fn(),
	updateModule: vi.fn(),
	inlineUpdateModule: vi.fn(),
}));
const navigationApi = vi.hoisted(() => ({
	openSearchConfig: vi.fn(),
	openCaseList: vi.fn(),
	openDetailConfig: vi.fn(),
}));
/* The workspace controller reads its module + tab from the URL; the harness
 * below feeds them here so the mocked `useLocation` reports the right screen. */
const harness = vi.hoisted(() => ({
	moduleUuid: "",
	tab: "search" as "search" | "list" | "detail",
}));

vi.mock("@/lib/doc/hooks/useEntity", () => ({
	useModule: () => testState.module,
}));
vi.mock("@/lib/doc/hooks/useCaseTypes", () => ({
	useEffectiveCaseTypes: () => testState.caseTypes,
}));
vi.mock("@/lib/doc/hooks/useCaseWorkspaceVerdicts", () => ({
	useCaseWorkspaceBoundaryVerdicts: () => ({
		filterBroken: false,
		searchInputsBroken: false,
		searchButtonConditionBroken: false,
		excludedOwnerIdsBroken: false,
		brokenColumnUuids: testState.brokenColumnUuids,
	}),
}));
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		updateModule: mutationApi.updateModule,
		moveColumnOnSurface: vi.fn(),
		moveSearchInputToIndex: vi.fn(),
		commitMany: mutationApi.commitMany,
		inline: {
			updateModule: mutationApi.inlineUpdateModule,
			commitMany: mutationApi.inlineCommitMany,
		},
	}),
}));
vi.mock("@/lib/routing/hooks", () => ({
	useNavigate: () => navigationApi,
	useLocation: () => ({
		kind:
			harness.tab === "search"
				? "search-config"
				: harness.tab === "list"
					? "cases"
					: "detail-config",
		moduleUuid: harness.moduleUuid,
	}),
}));
vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => "app-1",
	useCanEdit: () => true,
}));
vi.mock("@/components/builder/ContentFrame", () => ({
	ContentFrame: ({ children }: { readonly children: ReactNode }) => (
		<div>{children}</div>
	),
}));
vi.mock("../ColumnEditor", () => ({
	ColumnEditor: ({
		value,
		onChange,
	}: {
		readonly value: Column;
		readonly onChange: (next: Column) => void;
	}) => (
		<>
			<h3>Column options</h3>
			<button
				type="button"
				onClick={() =>
					onChange({ ...value, header: `${value.header} updated` })
				}
			>
				Change information
			</button>
		</>
	),
}));
vi.mock("../inspector/SearchInputEditor", () => ({
	SearchInputEditor: ({
		value,
		onChange,
		onEditCondition,
	}: {
		readonly value: SearchInputDef;
		readonly onChange: (next: SearchInputDef) => void;
		readonly onEditCondition: () => void;
	}) => (
		<>
			<button type="button" onClick={onEditCondition}>
				Edit condition
			</button>
			<button
				type="button"
				onClick={() => onChange({ ...value, name: `${value.name}_renamed` })}
			>
				Rename search field
			</button>
		</>
	),
}));
vi.mock("../inspector/SearchPanelInspectorBody", () => ({
	SearchPanelInspectorBody: ({
		hasSearchAction,
		value,
		onChange,
		onEditDisplayCondition,
	}: {
		readonly hasSearchAction?: boolean;
		readonly value?: CaseSearchConfig;
		readonly onChange: (next: CaseSearchConfig) => void;
		readonly onEditDisplayCondition: (focusNewCondition?: boolean) => void;
	}) => (
		<div>
			{hasSearchAction ? "Search action in use" : "No Search action"}
			<button
				type="button"
				onClick={() =>
					onChange({ ...(value ?? {}), searchScreenTitle: "Find clients" })
				}
			>
				Change Search title
			</button>
			<button
				type="button"
				onClick={() => {
					onChange({
						...(value ?? {}),
						searchButtonDisplayCondition: { kind: "match-all" },
					});
					onEditDisplayCondition(true);
				}}
			>
				Add Search condition
			</button>
		</div>
	),
}));
vi.mock("../canvas/CaseListCanvas", () => ({
	CaseListCanvas: ({
		config,
		onSelect,
		onClearFilter,
		onColumnsChange,
		onShowColumn,
		caseSearchEnabled,
		dependencyReview,
		onReturnToSearchField,
		onExcludedOwnerIdsChange,
	}: {
		readonly config: { readonly columns: readonly Column[] };
		readonly onSelect: (next: {
			readonly type: "column";
			readonly uuid: string;
		}) => void;
		readonly onClearFilter: (next: undefined) => unknown;
		readonly onColumnsChange: (next: readonly Column[]) => void;
		readonly onShowColumn: (column: Column) => void;
		readonly caseSearchEnabled: boolean;
		readonly dependencyReview?: {
			readonly kind: "cases-available" | "assigned-cases";
			readonly path?: readonly (string | number)[];
		};
		readonly onReturnToSearchField?: () => void;
		readonly onExcludedOwnerIdsChange: (next: ValueExpression) => void;
	}) => (
		<div
			data-test-effective-search={caseSearchEnabled ? "enabled" : "disabled"}
		>
			{dependencyReview !== undefined ? (
				<div data-test-results-dependency={dependencyReview.kind}>
					<span>{JSON.stringify(dependencyReview.path ?? null)}</span>
					<button type="button" onClick={onReturnToSearchField}>
						Return to field review
					</button>
				</div>
			) : null}
			<button type="button" onClick={() => onClearFilter(undefined)}>
				Clear availability
			</button>
			<button
				type="button"
				onClick={() => onExcludedOwnerIdsChange(term(sessionContext("userid")))}
			>
				Hide assigned cases
			</button>
			<button
				type="button"
				onClick={() =>
					onColumnsChange(
						config.columns.map((column, index) =>
							index === 0
								? {
										...column,
										sort: { direction: "asc", priority: 1 },
									}
								: column,
						),
					)
				}
			>
				Set default order
			</button>
			{config.columns.map((column) => (
				<div key={column.uuid}>
					<button
						type="button"
						data-case-column-select={column.uuid}
						onClick={() => onSelect({ type: "column", uuid: column.uuid })}
					>
						{column.header}
					</button>
					{column.visibleInList === false && (
						<button type="button" onClick={() => onShowColumn(column)}>
							Show {column.header}
						</button>
					)}
				</div>
			))}
			<button type="button" data-case-add="list">
				Add information
			</button>
		</div>
	),
}));
vi.mock("../canvas/DetailCanvas", () => ({ DetailCanvas: () => null }));
vi.mock("../canvas/SearchConditionCanvas", () => ({
	SearchConditionCanvas: ({
		onBack,
		dependencyReview,
		focusRequest,
	}: {
		readonly onBack: () => void;
		readonly dependencyReview?: {
			readonly path: readonly (string | number)[];
		};
		readonly focusRequest?: {
			readonly path: readonly (string | number)[];
			readonly focusTarget?: "heading" | "first-control";
		};
	}) => (
		<div data-test-search-condition>
			{dependencyReview !== undefined ? (
				<output data-test-condition-dependency>
					{JSON.stringify(dependencyReview.path)}
				</output>
			) : null}
			{focusRequest !== undefined ? (
				<output data-test-new-condition-focus>
					{JSON.stringify(focusRequest)}
				</output>
			) : null}
			<button type="button" onClick={onBack}>
				{dependencyReview === undefined
					? "Return to Search"
					: "Return to field review"}
			</button>
		</div>
	),
}));
vi.mock("../configValidity", () => ({
	caseListConfigVerdicts: () => ({
		errorAreas: { search: false, list: false, detail: false },
		brokenColumns: new Set<string>(testState.brokenColumnUuids),
		filterBroken: false,
	}),
}));

const MODULE_UUID = asUuid("00000000-0000-4000-8000-000000000001");

/* The workspace is now split: a shared controller (mounted by
 * `CaseListWorkspaceProvider`, reading the URL) feeds the center canvas and the
 * right-rail inspector. This harness reunites them for the DOM assertions —
 * standing in for the old single `CaseListConfigWorkspace` component so the
 * render call sites below are unchanged. The inspector wrapper mirrors the rail
 * chrome the assertions expect (an `aria-label={title}` region with a "Close
 * properties" button). */
function HarnessInspector() {
	const ws = useCaseListWorkspace();
	if (!ws?.inspector) return null;
	return (
		<aside aria-label={ws.inspector.title}>
			<button type="button" onClick={ws.onClose}>
				Close properties
			</button>
			{ws.inspector.body}
		</aside>
	);
}

function CaseListConfigWorkspace({
	moduleUuid,
	tab,
}: {
	moduleUuid: ReturnType<typeof asUuid>;
	tab: CaseListWorkspaceTab;
}) {
	harness.moduleUuid = moduleUuid;
	harness.tab = tab;
	return (
		<CaseListWorkspaceProvider>
			<CaseListWorkspaceCanvas />
			<HarnessInspector />
		</CaseListWorkspaceProvider>
	);
}
const FIRST_UUID = asUuid("00000000-0000-4000-8000-000000000011");
const SECOND_UUID = asUuid("00000000-0000-4000-8000-000000000012");
const COLUMN_UUID = asUuid("00000000-0000-4000-8000-000000000021");
const SECOND_COLUMN_UUID = asUuid("00000000-0000-4000-8000-000000000022");
const PEER_COLUMN_UUID = asUuid("00000000-0000-4000-8000-000000000023");
const NAME_COLUMN: Column = {
	uuid: COLUMN_UUID,
	kind: "plain",
	field: "case_name",
	header: "Client name",
};
const SECOND_COLUMN: Column = {
	uuid: SECOND_COLUMN_UUID,
	kind: "plain",
	field: "external_id",
	header: "External ID",
};
const PEER_COLUMN: Column = {
	uuid: PEER_COLUMN_UUID,
	kind: "plain",
	field: "external_id",
	header: "Peer-added information",
};
const CASE_TYPES: CaseType[] = [
	{
		name: "client",
		properties: [
			{ name: "case_name", label: "Client name", data_type: "text" },
			{ name: "external_id", label: "External ID", data_type: "text" },
		],
	},
];

function input(uuid: typeof FIRST_UUID, name: string, label: string) {
	return simpleSearchInputDef(uuid, name, label, "text", name);
}

function makeModule(
	searchInputs: MutableWorkspaceModule["caseListConfig"]["searchInputs"],
	caseSearchConfig: CaseSearchConfig = {},
	filter?: Predicate,
	columns: Column[] = [],
): MutableWorkspaceModule {
	return {
		uuid: MODULE_UUID,
		id: "clients",
		name: "Clients",
		caseType: "client",
		caseListOnly: false,
		caseListConfig: { columns, searchInputs, filter },
		caseSearchConfig,
	};
}

function inputDrivenCondition(name: string): Predicate {
	return whenInput(
		inputRef(name),
		eq(prop("client", "case_name"), inputRef(name)),
	);
}

function workspaceDoc(args: {
	readonly columns?: readonly Column[];
	readonly searchInputs?: readonly SearchInputDef[];
	readonly filter?: Predicate;
	readonly caseSearchConfig?: CaseSearchConfig;
}): BlueprintDoc {
	return buildDoc({
		appName: "Workspace concurrency",
		caseTypes: CASE_TYPES,
		modules: [
			{
				uuid: MODULE_UUID,
				name: "Clients",
				caseType: "client",
				caseListConfig: {
					columns: [...(args.columns ?? [])],
					searchInputs: [...(args.searchInputs ?? [])],
					...(args.filter !== undefined && { filter: args.filter }),
				},
				...(args.caseSearchConfig !== undefined && {
					caseSearchConfig: args.caseSearchConfig,
				}),
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
							f({
								kind: "text",
								id: "external_id",
								label: "External ID",
								case_property_on: "client",
							}),
						],
					},
				],
			},
		],
	});
}

function capturedBatch(spy: typeof mutationApi.commitMany): Mutation[] {
	const call = spy.mock.calls.at(-1);
	if (call === undefined)
		throw new Error("Expected a committed mutation batch");
	return structuredClone(call[0] as Mutation[]);
}

function replayAfterPeerEdit(
	base: BlueprintDoc,
	batch: readonly Mutation[],
	editPeer: (doc: BlueprintDoc) => void,
): BlueprintDoc {
	return produce(base, (draft) => {
		editPeer(draft as unknown as BlueprintDoc);
		replayMutations(draft, [...batch]);
	});
}

function applyMutations(batch: readonly Mutation[]): { readonly ok: true } {
	const module = testState.module as MutableWorkspaceModule;
	for (const mutation of batch) {
		switch (mutation.kind) {
			case "removeSearchInput":
				module.caseListConfig.searchInputs =
					module.caseListConfig.searchInputs.filter(
						(candidate) => candidate.uuid !== mutation.uuid,
					);
				break;
			case "updateModule": {
				if (mutation.caseSearchConfigOperation === "enable") {
					if (module.caseSearchConfig === undefined)
						module.caseSearchConfig = {};
					else if (module.caseSearchConfig.searchActionEnabled === false) {
						const { searchActionEnabled: _disabled, ...enabled } =
							module.caseSearchConfig;
						module.caseSearchConfig = enabled;
					}
					break;
				}
				if (
					mutation.caseSearchConfigOperation === "cleanup-after-final-input"
				) {
					if (module.caseListConfig.searchInputs.length > 0) break;
					const next = caseSearchConfigAfterFinalInputRemoval(
						module.caseSearchConfig,
						effectiveFilterForEmission(module.caseListConfig.filter) !==
							undefined,
					);
					if (next === undefined) delete module.caseSearchConfig;
					else module.caseSearchConfig = next;
					break;
				}
				if (mutation.caseSearchConfigOperation === "set-owner-only") {
					module.caseSearchConfig = mutation.caseSearchConfigValue;
					break;
				}
				const patch = mutation.patch as {
					readonly caseSearchConfig?: CaseSearchConfig | null;
				};
				if (patch.caseSearchConfig === null) delete module.caseSearchConfig;
				else if (patch.caseSearchConfig !== undefined) {
					module.caseSearchConfig = patch.caseSearchConfig;
				}
				break;
			}
		}
	}
	return { ok: true };
}

describe("Search field removal", () => {
	beforeEach(() => {
		testState.caseTypes = CASE_TYPES;
		testState.brokenColumnUuids = [];
		mutationApi.commitMany.mockReset();
		mutationApi.inlineCommitMany.mockReset();
		mutationApi.updateModule.mockReset();
		mutationApi.inlineUpdateModule.mockReset();
		navigationApi.openSearchConfig.mockReset();
		navigationApi.openCaseList.mockReset();
		navigationApi.openDetailConfig.mockReset();
		mutationApi.commitMany.mockImplementation(applyMutations);
		mutationApi.inlineCommitMany.mockImplementation(applyMutations);
		mutationApi.inlineUpdateModule.mockReturnValue({ ok: true });
	});

	it("authors and opens an intentional zero-input Search action", () => {
		const module = makeModule([], {});
		delete module.caseSearchConfig;
		testState.module = module;
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);

		expect(screen.getByText("No search fields")).toBeDefined();
		fireEvent.click(
			screen.getByRole("button", { name: "Change when people continue" }),
		);

		expect(mutationApi.commitMany).toHaveBeenLastCalledWith([
			{
				kind: "updateModule",
				uuid: MODULE_UUID,
				patch: { caseSearchConfig: {} },
				caseSearchConfigOperation: "enable",
			},
		]);
		expect(module.caseSearchConfig).toEqual({});
		expect(screen.getByText("Search action in use")).toBeDefined();
	});

	it("enters a newly added Search condition at the condition itself", () => {
		testState.module = makeModule([
			input(FIRST_UUID, "case_name", "Client name"),
		]);
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);

		fireEvent.click(screen.getByRole("button", { name: "Edit Search screen" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Add Search condition" }),
		);

		expect(
			document.querySelector("[data-test-new-condition-focus]")?.textContent,
		).toBe('{"token":1,"path":[],"focusTarget":"first-control"}');
		expect(
			document.querySelector("[data-test-search-condition]"),
		).toBeDefined();
	});

	it("returns focus to the Search field that opened properties", async () => {
		testState.module = makeModule([
			input(FIRST_UUID, "case_name", "Client name"),
		]);
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);

		const origin = document.querySelector<HTMLButtonElement>(
			`[data-case-search-field="${FIRST_UUID}"]`,
		);
		if (origin === null) throw new Error("Missing Search field origin");
		fireEvent.click(origin);
		const close = screen.getByRole("button", { name: "Close properties" });
		close.focus();
		fireEvent.click(close);

		await waitFor(() => expect(document.activeElement).toBe(origin));
		expect(origin.hasAttribute("data-inspector-return-focus")).toBe(false);
	});

	it("returns focus to Search screen settings when Escape closes properties", async () => {
		testState.module = makeModule([
			input(FIRST_UUID, "case_name", "Client name"),
		]);
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);

		const origin = screen.getByRole("button", { name: "Edit Search screen" });
		fireEvent.click(origin);
		const close = screen.getByRole("button", { name: "Close properties" });
		close.focus();
		fireEvent.keyDown(document, { key: "Escape" });

		await waitFor(() => expect(document.activeElement).toBe(origin));
	});

	it("returns focus to the Results field that opened properties", async () => {
		testState.module = makeModule([], {}, undefined, [NAME_COLUMN]);
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);

		const origin = document.querySelector<HTMLButtonElement>(
			`[data-case-column-select="${COLUMN_UUID}"]`,
		);
		if (origin === null) throw new Error("Missing Results field origin");
		fireEvent.click(origin);
		const close = screen.getByRole("button", { name: "Close properties" });
		close.focus();
		fireEvent.click(close);

		await waitFor(() => expect(document.activeElement).toBe(origin));
	});

	it("moves focus to the next Search field", async () => {
		testState.module = makeModule([
			input(FIRST_UUID, "case_name", "Client name"),
			input(SECOND_UUID, "external_id", "External ID"),
		]);
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);

		fireEvent.click(
			document.querySelector<HTMLButtonElement>(
				`[data-case-search-field="${FIRST_UUID}"]`,
			) as HTMLButtonElement,
		);
		const removeSearchField = screen.getByRole("button", {
			name: "Remove search field",
		});
		expect(removeSearchField.className).toContain("bg-destructive");
		fireEvent.click(removeSearchField);

		await waitFor(() => {
			expect(document.activeElement).toBe(
				document.querySelector(`[data-case-search-field="${SECOND_UUID}"]`),
			);
		});
	});

	it("names gate-clean rules that must be updated before a field can be removed", async () => {
		const first = input(FIRST_UUID, "case_name", "Client name");
		const second = advancedSearchInputDef(
			SECOND_UUID,
			"external_id",
			"External ID",
			"text",
			inputDrivenCondition("case_name"),
		);
		const filter = inputDrivenCondition("case_name");
		const doc = buildDoc({
			appName: "Search removal",
			caseTypes: CASE_TYPES,
			modules: [
				{
					name: "Clients",
					caseType: "client",
					caseListConfig: {
						columns: [NAME_COLUMN],
						searchInputs: [first, second],
						filter,
					},
					caseSearchConfig: {},
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
								f({
									kind: "text",
									id: "external_id",
									label: "External ID",
									case_property_on: "client",
								}),
							],
						},
					],
				},
			],
		});
		expect(runValidation(doc)).toEqual([]);

		const module = makeModule([first, second], {}, filter);
		testState.module = module;
		expect(
			searchInputRemovalDependencies(
				module.caseListConfig,
				module.caseSearchConfig,
				FIRST_UUID,
			),
		).toEqual([
			{
				kind: "cases-available",
				label: "Cases available",
				paths: [
					["when-input-present", "input"],
					["when-input-present", "clause", "right"],
				],
			},
			{
				kind: "search-field-condition",
				label: "“External ID” search condition",
				inputUuid: SECOND_UUID,
				paths: [
					["when-input-present", "input"],
					["when-input-present", "clause", "right"],
				],
			},
		]);

		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);
		fireEvent.click(
			document.querySelector<HTMLButtonElement>(
				`[data-case-search-field="${FIRST_UUID}"]`,
			) as HTMLButtonElement,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Remove search field" }),
		);

		expect(
			screen.getByRole("heading", {
				name: "This field is used in other rules",
			}),
		).toBeDefined();
		expect(
			screen.getByRole("list", { name: "Rules using Client name" }).textContent,
		).toContain("Cases available");
		expect(
			screen.getByRole("list", { name: "Rules using Client name" }).textContent,
		).toContain("“External ID” search condition");
		expect(screen.getAllByText("Uses this answer in 2 places")).toHaveLength(2);
		expect(mutationApi.commitMany).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Keep field" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(mutationApi.commitMany).not.toHaveBeenCalled();
	});

	it("completes dependency review after Strict Mode replay and callback rerenders", async () => {
		const first = input(FIRST_UUID, "case_name", "Client name");
		const second = advancedSearchInputDef(
			SECOND_UUID,
			"external_id",
			"External ID",
			"text",
			inputDrivenCondition("case_name"),
		);
		const module = makeModule(
			[first, second],
			{},
			inputDrivenCondition("case_name"),
		);
		testState.module = module;
		const { rerender } = render(
			<StrictMode>
				<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />
			</StrictMode>,
		);
		fireEvent.click(
			document.querySelector<HTMLButtonElement>(
				`[data-case-search-field="${FIRST_UUID}"]`,
			) as HTMLButtonElement,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Remove search field" }),
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: /Cases available.*Uses this answer in 2 places.*Review/i,
			}),
		);
		expect(navigationApi.openCaseList).toHaveBeenCalledWith(MODULE_UUID);
		rerender(
			<StrictMode>
				<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />
			</StrictMode>,
		);
		expect(
			document.querySelector("[data-test-results-dependency='cases-available']")
				?.textContent,
		).toContain('["when-input-present","input"]');

		module.caseListConfig.filter = eq(
			prop("client", "case_name"),
			inputRef("case_name"),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Return to field review" }),
		);
		expect(navigationApi.openSearchConfig).toHaveBeenCalledWith(MODULE_UUID);
		rerender(
			<StrictMode>
				<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />
			</StrictMode>,
		);

		await waitFor(() => {
			expect(
				screen.getByRole("button", {
					name: /Cases available.*Uses this answer once.*Review/i,
				}),
			).toBeDefined();
		});

		fireEvent.click(
			screen.getByRole("button", {
				name: /External ID.*Uses this answer in 2 places.*Review/i,
			}),
		);
		expect(
			document.querySelector("[data-test-condition-dependency]")?.textContent,
		).toBe('["when-input-present","input"]');
		module.caseListConfig.filter = matchAll();
		const sibling = module.caseListConfig.searchInputs.find(
			(candidate) => candidate.uuid === SECOND_UUID,
		);
		if (sibling?.kind !== "advanced") {
			throw new Error("Expected advanced sibling Search field");
		}
		sibling.predicate = matchAll();
		fireEvent.click(
			screen.getByRole("button", { name: "Return to field review" }),
		);

		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Remove search field" }),
			),
		);
		expect(
			screen.getByText(
				"No rules use Client name now. You can remove the field.",
			),
		).toBeDefined();
	});

	it("replays an inspector column edit without erasing peer columns or availability", () => {
		const base = workspaceDoc({ columns: [NAME_COLUMN, SECOND_COLUMN] });
		testState.module = base.modules[MODULE_UUID];
		mutationApi.commitMany.mockReturnValue({ ok: true });
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);

		fireEvent.click(
			document.querySelector<HTMLButtonElement>(
				`[data-case-column-select="${COLUMN_UUID}"]`,
			) as HTMLButtonElement,
		);
		fireEvent.click(screen.getByRole("button", { name: "Change information" }));
		const batch = capturedBatch(mutationApi.commitMany);
		expect(batch.map((mutation) => mutation.kind)).toEqual(["updateColumn"]);

		const peerFilter = matchNone();
		const replayed = replayAfterPeerEdit(base, batch, (doc) => {
			const config = doc.modules[MODULE_UUID].caseListConfig;
			if (config === undefined) throw new Error("Missing case-list config");
			config.columns.push(PEER_COLUMN);
			const sibling = config.columns.find(
				(column) => column.uuid === SECOND_COLUMN_UUID,
			);
			if (sibling !== undefined) sibling.header = "Peer-edited External ID";
			config.filter = peerFilter;
		});
		const replayedConfig = replayed.modules[MODULE_UUID].caseListConfig;
		expect(replayedConfig?.columns).toHaveLength(3);
		expect(
			replayedConfig?.columns.find((column) => column.uuid === COLUMN_UUID)
				?.header,
		).toBe("Client name updated");
		expect(
			replayedConfig?.columns.find(
				(column) => column.uuid === SECOND_COLUMN_UUID,
			)?.header,
		).toBe("Peer-edited External ID");
		expect(replayedConfig?.filter).toEqual(peerFilter);
	});

	it("replays Default order as a sort-only edit over fresh peer content", () => {
		const base = workspaceDoc({ columns: [NAME_COLUMN, SECOND_COLUMN] });
		testState.module = base.modules[MODULE_UUID];
		mutationApi.commitMany.mockReturnValue({ ok: true });
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);

		fireEvent.click(screen.getByRole("button", { name: "Set default order" }));
		const batch = capturedBatch(mutationApi.commitMany);
		expect(batch.map((mutation) => mutation.kind)).toEqual(["updateColumn"]);

		const peerFilter = matchNone();
		const replayed = replayAfterPeerEdit(base, batch, (doc) => {
			const config = doc.modules[MODULE_UUID].caseListConfig;
			if (config === undefined) throw new Error("Missing case-list config");
			const target = config.columns.find(
				(column) => column.uuid === COLUMN_UUID,
			);
			if (target !== undefined) target.header = "Peer-edited client name";
			config.columns.push(PEER_COLUMN);
			config.filter = peerFilter;
		});
		const replayedConfig = replayed.modules[MODULE_UUID].caseListConfig;
		const target = replayedConfig?.columns.find(
			(column) => column.uuid === COLUMN_UUID,
		);
		expect(target?.sort).toEqual({ direction: "asc", priority: 1 });
		expect(target?.header).toBe("Peer-edited client name");
		expect(replayedConfig?.columns).toHaveLength(3);
		expect(replayedConfig?.filter).toEqual(peerFilter);
	});

	it("replays hide and show as surface-only edits over peer content", () => {
		const base = workspaceDoc({ columns: [NAME_COLUMN, SECOND_COLUMN] });
		testState.module = base.modules[MODULE_UUID];
		mutationApi.commitMany.mockReturnValue({ ok: true });
		const { unmount } = render(
			<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />,
		);
		fireEvent.click(
			document.querySelector<HTMLButtonElement>(
				`[data-case-column-select="${COLUMN_UUID}"]`,
			) as HTMLButtonElement,
		);
		fireEvent.click(screen.getByRole("button", { name: "Hide from Results" }));
		const hideBatch = capturedBatch(mutationApi.commitMany);
		const hidden = replayAfterPeerEdit(base, hideBatch, (doc) => {
			const config = doc.modules[MODULE_UUID].caseListConfig;
			if (config === undefined) throw new Error("Missing case-list config");
			const target = config.columns.find(
				(column) => column.uuid === COLUMN_UUID,
			);
			if (target !== undefined) target.header = "Peer-edited client name";
			config.columns.push(PEER_COLUMN);
			config.filter = matchNone();
		});
		const hiddenTarget = hidden.modules[
			MODULE_UUID
		].caseListConfig?.columns.find((column) => column.uuid === COLUMN_UUID);
		expect(hiddenTarget?.visibleInList).toBe(false);
		expect(hiddenTarget?.header).toBe("Peer-edited client name");
		expect(hidden.modules[MODULE_UUID].caseListConfig?.columns).toHaveLength(3);

		unmount();
		mutationApi.inlineCommitMany.mockReturnValue({ ok: true });
		testState.module = hidden.modules[MODULE_UUID];
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);
		fireEvent.click(
			screen.getByRole("button", { name: "Show Peer-edited client name" }),
		);
		const showBatch = capturedBatch(mutationApi.inlineCommitMany);
		const shown = replayAfterPeerEdit(hidden, showBatch, (doc) => {
			const config = doc.modules[MODULE_UUID].caseListConfig;
			if (config === undefined) throw new Error("Missing case-list config");
			const sibling = config.columns.find(
				(column) => column.uuid === SECOND_COLUMN_UUID,
			);
			if (sibling !== undefined) sibling.header = "Peer-edited sibling";
		});
		const shownTarget = shown.modules[MODULE_UUID].caseListConfig?.columns.find(
			(column) => column.uuid === COLUMN_UUID,
		);
		expect(shownTarget?.visibleInList).not.toBe(false);
		expect(shownTarget?.header).toBe("Peer-edited client name");
		expect(
			shown.modules[MODULE_UUID].caseListConfig?.columns.find(
				(column) => column.uuid === SECOND_COLUMN_UUID,
			)?.header,
		).toBe("Peer-edited sibling");
	});

	it("replays repair and reveal as one granular batch", () => {
		const hiddenColumn = { ...NAME_COLUMN, visibleInList: false };
		const base = workspaceDoc({ columns: [hiddenColumn, SECOND_COLUMN] });
		testState.module = base.modules[MODULE_UUID];
		testState.brokenColumnUuids = [COLUMN_UUID];
		mutationApi.inlineCommitMany.mockReturnValue({ ok: true });
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);

		fireEvent.click(screen.getByRole("button", { name: "Show Client name" }));
		expect(mutationApi.inlineCommitMany).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Change information" }));
		const batch = capturedBatch(mutationApi.inlineCommitMany);
		expect(batch.map((mutation) => mutation.kind)).toContain("updateColumn");

		const replayed = replayAfterPeerEdit(base, batch, (doc) => {
			const config = doc.modules[MODULE_UUID].caseListConfig;
			if (config === undefined) throw new Error("Missing case-list config");
			config.columns.push(PEER_COLUMN);
			config.filter = matchNone();
			const sibling = config.columns.find(
				(column) => column.uuid === SECOND_COLUMN_UUID,
			);
			if (sibling !== undefined) sibling.header = "Peer-edited sibling";
		});
		const replayedConfig = replayed.modules[MODULE_UUID].caseListConfig;
		const target = replayedConfig?.columns.find(
			(column) => column.uuid === COLUMN_UUID,
		);
		expect(target?.header).toBe("Client name updated");
		expect(target?.visibleInList).not.toBe(false);
		expect(replayedConfig?.columns).toHaveLength(3);
		expect(replayedConfig?.filter).toEqual(matchNone());
	});

	it("replays a Search-field rename over fresh peer inputs and references", () => {
		const first = input(FIRST_UUID, "case_name", "Client name");
		const second = advancedSearchInputDef(
			SECOND_UUID,
			"external_id",
			"External ID",
			"text",
			inputDrivenCondition("case_name"),
		);
		const base = workspaceDoc({
			searchInputs: [first, second],
			filter: inputDrivenCondition("case_name"),
			caseSearchConfig: {
				excludedOwnerIds: term(inputRef("case_name")),
			},
		});
		testState.module = base.modules[MODULE_UUID];
		mutationApi.commitMany.mockReturnValue({ ok: true });
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);
		fireEvent.click(
			document.querySelector<HTMLButtonElement>(
				`[data-case-search-field="${FIRST_UUID}"]`,
			) as HTMLButtonElement,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Rename search field" }),
		);
		const batch = capturedBatch(mutationApi.commitMany);
		expect(batch.map((mutation) => mutation.kind)).toEqual([
			"updateSearchInput",
		]);

		const peerInput = input(
			asUuid("00000000-0000-4000-8000-000000000013"),
			"peer_added",
			"Peer-added search",
		);
		const replayed = replayAfterPeerEdit(base, batch, (doc) => {
			const module = doc.modules[MODULE_UUID];
			const config = module.caseListConfig;
			if (config === undefined) throw new Error("Missing case-list config");
			config.searchInputs.push(peerInput);
			const sibling = config.searchInputs.find(
				(candidate) => candidate.uuid === SECOND_UUID,
			);
			if (sibling !== undefined) sibling.label = "Peer-edited External ID";
		});
		const replayedModule = replayed.modules[MODULE_UUID];
		const replayedConfig = replayedModule.caseListConfig;
		expect(replayedConfig?.searchInputs).toHaveLength(3);
		expect(
			replayedConfig?.searchInputs.find(
				(candidate) => candidate.uuid === FIRST_UUID,
			)?.name,
		).toBe("case_name_renamed");
		expect(
			replayedConfig?.searchInputs.find(
				(candidate) => candidate.uuid === SECOND_UUID,
			)?.label,
		).toBe("Peer-edited External ID");
		expect(
			predicateReferencesSearchInput(
				replayedConfig?.filter ?? matchNone(),
				"case_name_renamed",
			),
		).toBe(true);
		const sibling = replayedConfig?.searchInputs.find(
			(candidate) => candidate.uuid === SECOND_UUID,
		);
		expect(
			sibling?.kind === "advanced" &&
				predicateReferencesSearchInput(sibling.predicate, "case_name_renamed"),
		).toBe(true);
		expect(replayedModule.caseSearchConfig?.excludedOwnerIds).toMatchObject({
			kind: "term",
			term: { kind: "input", name: "case_name_renamed" },
		});
	});

	it("replays a Search-screen setting without erasing peer Search settings", () => {
		const base = workspaceDoc({
			searchInputs: [input(FIRST_UUID, "case_name", "Client name")],
			caseSearchConfig: { searchButtonLabel: "Search now" },
		});
		testState.module = base.modules[MODULE_UUID];
		mutationApi.commitMany.mockReturnValue({ ok: true });
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);

		fireEvent.click(screen.getByRole("button", { name: "Edit Search screen" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Change Search title" }),
		);
		const batch = capturedBatch(mutationApi.commitMany);
		expect(batch).toHaveLength(1);
		expect(batch[0]).toMatchObject({
			kind: "updateModule",
			caseSearchConfigPatch: { searchScreenTitle: "Find clients" },
		});

		const replayed = replayAfterPeerEdit(base, batch, (doc) => {
			const module = doc.modules[MODULE_UUID];
			module.caseSearchConfig = {
				...module.caseSearchConfig,
				searchButtonLabel: "Peer Search label",
				searchScreenSubtitle: "Peer subtitle",
			};
		});
		expect(replayed.modules[MODULE_UUID].caseSearchConfig).toMatchObject({
			searchScreenTitle: "Find clients",
			searchButtonLabel: "Peer Search label",
			searchScreenSubtitle: "Peer subtitle",
		});
	});

	it("replays Assigned cases as one setting over a peer Search edit", () => {
		const base = workspaceDoc({
			caseSearchConfig: { searchScreenTitle: "Find a client" },
		});
		testState.module = base.modules[MODULE_UUID];
		mutationApi.commitMany.mockReturnValue({ ok: true });
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);

		fireEvent.click(
			screen.getByRole("button", { name: "Hide assigned cases" }),
		);
		const batch = capturedBatch(mutationApi.commitMany);
		expect(batch).toHaveLength(1);
		expect(batch[0]).toMatchObject({
			kind: "updateModule",
			caseSearchConfigPatch: {
				excludedOwnerIds: term(sessionContext("userid")),
			},
		});

		const replayed = replayAfterPeerEdit(base, batch, (doc) => {
			doc.modules[MODULE_UUID].caseSearchConfig = {
				...doc.modules[MODULE_UUID].caseSearchConfig,
				searchButtonLabel: "Peer Search label",
			};
		});
		expect(replayed.modules[MODULE_UUID].caseSearchConfig).toMatchObject({
			searchScreenTitle: "Find a client",
			searchButtonLabel: "Peer Search label",
			excludedOwnerIds: term(sessionContext("userid")),
		});
	});

	it("keeps a peer-enabled Search action when a stale Results edit adds Assigned cases", () => {
		const base = workspaceDoc({});
		testState.module = base.modules[MODULE_UUID];
		mutationApi.commitMany.mockReturnValue({ ok: true });
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);

		fireEvent.click(
			screen.getByRole("button", { name: "Hide assigned cases" }),
		);
		const batch = capturedBatch(mutationApi.commitMany);
		expect(batch).toHaveLength(1);
		expect(batch[0]).toMatchObject({
			kind: "updateModule",
			caseSearchConfigOperation: "set-owner-only",
		});

		const replayed = replayAfterPeerEdit(base, batch, (doc) => {
			doc.modules[MODULE_UUID].caseSearchConfig = {
				searchScreenTitle: "Peer-enabled Search",
				searchButtonLabel: "Find",
			};
		});
		expect(replayed.modules[MODULE_UUID].caseSearchConfig).toEqual({
			searchScreenTitle: "Peer-enabled Search",
			searchButtonLabel: "Find",
			excludedOwnerIds: term(sessionContext("userid")),
		});
	});

	it("clears only availability when independent Search and assigned-case settings exist", () => {
		const caseSearchConfig: CaseSearchConfig = {
			excludedOwnerIds: term(sessionContext("userid")),
			searchScreenTitle: "Find a client",
			searchButtonLabel: "Find",
		};
		testState.module = makeModule([], caseSearchConfig, matchNone());
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);

		fireEvent.click(screen.getByRole("button", { name: "Clear availability" }));

		expect(mutationApi.commitMany).toHaveBeenLastCalledWith([
			{
				kind: "setCaseListMeta",
				uuid: MODULE_UUID,
				patch: { filter: null },
			},
		]);
		expect(testState.module).toMatchObject({ caseSearchConfig });
	});

	it("passes owner-only storage to Results without enabling case-search admission", () => {
		testState.module = makeModule(
			[],
			{
				searchActionEnabled: false,
				excludedOwnerIds: term(sessionContext("userid")),
			},
			matchAll(),
		);
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);

		expect(
			document
				.querySelector("[data-test-effective-search]")
				?.getAttribute("data-test-effective-search"),
		).toBe("disabled");
	});

	it("keeps an intentional zero-input Search action after availability is cleared", () => {
		testState.module = makeModule([], {}, matchNone());
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="list" />);

		fireEvent.click(screen.getByRole("button", { name: "Clear availability" }));

		expect(mutationApi.commitMany).toHaveBeenLastCalledWith([
			{
				kind: "setCaseListMeta",
				uuid: MODULE_UUID,
				patch: { filter: null },
			},
		]);
		expect(
			(testState.module as MutableWorkspaceModule).caseSearchConfig,
		).toEqual({});
	});

	it("preserves the assigned-case rule and focuses Add search field", async () => {
		const excludedOwnerIds = term(sessionContext("userid"));
		testState.module = makeModule(
			[input(FIRST_UUID, "case_name", "Client name")],
			{
				excludedOwnerIds,
				searchScreenTitle: "Find a client",
				searchButtonLabel: "Find",
			},
		);
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);

		fireEvent.click(
			document.querySelector<HTMLButtonElement>(
				`[data-case-search-field="${FIRST_UUID}"]`,
			) as HTMLButtonElement,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Remove search field" }),
		);
		expect(
			screen.getByRole("heading", {
				name: "Remove the last Search field?",
			}),
		).toBeDefined();
		expect(
			screen.getByText(
				/custom title will also be removed.*custom Search action label will stay in More settings.*Cases available and the Results layout won’t change.*assigned cases setting won’t change/i,
			),
		).toBeDefined();

		await Promise.resolve();
		fireEvent.click(screen.getByRole("button", { name: "Remove field" }));

		await waitFor(() => {
			expect(document.activeElement).toBe(
				document.querySelector("[data-case-add-search-field]"),
			);
		});
		expect(
			(testState.module as MutableWorkspaceModule).caseSearchConfig,
		).toEqual({ excludedOwnerIds, searchButtonLabel: "Find" });
		expect(
			screen.getByText(
				"Search screen removed. Cases available, the Search action, and the Results layout are unchanged.",
			),
		).toBeDefined();
	});

	it("confirms removing the final field even with default Search settings", async () => {
		testState.module = makeModule([
			input(FIRST_UUID, "case_name", "Client name"),
		]);
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);

		fireEvent.click(
			document.querySelector<HTMLButtonElement>(
				`[data-case-search-field="${FIRST_UUID}"]`,
			) as HTMLButtonElement,
		);
		const removeButton = screen.getByRole("button", {
			name: "Remove search field",
		});
		removeButton.focus();
		fireEvent.click(removeButton);

		const dialog = screen.getByRole("alertdialog");
		expect(
			screen.getByRole("heading", {
				name: "Remove the last Search field?",
			}),
		).toBeDefined();
		expect(
			screen.getByText(
				/Search screen will be removed.*browse Results without searching first.*Cases available and the Results layout won’t change/i,
			),
		).toBeDefined();
		expect(mutationApi.commitMany).not.toHaveBeenCalled();

		fireEvent.click(
			dialog.querySelector<HTMLButtonElement>(
				'[data-slot="alert-dialog-cancel"]',
			) as HTMLButtonElement,
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(removeButton));
		expect(mutationApi.commitMany).not.toHaveBeenCalled();

		fireEvent.click(removeButton);
		fireEvent.click(screen.getByRole("button", { name: "Remove field" }));
		await waitFor(() => {
			expect(document.activeElement).toBe(
				document.querySelector("[data-case-add-search-field]"),
			);
		});
		expect(mutationApi.commitMany).toHaveBeenCalledOnce();
	});

	it("restores the Search overview scroll only after the condition canvas unmounts", async () => {
		const advanced = advancedSearchInputDef(
			FIRST_UUID,
			"case_name",
			"Client name",
			"text",
			matchAll(),
		);
		testState.module = makeModule([advanced]);
		render(<CaseListConfigWorkspace moduleUuid={MODULE_UUID} tab="search" />);

		const scroller = document.querySelector<HTMLElement>(
			'[data-case-workspace-scroll-body="search"]',
		);
		if (scroller === null) throw new Error("Missing Search scroller");
		let scrollTop = 800;
		Object.defineProperty(scroller, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (next: number) => {
				// The condition canvas is intentionally much shorter than the
				// overview. A restore against it clamps the saved deep position.
				const max = document.querySelector("[data-test-search-condition]")
					? 120
					: 1200;
				scrollTop = Math.min(next, max);
			},
		});

		fireEvent.click(
			document.querySelector<HTMLButtonElement>(
				`[data-case-search-field="${FIRST_UUID}"]`,
			) as HTMLButtonElement,
		);
		fireEvent.click(screen.getByRole("button", { name: "Edit condition" }));
		await waitFor(() => {
			expect(
				document.querySelector("[data-test-search-condition]"),
			).not.toBeNull();
			expect(scroller.scrollTop).toBe(0);
		});

		fireEvent.click(screen.getByRole("button", { name: "Return to Search" }));
		await waitFor(() => {
			expect(document.querySelector("[data-test-search-condition]")).toBeNull();
			expect(scroller.scrollTop).toBe(800);
		});
		await act(
			() =>
				new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);
	});
});
