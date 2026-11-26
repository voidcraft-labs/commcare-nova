// lib/case-store/postgres/__tests__/similarMatch.postgres.test.ts
//
// A similar-match (fuzzy) Search answer, through the store's search path
// (`searchPopulation.ts`, `certifiedFuzzyMatch.ts`), finds exactly the
// records CommCare HQ's own search finds over the same values, or refuses
// where only the project space's index can decide. The answers are HQ's,
// recorded by `proof/hq/test_similar_match.py` over HQ's own case processing
// and Elasticsearch into `proof/hq/fixtures/similar-match-vectors.json`.
//
// A second contract holds Preview's reach on production-shaped data: the
// Search fields of live apps hold names, phone numbers, ids and places, a
// few dozen records each. Every query a worker could type that shares a
// stored word's first two letters leaves no record undecided.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { CaseSearchUnavailableError } from "@/lib/case-store/searchRequest";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import type { CaseType } from "@/lib/domain";
import { match, not, prop } from "@/lib/domain/expression/builders";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedPreviewDoc } from "@/lib/preview/__tests__/fixtures/admittedDoc";

interface Vectors {
	readonly property: string;
	readonly caseType: string;
	readonly groups: readonly {
		readonly id: string;
		readonly records: readonly {
			readonly id: string;
			readonly value: string;
		}[];
		readonly searches: readonly {
			readonly query: string;
			readonly matches: readonly string[];
			readonly preview?:
				| "fuzzy-expansion-unavailable"
				| "fuzzy-text-unavailable";
		}[];
	}[];
}

const VECTORS = JSON.parse(
	readFileSync(
		join(process.cwd(), "proof/hq/fixtures/similar-match-vectors.json"),
		"utf8",
	),
) as Vectors;

const APP_ID = "app-similar-match";
const PROJECT = "project-similar-match";
const WORKER = "worker";

const PATIENT: CaseType = {
	name: VECTORS.caseType,
	properties: [
		{ name: VECTORS.property, label: proseText("Alias") },
		{ name: "phone", label: proseText("Phone") },
		{ name: "village", label: proseText("Village") },
	],
};

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "similar_match_",
});

function store(): CaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT,
		actorUserId: WORKER,
		ownerId: WORKER,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

beforeEach(async () => {
	await sql`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES (${APP_ID}, ${WORKER}, ${PROJECT}, 'Similar match', 'similar match')
	`.execute(dbHandle.db);
	const doc = assertAdmittedPreviewDoc(
		buildDoc({
			appId: APP_ID,
			caseTypes: [PATIENT],
			modules: [
				{
					name: PATIENT.name,
					caseType: PATIENT.name,
					caseListMenuItem: {},
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [],
				},
			],
		}),
	);
	await store().applySchemaChange({
		appId: APP_ID,
		caseType: PATIENT.name,
		caseTypeSchemas: buildCaseTypeMap(doc),
	});
});

async function insert(
	records: readonly {
		readonly id: string;
		readonly properties: Record<string, string>;
	}[],
) {
	const mine = store();
	for (const record of records)
		await mine.insert({
			appId: APP_ID,
			row: {
				case_id: record.id,
				case_type: PATIENT.name,
				case_name: record.id,
				status: "open",
				properties: record.properties,
			},
		});
}

/** The records a worker's similar-match search finds, or why Preview
 * cannot say. */
async function search(property: string, query: string, negated = false) {
	const similar = match(prop(PATIENT.name, property), query, "fuzzy");
	try {
		const rows = await store().query({
			appId: APP_ID,
			caseType: PATIENT.name,
			reading: SEARCH_READING,
			tileGrouping: "grouped",
			caseTypeSchemas: new Map([[PATIENT.name, PATIENT]]),
			predicate: negated ? not(similar) : similar,
			limit: 1000,
			searchPopulation: {
				heldBy: { ownerIds: [WORKER] },
				request: { maximum: 500 },
			},
		});
		return rows.map((row) => row.case_id).sort();
	} catch (error) {
		if (error instanceof CaseSearchUnavailableError) return error.reason;
		throw error;
	}
}

describe("a similar-match search finds what CommCare HQ finds", () => {
	it.each(VECTORS.groups.map((group) => [group.id, group] as const))(
		"%s",
		async (_, group) => {
			await insert(
				group.records.map((record) => ({
					id: record.id,
					properties: { [VECTORS.property]: record.value },
				})),
			);
			const everyone = group.records.map((record) => record.id);
			for (const { query, matches, preview } of group.searches) {
				const refused = preview && { kind: preview, field: VECTORS.property };
				const found = await search(VECTORS.property, query);
				expect({ query, found }).toEqual({
					query,
					found: refused || [...matches].sort(),
				});
				// The bounds carry through negation: the records it leaves out.
				const left = await search(VECTORS.property, query, true);
				expect({ query, left }).toEqual({
					query,
					left:
						refused || everyone.filter((id) => !matches.includes(id)).sort(),
				});
			}
		},
	);
});

describe("on production-shaped data", () => {
	// Thirty records of a live app's Search field: names with apostrophes,
	// hyphens and accents, phone numbers with a plus and dashes, and places.
	const GIVEN = ["Amina", "José", "Mary-Jane", "O'Neil", "Ngozi", "Chidi"];
	const FAMILY = ["Okafor", "N'Diaye", "García-López", "Müller", "Banda"];
	const VILLAGES = ["Kibera", "Mathare", "Kawangware", "Ruaraka", "Dandora"];
	const RECORDS = Array.from({ length: 30 }, (_, index) => ({
		id: `prod-${String(index).padStart(3, "0")}`,
		properties: {
			[VECTORS.property]: `${GIVEN[index % GIVEN.length]} ${FAMILY[index % FAMILY.length]}`,
			phone: `+254-7${String(10_000_000 + index * 7_919).slice(0, 8)}`,
			village: `${VILLAGES[index % VILLAGES.length]} (Ward ${(index % 4) + 1})`,
		},
	}));

	/** Every word of every stored value, and a near miss of each: a letter
	 * changed, dropped and added past the first two. */
	function queriesFor(values: readonly string[]) {
		const queries = new Set<string>();
		for (const value of values)
			for (const word of value.split(" ")) {
				const lower = word.toLowerCase();
				queries.add(word);
				if (lower.length < 3) continue;
				queries.add(`${lower.slice(0, 2)}x${lower.slice(3)}`);
				queries.add(`${lower.slice(0, 2)}${lower.slice(3)}`);
				queries.add(`${lower}e`);
			}
		return [...queries];
	}

	it("decides every record of every field for every word and near miss", async () => {
		await insert(RECORDS);
		const undecided: string[] = [];
		let searches = 0;
		for (const property of [VECTORS.property, "phone", "village"]) {
			const values = RECORDS.map((record) => record.properties[property] ?? "");
			for (const query of queriesFor(values)) {
				searches += 1;
				const found = await search(property, query);
				if (!Array.isArray(found)) undecided.push(`${property}: ${query}`);
			}
		}
		expect(searches).toBeGreaterThan(150);
		expect(undecided).toEqual([]);
	});
});
