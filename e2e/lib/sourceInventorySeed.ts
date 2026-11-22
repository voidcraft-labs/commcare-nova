import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { v7 } from "uuid";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import {
	canonicalLookupTable,
	lookupDefinitionDigest,
} from "@/lib/deployment/hqResourceBaseline";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	beginInventory,
	pauseInventory,
	promoteInventory,
	stageInventoryPage,
} from "@/lib/lookup/generations/store";
import { createManagedLookupTablesInTransaction } from "@/lib/lookup/managed";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
import { buildUrl } from "@/lib/routing/location";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";

export async function seedSourceInventory(
	projectId: string,
	actorId: string,
	sessionToken: string,
) {
	const { appId } = await createExplicitBlankApp(
		actorId,
		projectId,
		randomUUID(),
		{ name: "Health network", status: "complete" },
	);
	const session = (
		await sql<{
			id: string;
		}>`SELECT id FROM auth_session WHERE "userId"=${actorId} AND token=${sessionToken} AND "expiresAt">now()`.execute(
			await getAppDb(),
		)
	).rows[0];
	if (!session)
		throw new Error("The source inventory seed needs a live browser session.");
	const scope = { projectId, actorId, role: "owner" };
	const tableId = lookupTableIdSchema.parse(v7());
	const origin = {
		server: "india" as const,
		domain: "network",
		remoteId: "a".repeat(32),
	};
	const hqTable = {
		id: origin.remoteId,
		tag: "clinics",
		fields: ["name"],
		fieldProperties: { name: [] },
		itemAttributes: [],
		isGlobal: true,
	};
	const canonical = canonicalLookupTable(hqTable, null);
	const key = "unusable synthetic connection";
	await (await getAppDb())
		.insertInto("user_settings")
		.values({
			user_id: actorId,
			commcare_username: "source-editor@example.org",
			commcare_api_key: key,
			commcare_server: origin.server,
			approved_domains: JSON.stringify([
				{ name: origin.domain, displayName: "Network" },
			]),
			updated_at: new Date(),
		})
		.execute();
	await withAppTx(async (tx) =>
		createManagedLookupTablesInTransaction(
			tx,
			await authorizeLookupWriteInTransaction(tx, scope, "edit"),
			[
				{
					binding: {
						tableId,
						tag: "clinics",
						columns: { name: lookupColumnIdSchema.parse(v7()) },
					},
					name: "Clinics",
					content: { fields: ["name"], rows: [] },
					origin: { ...origin, canonical: { ...canonical } },
				},
			],
			new Date(),
		),
	);
	const access = {
		scope,
		tableId,
		grant: { kind: "session" as const, sessionId: session.id },
	};
	const candidate = {
		...origin,
		keyDigest: canonicalJsonDigest(key),
		canonicalDefinition: lookupDefinitionDigest(hqTable),
		definitionDigest: canonicalJsonDigest(hqTable),
	};
	const rows = ["Hill clinic", `${"North 🌱 ".repeat(14000)}Last ridge`].map(
		(value, i) => ({
			sourceId: String(i + 1).padStart(32, "0"),
			attributes: {},
			fields: { name: [{ value, properties: {} }] },
		}),
	);
	const observedRows = rows.map((row) => ({
		id: row.sourceId,
		itemAttributes: row.attributes,
		fields: row.fields,
	}));
	const prefixDigest = (end: number) => {
		const digest = createHash("sha256")
			.update(candidate.definitionDigest)
			.update("\n");
		for (const row of observedRows.slice(0, end))
			digest.update(canonicalJsonText(row)).update("\n");
		return digest.digest("hex");
	};
	const page = {
		start: 0,
		offset: rows.length,
		throughDigest: prefixDigest(rows.length),
		rows,
	};
	const { run } = await beginInventory(access, candidate);
	await stageInventoryPage(run, page);
	await promoteInventory(
		run,
		{
			definitionDigest: candidate.definitionDigest,
			throughDigest: page.throughDigest,
			offset: rows.length,
			totalCount: rows.length,
		},
		{
			...canonicalLookupTable(hqTable, observedRows),
			source: {
				...canonical.source,
				inventory: "complete",
				distribution: "global",
				indexEvidence: "unobserved",
				storage: "generation",
			},
		},
	);
	const second = await beginInventory(access, candidate);
	await stageInventoryPage(second.run, {
		start: 0,
		offset: 1,
		throughDigest: prefixDigest(1),
		rows: rows.slice(0, 1),
	});
	await pauseInventory(second.run);
	return {
		route: buildUrl(`/build/${appId}`, { kind: "project-data", tableId }),
	};
}
