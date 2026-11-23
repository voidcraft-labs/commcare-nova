import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { withAppTx } from "@/lib/db/pg";
import type { LookupValueEditRequest } from "../largeValues/input";
import {
	applyLookupValueEditInTransaction,
	readLookupValueInTransaction,
} from "../largeValues/service";
import { parseLookupRevision } from "../schema";
import { createLookupRow, createLookupTable } from "../service";
import { authorizeLookupWriteInTransaction } from "../writerTransaction";

const h = setupAppStateTestDb("lookup_cell_", { authSchema: "migrated" });
const scope = {
	projectId: "lexical-project",
	actorId: "editor",
	role: "editor" as const,
};
const sha = (text: string | Buffer) =>
	createHash("sha256").update(text).digest("hex");
async function seed() {
	await h.seedProjectMember(scope.actorId, scope.projectId, scope.role);
	const table = await createLookupTable(scope, {
		name: "Notes",
		tag: "notes",
		columns: [{ wireName: "note", label: "Note", dataType: "text" }],
	});
	const columnId = table.columns[0].id;
	const row = await createLookupRow(scope, {
		tableId: table.id,
		toIndex: 0,
		expectedTableRevision: table.tableRevision,
		values: { [columnId]: "A🌱Z" },
	});
	return {
		tableId: table.id,
		rowId: row.rowId,
		slot: { kind: "cell" as const, columnId },
		expectedTableRevision: row.tableRevision,
	};
}

function run(request: LookupValueEditRequest, grant = "session-one") {
	return withAppTx(async (tx) =>
		applyLookupValueEditInTransaction(
			tx,
			await authorizeLookupWriteInTransaction(tx, scope, "edit"),
			request,
			grant,
		),
	);
}

it("replaces a span with split multibyte input, streams the whole cell outside JSONB, and retries one reviewed edit exactly once", async () => {
	const target = await seed();
	const replacement = "\ufeff🍃雪\\".repeat(9000);
	const raw = Buffer.from(replacement);
	const operationId = randomUUID();
	const common = { tableId: target.tableId, operationId };
	const begin = {
		kind: "begin" as const,
		...target,
		operationId,
		baseDigest: sha("A🌱Z"),
		startByte: 1,
		endByte: 5,
		replacementBytes: raw.length,
		replacementDigest: sha(raw),
	};
	await expect(run({ ...begin, startByte: 2 })).rejects.toMatchObject({
		code: "invalid_input",
	});
	expect(await run(begin)).toMatchObject({ nextOffset: 0 });
	await expect(run({ ...begin, endByte: 6 })).rejects.toMatchObject({
		code: "conflict",
	});
	await expect(run({ kind: "finish", ...common })).rejects.toMatchObject({
		code: "invalid_input",
	});
	let offset = 0;
	while (offset < raw.length) {
		const chunk = raw.subarray(offset, offset + 16001);
		const request = {
			kind: "append" as const,
			...common,
			offset,
			base64: chunk.toString("base64"),
		};
		expect((await run(request)).nextOffset).toBe(offset + chunk.length);
		expect((await run(request)).nextOffset).toBe(offset + chunk.length);
		offset += chunk.length;
	}
	await expect(
		run({ kind: "finish", ...common }, "session-two"),
	).rejects.toMatchObject({ code: "not_found" });
	const finished = await run({ kind: "finish", ...common });
	expect(await run({ kind: "finish", ...common })).toEqual(finished);
	const row = await sql<{
		marker: string;
		bytes: string;
		refs: number;
	}>`SELECT "values"->>${target.slot.columnId} AS marker,
		external_bytes::text AS bytes,(SELECT count(*)::integer FROM lookup_cell_value_refs) AS refs
		FROM lookup_rows WHERE project_id=${scope.projectId} AND id=${target.rowId}`.execute(
		h.db(),
	);
	expect(row.rows[0]).toEqual({
		marker: "",
		bytes: String(raw.length + 2),
		refs: 1,
	});
	const current = {
		...target,
		expectedTableRevision: target.expectedTableRevision,
	};
	const stored = await h
		.db()
		.selectFrom("lookup_tables")
		.select("rows_revision")
		.where("id", "=", target.tableId)
		.executeTakeFirstOrThrow();
	current.expectedTableRevision = parseLookupRevision(stored.rows_revision);
	let seen = "";
	let cursor: number | null = 0;
	while (cursor !== null) {
		const byteOffset: number = cursor;
		const piece = await withAppTx((tx) =>
			readLookupValueInTransaction(tx, scope, { ...current, byteOffset }),
		);
		expect(piece.valueDigest).toBe(sha("A" + replacement + "Z"));
		expect(Buffer.byteLength(piece.text)).toBeLessThanOrEqual(8192);
		seen += piece.text;
		cursor = piece.nextByteOffset;
	}
	expect(seen).toBe("A" + replacement + "Z");
	// A small span keeps all completely untouched blobs in the Project pool.
	const blobs = await sql<{
		id: string;
	}>`SELECT id FROM lookup_cell_blobs`.execute(h.db());
	const secondId = randomUUID();
	const small = {
		...begin,
		...current,
		baseDigest: sha(seen),
		operationId: secondId,
		startByte: 0,
		endByte: 1,
		replacementBytes: 1,
		replacementDigest: sha("B"),
	};
	await run(small);
	await run({
		kind: "append",
		tableId: target.tableId,
		operationId: secondId,
		offset: 0,
		base64: "Qg==",
	});
	await run({ kind: "finish", tableId: target.tableId, operationId: secondId });
	const retained = await sql<{
		id: string;
	}>`SELECT DISTINCT s.blob_id AS id FROM lookup_cell_segments s JOIN lookup_cell_value_refs r USING(project_id,value_id)`.execute(
		h.db(),
	);
	expect(
		retained.rows.filter((b) => blobs.rows.some((old) => old.id === b.id))
			.length,
	).toBeGreaterThan(1);
});

it("leaves actual row bytes and revisions intact after invalid input, digest disagreement or cancellation", async () => {
	const target = await seed();
	const operationId = randomUUID();
	const common = { tableId: target.tableId, operationId };
	const request = {
		kind: "begin" as const,
		...target,
		operationId,
		baseDigest: sha("A🌱Z"),
		startByte: 1,
		endByte: 5,
		replacementBytes: 1,
		replacementDigest: sha(Buffer.from([0xff])),
	};
	await run(request);
	await run({ kind: "append", ...common, offset: 0, base64: "/w==" });
	await expect(run({ kind: "finish", ...common })).rejects.toMatchObject({
		code: "invalid_input",
	});
	await run({ kind: "cancel", ...common });
	await expect(run({ kind: "finish", ...common })).rejects.toMatchObject({
		code: "conflict",
	});
	const other = randomUUID();
	await run({ ...request, operationId: other, replacementDigest: sha("B") });
	await run({
		kind: "append",
		...common,
		operationId: other,
		offset: 0,
		base64: "QQ==",
	});
	await expect(
		run({ kind: "finish", ...common, operationId: other }),
	).rejects.toMatchObject({ code: "invalid_input" });
	const piece = await withAppTx((tx) =>
		readLookupValueInTransaction(tx, scope, target),
	);
	expect(piece).toMatchObject({ text: "A🌱Z", valueDigest: sha("A🌱Z") });
});

it("frees an abandoned edit's work slot when its lease lapses, and takes a slot again before it continues", async () => {
	const target = await seed();
	const begin = (operationId: string) =>
		run({
			kind: "begin",
			...target,
			operationId,
			baseDigest: sha("A🌱Z"),
			startByte: 1,
			endByte: 5,
			replacementBytes: 2,
			replacementDigest: sha("BC"),
		});
	const [first, second, third] = [randomUUID(), randomUUID(), randomUUID()];
	await begin(first);
	await begin(second);
	/* The Project's two work slots are held while both edits run. */
	await expect(begin(third)).rejects.toMatchObject({
		code: "storage_limit",
	});
	/* Nobody finishes or cancels them: eleven minutes after their last step,
	 * well inside the staged input's own lifetime, they hold no slot. */
	await sql`UPDATE lookup_bulk_reservations SET expires_at=expires_at-interval '11 minutes'
		WHERE project_id=${scope.projectId} AND kind='cell'`.execute(h.db());
	expect(await begin(third)).toMatchObject({ nextOffset: 0 });
	/* A lapsed edit that resumes takes a free slot again, and one that finds
	 * none waits for a job to finish. */
	expect(
		await run({
			kind: "append",
			tableId: target.tableId,
			operationId: first,
			offset: 0,
			base64: "Qg==",
		}),
	).toMatchObject({ nextOffset: 1 });
	await expect(
		run({
			kind: "append",
			tableId: target.tableId,
			operationId: second,
			offset: 0,
			base64: "Qg==",
		}),
	).rejects.toMatchObject({ code: "storage_limit" });
});
