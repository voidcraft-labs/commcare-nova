// Preview's half of the `csql` family: every scenario of
// `lib/commcare/__tests__/csqlCompositionFixture.ts`, its cases seeded as rows,
// each search's composed query read by the production store as HQ's search
// population, and the rows held to the ids the fixture says the search means,
// the ids HQ's own search returns over the same cases
// (docs/plans/hq-round-trip/3-expressions/06-csql.md §8).
//
// A sending whose query reads a runtime value states the query Core's
// evaluation leaves (`folded`); this file compiles that, so it does not
// depend on the fold, whose own test holds `foldCsqlRuntime` to the same
// statement. A module whose case list filter reads the case chosen in an
// earlier menu is also read as its browse list, the filter unfolded and the
// chosen case bound, and must list the same cases.
import { describe } from "vitest";
import {
	type CsqlCase,
	type CsqlScenario,
	csqlPostgresScenarios,
} from "@/lib/commcare/__tests__/csqlCompositionFixture";
import { moduleExpressionContexts } from "@/lib/commcare/expressionContext";
import { composeXPathQueryPredicate } from "@/lib/commcare/suite/case-search/xpathQuery";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, CaseType } from "@/lib/domain";
import { readChosenCaseProperty } from "@/lib/domain/expression/chosenCase";
import {
	CASEDB_READING,
	SEARCH_READING,
} from "@/lib/domain/expression/temporalType";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { PostgresCaseStore } from "../../postgres/store";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { buildCaseTypeMap } from "../../store";
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

for (const scenario of csqlPostgresScenarios) {
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
