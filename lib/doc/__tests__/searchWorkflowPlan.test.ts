import { readFileSync } from "node:fs";
import { join } from "node:path";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	type FieldWriteFact,
	operationsFromFieldWrites,
} from "@/lib/doc/fieldWriteOperations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type SearchInputDef,
	type Uuid,
	visibleSearchInputs,
} from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/expression/simplify";
import type { Expression } from "@/lib/domain/expression/types";
import {
	type AuthoredSearchWorkflow,
	authoredSearchWorkflow,
	type StoredSearchFacts,
} from "../searchWorkflowPlan";

describe("authoredSearchWorkflow", () => {
	// Each row is one class of stored menu. A row whose answer drifts moves
	// bytes the class should keep (or keeps bytes it should move): the three
	// wire flags are `auto_launch` = workflow is not list first,
	// `default_search` = skip to results, `inline_search` = forms read the
	// search.
	const rows: ReadonlyArray<{
		readonly name: string;
		readonly facts: StoredSearchFacts;
		readonly expected: AuthoredSearchWorkflow;
		readonly catches: string;
	}> = [
		{
			name: "search first with a visible input keeps inline search, search first",
			facts: {
				searchFirst: true,
				hasVisibleInput: true,
				hasEffectiveFilter: false,
				declaresWebApps: true,
			},
			expected: { formsReadSearch: true },
			catches:
				"a stored searchFirst losing formsReadSearch would drop inline_search; gaining skipToResults would turn default_search on",
		},
		{
			name: "search first with a visible input ignores the filter and the platforms",
			facts: {
				searchFirst: true,
				hasVisibleInput: true,
				hasEffectiveFilter: true,
				declaresWebApps: false,
			},
			expected: { formsReadSearch: true },
			catches:
				"a filter or an Android-only declaration must not reroute a stored inline search",
		},
		{
			name: "search first with no visible input keeps default_search as skip to results",
			facts: {
				searchFirst: true,
				hasVisibleInput: false,
				hasEffectiveFilter: false,
				declaresWebApps: true,
			},
			expected: { workflow: "skipToResults", formsReadSearch: true },
			catches:
				"a searchFirst with no visible input losing skipToResults would turn default_search off",
		},
		{
			name: "search first with no visible input, a filter and Android only is still skip to results",
			facts: {
				searchFirst: true,
				hasVisibleInput: false,
				hasEffectiveFilter: true,
				declaresWebApps: false,
			},
			expected: { workflow: "skipToResults", formsReadSearch: true },
			catches:
				"the stored inline class must be decided before the derived skip and the platform rows",
		},
		{
			name: "a filter with no visible input keeps the derived skip to results",
			facts: {
				searchFirst: false,
				hasVisibleInput: false,
				hasEffectiveFilter: true,
				declaresWebApps: true,
			},
			expected: { workflow: "skipToResults" },
			catches:
				"the derived skip becoming listFirst or search first would change auto_launch or default_search, and gaining formsReadSearch would add inline_search",
		},
		{
			name: "the derived skip to results holds on Android only too",
			facts: {
				searchFirst: false,
				hasVisibleInput: false,
				hasEffectiveFilter: true,
				declaresWebApps: false,
			},
			expected: { workflow: "skipToResults" },
			catches:
				"an Android-only derived skip turning listFirst would turn auto_launch and default_search off",
		},
		{
			name: "list first with a visible input on Android only stays list first",
			facts: {
				searchFirst: false,
				hasVisibleInput: true,
				hasEffectiveFilter: true,
				declaresWebApps: false,
			},
			expected: { workflow: "listFirst" },
			catches:
				"an Android-only list-first menu losing listFirst would turn auto_launch on and raise a notice nobody needs",
		},
		{
			name: "list first with nothing to fill in on Android only stays list first",
			facts: {
				searchFirst: false,
				hasVisibleInput: false,
				hasEffectiveFilter: false,
				declaresWebApps: false,
			},
			expected: { workflow: "listFirst" },
			catches:
				"an Android-only list-first menu with no inputs and no filter moving to skip to results would change both flags",
		},
		{
			name: "list first with a visible input in Web Apps moves to search first with its notice",
			facts: {
				searchFirst: false,
				hasVisibleInput: true,
				hasEffectiveFilter: false,
				declaresWebApps: true,
			},
			expected: { webAppsOpensOn: "search" },
			catches:
				"storing listFirst in an app that declares Web Apps is refused by the platform table; skipToResults would turn default_search on; a missing notice line hides the move from its author",
		},
		{
			name: "list first with a visible input and a filter in Web Apps moves to search first",
			facts: {
				searchFirst: false,
				hasVisibleInput: true,
				hasEffectiveFilter: true,
				declaresWebApps: true,
			},
			expected: { webAppsOpensOn: "search" },
			catches:
				"a filter beside a visible input is not the derived skip; it must not turn default_search on",
		},
		{
			name: "list first with nothing to fill in and no filter in Web Apps moves to skip to results",
			facts: {
				searchFirst: false,
				hasVisibleInput: false,
				hasEffectiveFilter: false,
				declaresWebApps: true,
			},
			expected: { workflow: "skipToResults", webAppsOpensOn: "results" },
			catches:
				"search first here would open a Search screen holding only its Search button; the notice must say it opens on results",
		},
	];

	for (const row of rows) {
		it(row.name, () => {
			expect(authoredSearchWorkflow(row.facts), row.catches).toStrictEqual(
				row.expected,
			);
		});
	}

	it("never pairs list first with forms reading the search, and gives a notice only off list first in Web Apps", () => {
		// Every combination of the four facts: the stored pair the schema
		// refuses never comes out, and a notice line means the menu moved in an
		// app that declares Web Apps from a class that was list first there.
		for (const searchFirst of [false, true]) {
			for (const hasVisibleInput of [false, true]) {
				for (const hasEffectiveFilter of [false, true]) {
					for (const declaresWebApps of [false, true]) {
						const plan = authoredSearchWorkflow({
							searchFirst,
							hasVisibleInput,
							hasEffectiveFilter,
							declaresWebApps,
						});
						expect(
							plan.workflow === "listFirst" && plan.formsReadSearch === true,
						).toBe(false);
						if (plan.workflow === "listFirst") {
							expect(declaresWebApps).toBe(false);
						}
						const wasListFirst =
							!searchFirst && !(hasEffectiveFilter && !hasVisibleInput);
						expect(plan.webAppsOpensOn !== undefined).toBe(
							wasListFirst && declaresWebApps,
						);
					}
				}
			}
		}
	});

	it("maps facts only: an owner-only or absent search is the caller's to leave out", () => {
		// The planner has no notion of whether a menu searches. The facts of a
		// menu with no search inputs, no filter and no stored flag map to the
		// list-first rows; a caller that passed an owner-only config here would
		// author a workflow it never had, so each reader passes only a menu
		// with an effective ordinary search.
		expect(
			authoredSearchWorkflow({
				searchFirst: false,
				hasVisibleInput: false,
				hasEffectiveFilter: false,
				declaresWebApps: false,
			}),
		).toStrictEqual({ workflow: "listFirst" });
	});
});

// ── Wire identity over the pre-step fixtures ───────────────────────────
//
// The mapping's identity is a wire property, so it is checked at the
// emitter: each module of a pre-step fixture `main` recorded a search shape
// for (`facts.json`'s `searchShapes`, `main`'s `searchWireShape` arm) maps
// through `authoredSearchWorkflow` into the head shape, and the head's HQ
// JSON spells the `search_config` flags that arm spelled, except a list-first
// menu in an app that declares Web Apps, whose emission is its row's.
//
// The fixtures are `main`'s stored shape. The cutover's raw reader is pull
// request 14's, so this test lifts the few stored shapes step 5 retires from
// the raw JSON itself: a field's `caseWrite` becomes its form's operations
// (`operationsFromFieldWrites`, the planner the cutover shares), a stored
// `searchFirst` the authored workflow, `caseListOnly` the case list menu
// item, and a form's `entry` its module's case list registration form.

const PRE_STEP = join(
	process.cwd(),
	"scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures/pre-step",
);
const RETAINED_A = join(
	process.cwd(),
	"proof/migrations/targeted-migration-search-workflow/export/minimum/content.body",
);

type MainShape = "search-first" | "skip-to-results" | "list-first";

interface WireFlags {
	readonly auto_launch: boolean;
	readonly default_search: boolean;
	readonly inline_search: boolean;
}

interface RawModule {
	readonly uuid: Uuid;
	readonly name: string;
	readonly caseType?: string;
	readonly caseListOnly?: boolean;
	readonly caseSearchConfig?: Record<string, unknown>;
	readonly caseListConfig?: {
		readonly searchInputs?: readonly SearchInputDef[];
		readonly filter?: Expression;
		readonly icon?: unknown;
		readonly audioLabel?: unknown;
	};
}

interface RawDoc {
	readonly appSettings: { readonly runsOnlyOn?: string };
	readonly modules: Readonly<Record<string, RawModule>>;
	readonly forms: Readonly<Record<string, { readonly entry?: unknown }>>;
	readonly fields: Readonly<
		Record<
			string,
			{
				readonly kind: string;
				readonly caseWrite?: {
					readonly caseType: string;
					readonly property: string;
				};
			}
		>
	>;
	readonly formOrder: Readonly<Record<string, readonly string[]>>;
	readonly fieldOrder: Readonly<Record<string, readonly string[]>>;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

const FACTS = readJson<{
	readonly fixtures: Readonly<
		Record<string, { readonly searchShapes: Readonly<Record<Uuid, MainShape>> }>
	>;
}>(join(PRE_STEP, "facts.json"));

/** The facts of one stored module's search, read from the raw JSON. */
function storedFacts(raw: RawDoc, module: RawModule): StoredSearchFacts {
	return {
		searchFirst: module.caseSearchConfig?.searchFirst === true,
		hasVisibleInput:
			visibleSearchInputs(module.caseListConfig?.searchInputs ?? []).length > 0,
		hasEffectiveFilter:
			effectiveFilterForEmission(module.caseListConfig?.filter) !== undefined,
		declaresWebApps: raw.appSettings.runsOnlyOn !== "android",
	};
}

/** The three flags `main`'s `searchWireShape` arm spelled. Its search-first
 *  arm was CommCare's inline search, whose `default_search` was on exactly
 *  where no input was visible. */
function mainFlags(shape: MainShape, facts: StoredSearchFacts): WireFlags {
	switch (shape) {
		case "search-first":
			return {
				auto_launch: true,
				default_search: !facts.hasVisibleInput,
				inline_search: true,
			};
		case "skip-to-results":
			return { auto_launch: true, default_search: true, inline_search: false };
		case "list-first":
			return {
				auto_launch: false,
				default_search: false,
				inline_search: false,
			};
	}
}

/** The flags a Web Apps list-first row's planned workflow spells instead. */
function rowFlags(plan: AuthoredSearchWorkflow): WireFlags {
	return {
		auto_launch: plan.workflow !== "listFirst",
		default_search: plan.workflow === "skipToResults",
		inline_search: plan.formsReadSearch === true,
	};
}

/** The head document a raw pre-step fixture stores, with the retired shapes
 *  lifted as the header above says. */
function liftedDoc(raw: RawDoc): BlueprintDoc {
	const lifted = structuredClone(raw) as unknown as {
		modules: Record<string, Record<string, unknown>>;
		forms: Record<string, Record<string, unknown>>;
		fields: Record<string, Record<string, unknown>>;
	};
	const writes = new Map<Uuid, FieldWriteFact[]>();
	for (const [formUuid, fieldUuids] of Object.entries(raw.fieldOrder)) {
		for (const fieldUuid of fieldUuids) {
			const write = raw.fields[fieldUuid]?.caseWrite;
			if (write === undefined) continue;
			const facts = writes.get(formUuid as Uuid) ?? [];
			facts.push({
				fieldUuid: fieldUuid as Uuid,
				caseType: write.caseType,
				property: write.property,
				capture: false,
			});
			writes.set(formUuid as Uuid, facts);
			delete lifted.fields[fieldUuid].caseWrite;
		}
	}
	for (const [moduleUuid, module] of Object.entries(raw.modules)) {
		const target = lifted.modules[moduleUuid];
		const config = target.caseSearchConfig as
			| Record<string, unknown>
			| undefined;
		if (config !== undefined) delete config.searchFirst;
		if (module.caseListOnly === true) {
			const listConfig = target.caseListConfig as
				| Record<string, unknown>
				| undefined;
			target.caseListMenuItem = {
				...(module.caseListConfig?.icon !== undefined && {
					icon: module.caseListConfig.icon,
				}),
				...(module.caseListConfig?.audioLabel !== undefined && {
					audioLabel: module.caseListConfig.audioLabel,
				}),
			};
			if (listConfig !== undefined) {
				delete listConfig.icon;
				delete listConfig.audioLabel;
			}
		}
		delete target.caseListOnly;
		for (const formUuid of raw.formOrder[moduleUuid] ?? []) {
			if (raw.forms[formUuid]?.entry === undefined) continue;
			target.caseListRegistrationForm = {
				kind: "after-empty-search",
				formUuid,
			};
			delete lifted.forms[formUuid].entry;
		}
		const effective =
			config !== undefined ||
			(module.caseListConfig?.searchInputs?.length ?? 0) > 0;
		if (!effective || config?.searchActionEnabled === false) continue;
		const plan = authoredSearchWorkflow(storedFacts(raw, module));
		target.caseSearchConfig = {
			...(config ?? {}),
			...(plan.workflow !== undefined && { workflow: plan.workflow }),
			...(plan.formsReadSearch !== undefined && {
				formsReadSearch: plan.formsReadSearch,
			}),
		};
	}
	const parsed = hydratePersistedBlueprint(blueprintDocSchema.parse(lifted));
	// Every case form holds its own case's operation, a form that writes
	// nothing too.
	return produce(parsed, (draft) => {
		for (const formUuid of Object.keys(raw.forms) as Uuid[])
			applyMutations(draft, [
				...operationsFromFieldWrites(
					draft as BlueprintDoc,
					formUuid,
					writes.get(formUuid) ?? [],
				),
			]);
	});
}

/** The `search_config` flags of each named module of an HQ application. */
function flagsByModuleName(app: {
	readonly modules: readonly {
		readonly name: Readonly<Record<string, string>>;
		readonly search_config: WireFlags;
	}[];
}): Map<string, WireFlags> {
	return new Map(
		app.modules.map((module) => [
			Object.values(module.name)[0] ?? "",
			{
				auto_launch: module.search_config.auto_launch,
				default_search: module.search_config.default_search,
				inline_search: module.search_config.inline_search,
			},
		]),
	);
}

/** The application JSON a retained A capture's `app_file` part carries. */
function retainedApplication(
	body: string,
): Parameters<typeof flagsByModuleName>[0] {
	const part = body
		.split(/\r?\n------nova-proof-capture/)
		.find((chunk) => chunk.includes('name="app_file"'));
	if (part === undefined) throw new Error("The capture holds no app_file.");
	const start = part.indexOf("{");
	return JSON.parse(part.slice(start)) as Parameters<
		typeof flagsByModuleName
	>[0];
}

describe("authoredSearchWorkflow keeps each stored module's wire", () => {
	for (const fixture of [
		"targeted-migration-search-workflow",
		"pre-step-search-results",
	] as const) {
		it(`over ${fixture}`, () => {
			const raw = readJson<RawDoc>(join(PRE_STEP, `${fixture}.json`));
			const shapes = FACTS.fixtures[fixture]?.searchShapes ?? {};
			expect(Object.keys(shapes).length).toBeGreaterThan(0);
			const doc = liftedDoc(raw);
			const verdict = mutationCommitVerdict(
				doc,
				[],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok ? [] : verdict.findings).toEqual([]);
			const emitted = flagsByModuleName(
				expandDoc(doc) as unknown as Parameters<typeof flagsByModuleName>[0],
			);
			for (const [moduleUuid, shape] of Object.entries(shapes)) {
				const module = raw.modules[moduleUuid];
				if (module === undefined) throw new Error(`No module ${moduleUuid}.`);
				const facts = storedFacts(raw, module);
				const plan = authoredSearchWorkflow(facts);
				const expected =
					plan.webAppsOpensOn === undefined
						? mainFlags(shape, facts)
						: rowFlags(plan);
				expect(emitted.get(module.name), module.name).toEqual(expected);
			}
		});
	}

	it("spells the retained A capture's flags wherever the menu keeps its wire", () => {
		const raw = readJson<RawDoc>(
			join(PRE_STEP, "targeted-migration-search-workflow.json"),
		);
		const retained = flagsByModuleName(
			retainedApplication(readFileSync(RETAINED_A, "utf8")),
		);
		const emitted = flagsByModuleName(
			expandDoc(liftedDoc(raw)) as unknown as Parameters<
				typeof flagsByModuleName
			>[0],
		);
		const shapes =
			FACTS.fixtures["targeted-migration-search-workflow"]?.searchShapes ?? {};
		for (const moduleUuid of Object.keys(shapes)) {
			const module = raw.modules[moduleUuid];
			if (module === undefined) throw new Error(`No module ${moduleUuid}.`);
			const plan = authoredSearchWorkflow(storedFacts(raw, module));
			const before = retained.get(module.name);
			expect(before, module.name).toBeDefined();
			if (plan.webAppsOpensOn === undefined)
				expect(emitted.get(module.name), module.name).toEqual(before);
			else expect(emitted.get(module.name), module.name).not.toEqual(before);
		}
	});
});
