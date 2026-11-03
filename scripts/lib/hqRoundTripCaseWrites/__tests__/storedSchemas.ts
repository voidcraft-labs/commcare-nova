/**
 * The case schemas `main`'s deploy stored for a pre-step app, for the
 * cutover's Postgres tests of the scan and the holders: what the fixture's
 * writes derive once made operations, but for the claim type's row, which no
 * stored app holds and the drift writer adds after the deploy (part 09
 * section 12). Without them every case type would be a difference the plan
 * refuses as `case-schema-unplanned`.
 */

import { type Kysely, sql } from "kysely";
import { buildCaseTypeMap } from "@/lib/case-store/store";
import type { AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { CASE_CLAIM_CASE_TYPE } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { readRawDocument } from "../oldShape";
import { writesIntoOperations } from "../steps/writesIntoOperations";
import { parseHead, structurePhase } from "../structure";
import { preStepDocument } from "./postgresSeed";
import { carriersOfPersistedDoc } from "./rawFixture";

/** Insert the stored schemas of `fixtureId` for `appId`, with the
 *  triggers held. */
export async function seedStoredSchemas(
	db: Kysely<AppDatabase>,
	appId: string,
	fixtureId: string,
): Promise<void> {
	const raw = readRawDocument(
		appId,
		carriersOfPersistedDoc(preStepDocument(fixtureId)),
	);
	const structure = structurePhase(raw);
	const head = parseHead(appId, structure.persisted);
	if (!head.ok)
		throw new Error(`The fixture ${fixtureId} does not parse at the head.`);
	const doc = writesIntoOperations(head.doc, structure.facts).doc;
	await db.transaction().execute(async (tx) => {
		await sql`SET LOCAL session_replication_role = replica`.execute(tx);
		for (const caseType of buildCaseTypeMap(toPersistableDoc(doc)).values()) {
			if (caseType.name === CASE_CLAIM_CASE_TYPE) continue;
			await sql`
				INSERT INTO case_type_schemas (app_id, case_type, schema, synced_seq)
				VALUES (${appId}, ${caseType.name},
					${JSON.stringify(caseTypeToJsonSchema(caseType))}::jsonb, 1)
			`.execute(tx);
		}
	});
}
