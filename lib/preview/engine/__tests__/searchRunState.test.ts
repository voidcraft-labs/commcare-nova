import { afterEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	promptLookupContext,
	promptLookupRows,
	searchPromptWorkerPlaceFixture,
	WORKER_PLACE_SEARCH_MENUS,
} from "@/lib/commcare/__tests__/searchPromptFixture";
import type { SearchInputDef } from "@/lib/domain";
import { hiddenSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import {
	dateLiteral,
	eq,
	literal,
	now,
	sessionContext,
	sessionUser,
	term,
} from "@/lib/domain/expression";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import { previewDataRefusalOf, readPreviewScreen } from "../dataRefusal";
import {
	type PreviewSearchSessionValues,
	previewAsMe,
	previewSessionValues,
} from "../identity";
import { previewLookupData } from "../lookupEvaluation";
import {
	buildSearchRunState,
	changeSearchRunDraft,
	clearSearchRun,
	openSearchRunState,
	reconcileSearchRunState,
	restoreSearchRun,
	searchScreenOpeningCovered,
	searchStartingChoicesFail,
	searchStartingValuesOffered,
	withHiddenValues,
} from "../searchRunState";

const INPUT = testUuid("00000000-0000-4000-8000-000000000201");
const HIDDEN = testUuid("00000000-0000-4000-8000-000000000202");
const SESSION = previewSessionValues(
	previewAsMe({
		id: "worker-1",
		name: "Worker One",
		email: "worker@example.org",
	}),
	webAppsDevice(),
);
const input = (value: string) =>
	simpleSearchInputDef(INPUT, "name", "Name", "text", "case_name", {
		default: term(literal(value)),
	});
const searchedBy = hiddenSearchInputDef(
	HIDDEN,
	"searched_by",
	"Searched by",
	term(sessionContext("username")),
);
const initial = (value = "Alice", scope = "module-a") =>
	buildSearchRunState(
		scope,
		[input(value), searchedBy],
		SESSION,
		runEnvironment([input(value), searchedBy]),
	);
const answers = (name: string) => new Map([["name", name]]);
afterEach(() => vi.useRealTimers());

describe("search run commands", () => {
	it("acknowledges an admitted draft by identity while filtering foreign keys", () => {
		const first = initial();
		const submitted = answers("Manual code");
		const accepted = changeSearchRunDraft(first, first, submitted, false);
		expect(accepted.draft).toBe(submitted);
		const scanned = answers("BC-0042");
		const next = changeSearchRunDraft(accepted, first, scanned, false);
		expect(next.draft).toBe(scanned);
		expect(submitted).toEqual(answers("Manual code"));
		const foreign = new Map([...scanned, ["unknown", "untrusted"]]);
		const filtered = changeSearchRunDraft(next, first, foreign, false);
		expect(filtered.draft).toEqual(scanned);
		expect(filtered.draft).not.toBe(foreign);
		expect(foreign.get("unknown")).toBe("untrusted");
	});
	it("refreshes untouched defaults, preserves edits and treats clear as intentional until scope changes", () => {
		const first = initial();
		expect(first.draft).toEqual(answers("Alice"));
		expect(first.submitted.size).toBe(0);
		const refreshed = reconcileSearchRunState(first, initial("Alicia"));
		expect(refreshed.draft).toEqual(answers("Alicia"));
		const edited = changeSearchRunDraft(
			refreshed,
			refreshed,
			answers("Amara"),
			false,
		);
		const latest = reconcileSearchRunState(edited, initial("Ada"));
		expect(latest.draft).toEqual(answers("Amara"));
		const cleared = clearSearchRun(latest, latest);
		expect(reconcileSearchRunState(cleared, initial("Anne")).draft.size).toBe(
			0,
		);
		const switched = reconcileSearchRunState(
			cleared,
			initial("Bob", "module-b"),
		);
		expect(switched.draft).toEqual(answers("Bob"));
		expect(switched.hasSubmitted).toBe(false);
	});
	it("records explicit blank submission and clears both worker and hidden answers", () => {
		const desired = initial();
		const submitted = changeSearchRunDraft(desired, desired, new Map(), true);
		expect(submitted.hasSubmitted).toBe(true);
		expect(submitted.submitted.size).toBe(0);
		expect(
			withHiddenValues(submitted.submitted, submitted.submittedHidden),
		).toEqual(new Map([["searched_by", "worker@example.org"]]));
		const cleared = clearSearchRun(submitted, desired);
		expect(cleared.hasSubmitted).toBe(false);
		expect(
			withHiddenValues(cleared.submitted, cleared.submittedHidden).size,
		).toBe(0);
	});
	it("rejects forged hidden answers and restores the values carried by an existing search", () => {
		const desired = initial();
		const forged = new Map([
			["name", "Amara"],
			["searched_by", "forged"],
		]);
		const submitted = changeSearchRunDraft(desired, desired, forged, true);
		expect(submitted.draft).toEqual(answers("Amara"));
		expect(submitted.submittedHidden.get("searched_by")).toBe(
			"worker@example.org",
		);
		const restored = restoreSearchRun(desired, desired, forged);
		expect(restored.draft).toEqual(answers("Amara"));
		expect(restored.submittedHidden.get("searched_by")).toBe("forged");
		expect(restored.hasSubmitted).toBe(true);
	});
	it("drops incompatible answers and ends the submitted phase when the last prompt disappears", () => {
		const desired = initial();
		const submitted = changeSearchRunDraft(
			desired,
			desired,
			answers("Amara"),
			true,
		);
		const changed = buildSearchRunState(
			"module-a",
			[
				simpleSearchInputDef(INPUT, "name", "Date", "date", "date_opened", {
					default: term(dateLiteral("2026-07-16")),
				}),
			],
			SESSION,
			runEnvironment([
				simpleSearchInputDef(INPUT, "name", "Date", "date", "date_opened", {
					default: term(dateLiteral("2026-07-16")),
				}),
			]),
		);
		const reconciled = reconcileSearchRunState(submitted, changed);
		expect(reconciled.draft).toEqual(answers("2026-07-16"));
		expect(reconciled.submitted.size).toBe(0);
		const removed = reconcileSearchRunState(
			submitted,
			buildSearchRunState("module-a", [], SESSION, runEnvironment([])),
		);
		expect(removed.hasSubmitted).toBe(false);
		expect(removed.draft.size).toBe(0);
		expect(removed.submittedHidden.size).toBe(0);
	});
	it("replaces renamed hidden keys in a standing search and removes deleted keys", () => {
		const desired = initial();
		const submitted = changeSearchRunDraft(
			desired,
			desired,
			answers("Amara"),
			true,
		);
		const renamed = buildSearchRunState(
			"module-a",
			[
				input("Alice"),
				hiddenSearchInputDef(
					HIDDEN,
					"run_by",
					"Run by",
					term(sessionContext("username")),
				),
			],
			SESSION,
			runEnvironment([
				input("Alice"),
				hiddenSearchInputDef(
					HIDDEN,
					"run_by",
					"Run by",
					term(sessionContext("username")),
				),
			]),
		);
		const reconciled = reconcileSearchRunState(submitted, renamed);
		expect(
			withHiddenValues(reconciled.submitted, reconciled.submittedHidden),
		).toEqual(
			new Map([
				["name", "Amara"],
				["run_by", "worker@example.org"],
			]),
		);
		expect(
			reconcileSearchRunState(
				reconciled,
				buildSearchRunState(
					"module-a",
					[input("Alice")],
					SESSION,
					runEnvironment([input("Alice")]),
				),
			).submittedHidden.size,
		).toBe(0);
	});
	it("resolves hidden time on each submission while editing leaves the standing search unchanged", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
		const desired = buildSearchRunState(
			"module-a",
			[input("Alice"), hiddenSearchInputDef(HIDDEN, "time", "Time", now())],
			SESSION,
			runEnvironment([
				input("Alice"),
				hiddenSearchInputDef(HIDDEN, "time", "Time", now()),
			]),
		);
		const first = changeSearchRunDraft(
			desired,
			desired,
			answers("Alice"),
			true,
		);
		expect(first.submittedHidden.get("time")).toBe("2026-09-06");
		vi.setSystemTime(new Date("2026-09-07T13:45:00Z"));
		const edited = changeSearchRunDraft(first, desired, answers("Ada"), false);
		expect(edited.submittedHidden).toBe(first.submittedHidden);
		expect(
			changeSearchRunDraft(
				edited,
				desired,
				answers("Ada"),
				true,
			).submittedHidden.get("time"),
		).toBe("2026-09-07");
	});
});

/* Core's query manager reads each prompt's starting value, each hidden
 * value, each required condition and the check of each prompt a starting
 * value answers as the Search screen opens, on Web Apps and Android alike
 * (`RemoteQuerySessionManager.java`'s constructor), so a read of a place key
 * a worker assigned nowhere lacks stops the screen there, while a check no
 * starting value answers is not read until the worker answers. */
describe("the Search screen as it opens", () => {
	const PLACED: PreviewSearchSessionValues = {
		...SESSION,
		user: {
			...SESSION.user,
			commcare_location_id: "place-north",
			commcare_location_ids: "place-north",
			commcare_primary_case_sharing_id: "place-north",
		},
	};
	const placedNorth = eq(
		sessionUser("commcare_location_id"),
		literal("place-north"),
	);
	const opened = (
		inputs: readonly SearchInputDef[],
		session: PreviewSearchSessionValues,
	) => {
		const read = readPreviewScreen(() =>
			openSearchRunState("module-a", inputs, session, runEnvironment(inputs)),
		);
		return read.kind === "refused"
			? previewDataRefusalOf(read.refusal)?.reason
			: "opened";
	};
	const refusal = { kind: "empty-instance", instanceId: "commcaresession" };
	const screens: Record<string, readonly SearchInputDef[]> = {
		"a starting value": [
			simpleSearchInputDef(INPUT, "name", "Name", "text", "case_name", {
				default: term(sessionUser("commcare_location_id")),
			}),
		],
		"a hidden value": [
			hiddenSearchInputDef(
				HIDDEN,
				"place",
				"Place",
				term(sessionUser("commcare_location_id")),
			),
		],
		"a required condition": [
			simpleSearchInputDef(INPUT, "name", "Name", "text", "case_name", {
				required: { when: placedNorth, message: "Add a name" },
			}),
		],
		"the check of a prompt its starting value answers": [
			simpleSearchInputDef(INPUT, "name", "Name", "text", "case_name", {
				default: term(literal("Ada")),
				validation: { rule: placedNorth, message: "Search from your place" },
			}),
		],
	};
	for (const [slot, inputs] of Object.entries(screens)) {
		it(`stops on ${slot} for a worker assigned nowhere, and opens for one placed`, () => {
			expect(opened(inputs, SESSION)).toEqual(refusal);
			expect(opened(inputs, PLACED)).toBe("opened");
		});
	}

	it("leaves a check no starting value answers unread", () => {
		const inputs = [
			simpleSearchInputDef(INPUT, "name", "Name", "text", "case_name", {
				validation: { rule: placedNorth, message: "Search from your place" },
			}),
		];
		expect(opened(inputs, SESSION)).toBe("opened");
	});

	/* Between the starting values and the required reads, Core's manager
	 * populates every choice prompt's itemset (`refreshItemSetChoices` →
	 * `ItemSetUtils.populateDynamicChoices`), which throws for a table with
	 * no rows and for a row filter over a key the worker lacks. Formplayer's
	 * `QueryScreen.init` builds the manager before an automatic search, so a
	 * menu that opens on its results refuses there too, and App Tests and the
	 * form check, which open the screen through this one function, refuse at
	 * the same step. `SearchPromptRuntimeTest` holds Core to the `choices`
	 * menu of this fixture. */
	describe("a choice list", () => {
		const doc = searchPromptWorkerPlaceFixture();
		const moduleUuid =
			doc.moduleOrder[WORKER_PLACE_SEARCH_MENUS.indexOf("choices")];
		const inputs = doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [];
		if (promptLookupContext.kind !== "available")
			throw new Error("The prompt fixture holds its lookup tables.");
		const definitions = promptLookupContext.definitions;
		const lookup = (rows: typeof promptLookupRows) =>
			previewLookupData({
				projectRevision: "1",
				definitions,
				rowsByTable: rows,
			});
		const openChoices = (
			session: PreviewSearchSessionValues,
			environmentLookup?: ReturnType<typeof lookup>,
		) => {
			const read = readPreviewScreen(() =>
				openSearchRunState(moduleUuid, inputs, session, {
					doc,
					moduleUuid,
					...(environmentLookup !== undefined && { lookup: environmentLookup }),
				}),
			);
			return read.kind === "refused"
				? (previewDataRefusalOf(read.refusal)?.reason ?? "refused")
				: "opened";
		};

		it("stops on a row filter over a place key a worker assigned nowhere lacks, and opens for one placed", () => {
			expect(openChoices(SESSION, lookup(promptLookupRows))).toEqual(refusal);
			expect(openChoices(PLACED, lookup(promptLookupRows))).toBe("opened");
		});

		it("stops on a table with no rows, whoever the worker is", () => {
			const empty = new Map(
				[...promptLookupRows].map(([tableId]) => [tableId, []]),
			);
			expect(openChoices(PLACED, lookup(empty))).toEqual({
				kind: "empty-choice-table",
				tableId: definitions[0]?.id,
			});
		});

		it("is not opened until the lookup data covers the list, and reads nothing before", () => {
			expect(searchScreenOpeningCovered(inputs, {})).toBe(false);
			expect(
				searchScreenOpeningCovered(inputs, {
					lookup: lookup(promptLookupRows),
				}),
			).toBe(true);
			// A screen that reads no table opens with no lookup data at all.
			expect(searchScreenOpeningCovered([input("Ada"), searchedBy], {})).toBe(
				true,
			);
			// A reader that cannot wait (the lookup load failed) reads what it
			// can, and refuses nothing it could not read.
			expect(openChoices(SESSION)).toBe("opened");
		});
	});

	/* Core's choice pass lets go of each chosen value of a starting value
	 * the list does not offer (`refreshItemSetChoices`,
	 * `checkForValidSelectValue`) before it judges a required condition or a
	 * check (`validateUserAnswers`). `SearchPromptRuntimeTest` holds Core to
	 * the `unoffered-choice` menu: built for a worker assigned nowhere, with
	 * no starting answer. */
	describe("a starting choice the list does not offer", () => {
		const doc = searchPromptWorkerPlaceFixture();
		const moduleUuid =
			doc.moduleOrder[WORKER_PLACE_SEARCH_MENUS.indexOf("unoffered-choice")];
		const inputs = doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [];
		if (promptLookupContext.kind !== "available")
			throw new Error("The prompt fixture holds its lookup tables.");
		const environment = {
			doc,
			moduleUuid,
			lookup: previewLookupData({
				projectRevision: "1",
				definitions: promptLookupContext.definitions,
				rowsByTable: promptLookupRows,
			}),
		};

		it("is let go before its check is read, so the screen opens with no answer", () => {
			for (const session of [SESSION, PLACED]) {
				const read = readPreviewScreen(() =>
					openSearchRunState(moduleUuid, inputs, session, environment),
				);
				expect(read.kind).toBe("read");
				if (read.kind === "read") {
					expect(read.value.defaults.has("region")).toBe(false);
					expect(read.value.draft.has("region")).toBe(false);
				}
			}
		});

		/* Core gives the choice pass one round per prompt and fails the
		 * screen when a round is still letting values go
		 * (`RemoteQuerySessionManager.refreshItemSetChoices`, "Invalid
		 * itemset state"). `SearchPromptRuntimeTest` holds Core to the
		 * `unoffered-choice-alone` menu: refused for every worker. */
		it("fails a Search screen of one field instead, for every worker", () => {
			const alone =
				doc.moduleOrder[
					WORKER_PLACE_SEARCH_MENUS.indexOf("unoffered-choice-alone")
				];
			const aloneInputs =
				doc.modules[alone]?.caseListConfig?.searchInputs ?? [];
			for (const session of [SESSION, PLACED]) {
				const read = readPreviewScreen(() =>
					openSearchRunState(alone, aloneInputs, session, {
						...environment,
						moduleUuid: alone,
					}),
				);
				expect(read.kind).toBe("refused");
				if (read.kind === "refused")
					expect(read.refusal.reason).toEqual({
						kind: "unoffered-starting-choice",
						inputUuid: aloneInputs[0]?.uuid,
						input: "Region",
					});
			}
		});

		it("fails only where the one round Core gives a one-prompt screen lets a choice go", () => {
			const rows = [
				{ key: "1", value: "north", label: "North" },
				{ key: "2", value: "east", label: "East" },
			];
			const region = inputs.find((input) => input.name === "region");
			if (region === undefined) throw new Error("The menu has a Region.");
			const fails = (
				fields: readonly SearchInputDef[],
				value: string,
			): string | undefined =>
				searchStartingChoicesFail(
					fields,
					new Map([["region", value]]),
					new Map([["region", rows]]),
				)?.name;
			expect(fails([region], "west")).toBe("region");
			expect(fails([region], "north#,#west")).toBe("region");
			// Every value offered, a blank choice, and the trailing empty
			// choice Java's split drops are valid.
			expect(fails([region], "north#,#east")).toBeUndefined();
			expect(fails([region], "")).toBeUndefined();
			expect(fails([region], "north#,#")).toBeUndefined();
			// A second prompt, hidden or not, gives the pass its clean round.
			expect(fails(inputs, "west")).toBeUndefined();
		});

		it("keeps the chosen values the list offers, in their order", () => {
			const rows = [
				{ key: "1", value: "north", label: "North" },
				{ key: "2", value: "east", label: "East" },
			];
			const offered = (value: string) =>
				searchStartingValuesOffered(
					new Map([
						["region", value],
						["name", "Ada"],
					]),
					new Map([["region", rows]]),
				);
			expect([...offered("east#,#west#,#north")]).toEqual([
				["region", "east#,#north"],
				["name", "Ada"],
			]);
			expect(offered("west").has("region")).toBe(false);
			// An answer every value of which the list offers is kept as it is.
			const kept = new Map([["region", "north"]]);
			expect(
				searchStartingValuesOffered(kept, new Map([["region", rows]])),
			).toBe(kept);
		});
	});
});

function runEnvironment(searchInputs: readonly SearchInputDef[]) {
	const doc = buildDoc({
		caseTypes: [{ name: "person", properties: [] }],
		modules: [
			{
				name: "People",
				caseType: "person",
				caseListConfig: {
					...caseListConfig([]),
					searchInputs: [...searchInputs],
				},
			},
		],
	});
	return { doc, moduleUuid: doc.moduleOrder[0] };
}
