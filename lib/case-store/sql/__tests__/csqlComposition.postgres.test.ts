// Preview's half of the `csql` family: every scenario of
// `lib/commcare/__tests__/csqlCompositionFixture.ts`, its cases seeded as rows,
// each search's composed query read by the production store as HQ's search
// population, and the rows held to the ids the fixture says the search means,
// the ids HQ's own search returns over the same cases
// (docs/plans/hq-round-trip/3-expressions/06-csql.md §8).
//
// A sending whose query reads a runtime value states the query Core's
// evaluation leaves (`folded`); this file compiles that, and then Preview's
// own path: the sending's answers and session evaluated as the browser
// evaluates them (`searchCsqlRuntime.ts::evaluateSearchCsqlRuntime`, over the
// scenario's cases as the device's), the rows folded by
// `lib/commcare/csql/fold.ts::foldCsqlRuntime` and a simple input's answer
// bound as `composeRuntimeFilter` binds it, so the query Results reads is
// held to the ids HQ returns. A module whose case list filter reads the case
// chosen in an earlier menu is also read as its browse list, the filter
// unfolded and the chosen case bound, and must list the same cases.
import { describe, vi } from "vitest";
import {
	CSQL_DEVICE_ZONES,
	type CsqlCase,
	type CsqlScenario,
	type CsqlSending,
	csqlScenarios,
} from "@/lib/commcare/__tests__/csqlCompositionFixture";
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import { composeXPathQueryPredicate } from "@/lib/commcare/suite/case-search/xpathQuery";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, CaseType } from "@/lib/domain";
import { readChosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import { effectiveFilterForEmission } from "@/lib/domain/expression/simplify";
import {
	CASEDB_READING,
	SEARCH_READING,
} from "@/lib/domain/expression/temporalType";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { caseListStepSession } from "@/lib/preview/engine/entrySessionData";
import type { PreviewSearchSessionValues } from "@/lib/preview/engine/identity";
import { composeRuntimeFilter } from "@/lib/preview/engine/runtimeBindings";
import {
	evaluateSearchCsqlRuntime,
	foldSearchCsql,
	searchCsqlRejected,
} from "@/lib/preview/engine/searchCsqlRuntime";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";
import { PostgresCaseStore } from "../../postgres/store";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { buildCaseTypeMap, type CaseRow } from "../../store";
import { expect, makeCaseRow, test } from "./setup";

const APP = "app-csql-composition";
const PROJECT = "project-csql-composition";
const OWNER = "owner-csql-composition";

type Db = ConstructorParameters<typeof PostgresCaseStore>[0]["db"];

function makeStore(db: Db) {
	return new PostgresCaseStore({
		db,
		projectId: PROJECT,
		actorUserId: "actor",
		ownerId: OWNER,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

/**
 * The scenario's cases as the store holds them: HQ's receiver keeps a
 * multiple-choice answer as space-separated text, which Nova's rows hold as
 * the array of its choices; every other value as written. A closed case is
 * closed at its `modified` instant, as HQ's case block closes it.
 */
async function seed(
	db: Db,
	scenario: CsqlScenario,
	schemas: ReadonlyMap<string, CaseType>,
) {
	const stored = (row: CsqlCase) =>
		Object.fromEntries(
			Object.entries(row.properties).map(([name, value]) => [
				name,
				schemas
					.get(row.type)
					?.properties.find((property) => property.name === name)?.data_type ===
				"multi_select"
					? value.split(" ").filter(Boolean)
					: value,
			]),
		);
	await db
		.insertInto("cases")
		.values(
			scenario.cases.map((row) =>
				makeCaseRow({
					case_id: row.id,
					case_type: row.type,
					case_name: row.name,
					app_id: APP,
					project_id: PROJECT,
					owner_id: OWNER,
					status: row.closed ? "closed" : "open",
					opened_on: new Date(row.modified),
					modified_on: new Date(row.modified),
					closed_on: row.closed ? new Date(row.modified) : null,
					parent_case_id:
						row.indices?.find((index) => index.identifier === "parent")
							?.caseId ?? null,
					properties: JSON.stringify(stored(row)),
				}),
			),
		)
		.execute();
	const indices = scenario.cases.flatMap((row) =>
		(row.indices ?? []).map((index) => ({
			case_id: row.id,
			ancestor_id: index.caseId,
			target_case_type: index.caseType,
			identifier: index.identifier,
			relationship: index.relationship,
			depth: 1,
		})),
	);
	if (indices.length > 0)
		await db.insertInto("case_indices").values(indices).execute();
}

/** Whether a module's own list filter reads the case chosen in a menu. */
function readsChosenCase(filter: Expression | undefined): boolean {
	let found = false;
	if (filter === undefined) return false;
	walkExpression(filter, {
		visitExpression: (node) => {
			if (readChosenCaseProperty(node) !== undefined) found = true;
		},
		visitTerm: (term) => {
			if (term.kind === "session-datum") found = true;
		},
	});
	return found;
}

function composedQuery(doc: BlueprintDoc, moduleIndex: number) {
	const module = doc.modules[doc.moduleOrder[moduleIndex]];
	if (module.caseListConfig === undefined || module.caseType === undefined)
		throw new Error(`Module ${module.name} has no searchable case list.`);
	return {
		module,
		caseType: module.caseType,
		query: composeXPathQueryPredicate(
			module.caseListConfig,
			module.caseType,
			moduleExpressionContexts(doc, module.uuid)({ slot: "case_list_filter" }),
		),
	};
}

/** The scenario's cases as the searching worker's device holds them. */
function deviceCases(scenario: CsqlScenario): CaseDatabaseSnapshot {
	return {
		rows: scenario.cases.map(
			(row) =>
				({
					case_id: row.id,
					app_id: APP,
					case_type: row.type,
					case_name: row.name,
					owner_id: OWNER,
					status: row.closed ? "closed" : "open",
					external_id: null,
					opened_on: new Date(row.modified),
					modified_on: new Date(row.modified),
					closed_on: row.closed ? new Date(row.modified) : null,
					parent_case_id: null,
					properties: row.properties,
				}) as unknown as CaseRow,
		),
		indices: scenario.cases.flatMap((row) =>
			(row.indices ?? []).map((index) => ({
				case_id: row.id,
				ancestor_id: index.caseId,
				target_case_type: index.caseType,
				identifier: index.identifier,
				relationship: index.relationship,
				depth: 1,
			})),
		),
	};
}

/**
 * The query Preview's Results read compiles for a sending: the search's rows
 * folded with what the browser works out from the sending's answers and
 * session, and each simple input's answer as the literal it binds. Evaluated
 * at the sending's clock, in its device zone.
 */
async function previewSearchQuery(
	scenario: CsqlScenario,
	doc: BlueprintDoc,
	moduleIndex: number,
	sending: CsqlSending,
	schemas: ReadonlyMap<string, CaseType>,
): Promise<Expression | undefined> {
	const module = doc.modules[doc.moduleOrder[moduleIndex]];
	const config = module.caseListConfig;
	if (config === undefined || module.caseType === undefined)
		throw new Error(`Module ${module.name} has no searchable case list.`);
	const answers = new Map(
		Object.entries(sending.answers ?? {}).flatMap(([name, value]) =>
			value === null ? [] : [[name, value] as const],
		),
	);
	const session: PreviewSearchSessionValues = {
		context: sending.session?.context ?? {},
		user: sending.session?.user ?? {},
		userPropertySlugs: {},
	};
	const caseDatabase = deviceCases(scenario);
	const menuSelections = Object.fromEntries(
		Object.entries(sending.session?.chosenCaseIds ?? {}).map(
			([menu, caseId]) => [
				menu,
				{ caseType: doc.modules[menu]?.caseType ?? "", cases: [{ caseId }] },
			],
		),
	);
	const zone =
		sending.zone === undefined ? "UTC" : CSQL_DEVICE_ZONES[sending.zone];
	const previousZone = process.env.TZ;
	process.env.TZ = zone;
	if (sending.session?.clock !== undefined) {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(sending.session.clock));
	}
	try {
		const wire = await evaluateSearchCsqlRuntime({
			doc,
			moduleUuid: module.uuid,
			caseListConfig: config,
			answers,
			session,
			sessionData: caseListStepSession(doc, module.uuid, {
				menuSelections,
				caseDatabase,
				identity: session,
			}).data,
			caseDatabase,
		});
		if (wire !== undefined && searchCsqlRejected(wire))
			return { kind: "match-none" };
		const rows =
			wire === undefined
				? undefined
				: foldSearchCsql(doc, module.uuid, config, wire)?.query;
		const simple = config.searchInputs.filter(
			(input) => input.kind !== "advanced",
		);
		const answered =
			simple.length === 0
				? undefined
				: effectiveFilterForEmission(
						composeRuntimeFilter(simple, answers, module.caseType, schemas),
					);
		const clauses = [rows, answered].filter(
			(clause): clause is Expression => clause !== undefined,
		);
		const [first, second, ...rest] = clauses;
		if (first === undefined) return undefined;
		return second === undefined
			? first
			: { kind: "and", clauses: [first, second, ...rest] };
	} finally {
		if (sending.session?.clock !== undefined) vi.useRealTimers();
		if (previousZone === undefined) delete process.env.TZ;
		else process.env.TZ = previousZone;
	}
}

for (const scenario of csqlScenarios) {
	describe(scenario.id, () => {
		scenario.searches.forEach((search, moduleIndex) => {
			for (const sending of search.sendings) {
				test(`${search.id}: ${sending.id}`, async ({ db }) => {
					const doc = scenario.doc();
					const schemas = buildCaseTypeMap(toPersistableDoc(doc));
					await seed(db, scenario, schemas);
					const store = makeStore(db);
					const { module, caseType, query } = composedQuery(doc, moduleIndex);
					const predicate = sending.folded ?? query;
					const searched = await store.query({
						appId: APP,
						caseType,
						reading: SEARCH_READING,
						searchPopulation: { heldBy: { ownerIds: [OWNER] } },
						caseTypeSchemas: schemas,
						bindings: { viewerTimeZone: "UTC" },
						...(predicate === undefined ? {} : { predicate }),
					});
					expect(
						searched.map((row) => row.case_id).sort(),
						`${scenario.id} / ${search.id} / ${sending.id}`,
					).toEqual([...sending.expected].sort());

					// Preview's own path to the same search.
					const previewQuery = await previewSearchQuery(
						scenario,
						doc,
						moduleIndex,
						sending,
						schemas,
					);
					const previewed = await store.query({
						appId: APP,
						caseType,
						reading: SEARCH_READING,
						searchPopulation: { heldBy: { ownerIds: [OWNER] } },
						caseTypeSchemas: schemas,
						bindings: {
							viewerTimeZone:
								sending.zone === undefined
									? "UTC"
									: CSQL_DEVICE_ZONES[sending.zone],
						},
						...(previewQuery === undefined ? {} : { predicate: previewQuery }),
					});
					expect(
						previewed.map((row) => row.case_id).sort(),
						`${scenario.id} / ${search.id} / ${sending.id} (Preview)`,
					).toEqual([...sending.expected].sort());

					const filter = module.caseListConfig?.filter;
					if (!readsChosenCase(filter)) return;
					// The same filter as the device's list: unfolded, its chosen case
					// bound from the entry's session.
					const listed = await store.query({
						appId: APP,
						caseType,
						reading: CASEDB_READING,
						caseTypeSchemas: schemas,
						bindings: {
							viewerTimeZone: "UTC",
							chosenCaseIds: sending.session?.chosenCaseIds ?? {},
						},
						predicate: filter,
					});
					expect(
						listed.map((row) => row.case_id).sort(),
						`${scenario.id} / ${search.id} / ${sending.id} (list)`,
					).toEqual([...sending.expected].sort());
				});
			}
		});
	});
}
