/** Actual byte validation, metadata transactions and Project/content locks. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/client";
import { Client as PgClient, Pool } from "pg";
import { beforeEach, expect, it, vi } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { withPostgresCommitResponseLoss } from "@/__tests__/helpers/postgresCommitResponseLoss";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { __setAppPoolForTests } from "@/lib/db/pg";
import { deleteAsset, uploadAssetBytes } from "@/lib/storage/media";
import {
	registerUploadMediaAsset,
	uploadMediaAssetInputSchema,
} from "../tools/uploadMediaAsset";
import { withMcpClient } from "./client";

vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: vi.fn(),
	deleteAsset: vi.fn(),
}));
const h = setupAppStateTestDb("mcp_media_upload_", { authSchema: "migrated" });
const ACTOR = "uploader",
	PROJECT = "program";
const PNG = readFileSync("public/nova-icons/household.png");
const HASH = createHash("sha256").update(PNG).digest("hex");
const KEY = `projects/${PROJECT}/${HASH}.png`;
const objects = new Map<string, Buffer>();
beforeEach(() => {
	objects.clear();
	vi.mocked(uploadAssetBytes)
		.mockReset()
		.mockImplementation(async ({ gcsObjectKey, bytes }) => {
			objects.set(gcsObjectKey, Buffer.from(bytes));
		});
	vi.mocked(deleteAsset)
		.mockReset()
		.mockImplementation(async (key) => {
			objects.delete(key);
		});
});
function asUser<T>(run: (client: Client) => Promise<T>, userId = ACTOR) {
	return withMcpClient(
		(server) =>
			registerUploadMediaAsset(server, {
				userId,
				scopes: ["nova.write"],
				authKind: "oauth",
			}),
		run,
	);
}
function call(client: Client, extra: Record<string, unknown> = {}) {
	return client.callTool({
		name: "upload_media_asset",
		arguments: {
			filename: "household.png",
			mime_type: "image/png",
			data_base64: PNG.toString("base64"),
			project_id: PROJECT,
			...extra,
		},
	});
}
type Result = Awaited<ReturnType<typeof call>>;
function payload(result: Result, error = false) {
	expect(result.isError ?? false, JSON.stringify(result.content)).toBe(error);
	expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
	const part = result.content[0];
	if (part.type !== "text") throw new Error("Expected upload result text");
	return JSON.parse(part.text);
}
async function rows() {
	return h.db().selectFrom("media_assets").selectAll().orderBy("id").execute();
}
async function controller<T>(run: (pg: PgClient) => Promise<T>) {
	const pg = new PgClient({ connectionString: h.uri() });
	try {
		await pg.connect();
		return await run(pg);
	} finally {
		await pg.end();
	}
}

it("publishes validated ready metadata and deduplicates across Project co-members without rewriting bytes", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await h.seedProjectMember("co-member", PROJECT, "editor");
	const created = await asUser(async (client) => payload(await call(client)));
	expect(created).toEqual({
		asset_id: expect.any(String),
		kind: "image",
		deduplicated: false,
	});
	const stored = await rows();
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({
		id: created.asset_id,
		project_id: PROJECT,
		owner: ACTOR,
		status: "ready",
		content_hash: HASH,
		kind: "image",
		mime_type: "image/png",
		extension: ".png",
		size_bytes: String(PNG.length),
		dimensions: { width: 512, height: 512 },
		duration_ms: null,
		gcs_object_key: KEY,
		original_filename: "household.png",
		display_name: "household.png",
	});
	expect(objects).toEqual(new Map([[KEY, PNG]]));
	expect(vi.mocked(uploadAssetBytes).mock.calls).toEqual([
		[{ gcsObjectKey: KEY, bytes: PNG, contentType: "image/png" }],
	]);
	expect(
		await asUser(
			async (client) =>
				payload(await call(client, { filename: "renamed.png" })),
			"co-member",
		),
	).toEqual({ ...created, deduplicated: true });
	expect(await rows()).toEqual(stored);
	expect(uploadAssetBytes).toHaveBeenCalledTimes(1);
	expect(deleteAsset).not.toHaveBeenCalled();
});

it("uses the real personal Project when omitted and keeps equal bytes in separate Projects", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const shared = await asUser(async (client) => payload(await call(client)));
	const personal = await asUser(async (client) =>
		payload(await call(client, { project_id: undefined })),
	);
	expect(personal.asset_id).not.toBe(shared.asset_id);
	const stored = await rows();
	expect(stored).toHaveLength(2);
	const own = stored.find((row) => row.id === personal.asset_id);
	expect(own?.project_id).not.toBe(PROJECT);
	const org = await h
		.pool()
		.query("SELECT id FROM auth_organization WHERE slug = $1", [
			`personal-${ACTOR}`,
		]);
	expect(org.rows).toEqual([{ id: own?.project_id }]);
	expect(objects).toEqual(
		new Map([
			[KEY, PNG],
			[`projects/${own?.project_id}/${HASH}.png`, PNG],
		]),
	);
	expect(
		await asUser(async (client) =>
			payload(await call(client, { project_id: undefined })),
		),
	).toEqual({ ...personal, deduplicated: true });
	expect(uploadAssetBytes).toHaveBeenCalledTimes(2);
});

it("real metadata rejection rolls back and removes its unclaimed object before a retry", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await h
		.pool()
		.query(`CREATE FUNCTION reject_media() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private metadata rejection'; END $$;
		CREATE TRIGGER reject_media BEFORE INSERT ON media_assets FOR EACH ROW EXECUTE FUNCTION reject_media()`);
	await asUser(async (client) => {
		expect(payload(await call(client), true)).toEqual({
			error_type: "internal",
			message: "Something went wrong during generation.",
			project_id: PROJECT,
		});
		expect(await rows()).toEqual([]);
		expect(objects.size).toBe(0);
		expect(vi.mocked(deleteAsset).mock.calls).toEqual([[KEY]]);
		await h.pool().query("DROP TRIGGER reject_media ON media_assets");
		expect(payload(await call(client))).toMatchObject({ deduplicated: false });
	});
	expect(await rows()).toHaveLength(1);
	expect(objects).toEqual(new Map([[KEY, PNG]]));
});

it("reconciles an object-store error after bytes were written and then allows retry", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	vi.mocked(uploadAssetBytes).mockImplementationOnce(
		async ({ gcsObjectKey, bytes }) => {
			objects.set(gcsObjectKey, Buffer.from(bytes));
			throw new Error("private storage response lost");
		},
	);
	await asUser(async (client) => {
		expect(payload(await call(client), true)).toEqual({
			error_type: "internal",
			message: "Something went wrong during generation.",
			project_id: PROJECT,
		});
		expect(objects.size).toBe(0);
		expect(await rows()).toEqual([]);
		expect(payload(await call(client))).toMatchObject({ deduplicated: false });
	});
	expect(objects).toEqual(new Map([[KEY, PNG]]));
});

it("refuses invalid real bytes and schema inputs before any metadata or storage allocation", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	// A repeated string is length-checked without decoding or copying a 50 MB
	// file. The SDK uses this exact published schema before invoking the tool.
	const oversized = uploadMediaAssetInputSchema.safeParse({
		filename: "large.mp4",
		mime_type: "video/mp4",
		data_base64: "A".repeat(Math.ceil((50 * 1024 * 1024) / 3) * 4 + 1),
	});
	expect(oversized.success).toBe(false);
	if (oversized.success) throw new Error("The inline limit was not enforced");
	expect(oversized.error.issues).toEqual([
		expect.objectContaining({ code: "too_big", path: ["data_base64"] }),
	]);
	await asUser(async (client) => {
		for (const extra of [
			{ data_base64: "!!!!" },
			{ data_base64: Buffer.from("not a PNG").toString("base64") },
			{ filename: "household.m4a" },
			{ mime_type: "image/jpeg" },
			{ data_base64: PNG.subarray(0, 24).toString("base64") },
		])
			expect(payload(await call(client, extra), true)).toMatchObject({
				error_type: "invalid_input",
			});
		for (const extra of [
			{ filename: "" },
			{ filename: "x".repeat(256) },
			{ project_id: "" },
			{ unexpected: true },
		]) {
			const result = await call(client, extra);
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining("Input validation error"),
				},
			]);
		}
	});
	expect(await rows()).toEqual([]);
	expect(uploadAssetBytes).not.toHaveBeenCalled();
	expect(deleteAsset).not.toHaveBeenCalled();
});

it("enforces Project edit membership before creating or deduplicating a media row", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "viewer");
	await asUser(async (client) => {
		expect(payload(await call(client), true)).toMatchObject({
			error_type: "permission_denied",
			message: expect.stringContaining("can't upload media"),
		});
		const foreign = payload(
			await call(client, { project_id: "foreign" }),
			true,
		);
		expect(foreign).toEqual({
			error_type: "not_found",
			message: "Project not found.",
			project_id: "foreign",
		});
		expect(
			payload(await call(client, { project_id: "missing" }), true),
		).toEqual({ ...foreign, project_id: "missing" });
	});
	expect(await rows()).toEqual([]);
	expect(uploadAssetBytes).not.toHaveBeenCalled();
});

it("a role revoked while object storage is in flight cannot publish ready metadata", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await controller(async (pg) => {
		vi.mocked(uploadAssetBytes).mockImplementationOnce(
			async ({ gcsObjectKey, bytes }) => {
				objects.set(gcsObjectKey, Buffer.from(bytes));
				await pg.query(
					'UPDATE auth_member SET role = $1 WHERE "userId" = $2 AND "organizationId" = $3',
					["viewer", ACTOR, PROJECT],
				);
			},
		);
		await asUser(async (client) => {
			expect(payload(await call(client), true)).toMatchObject({
				error_type: "permission_denied",
			});
		});
	});
	expect(await rows()).toEqual([]);
	expect(objects.size).toBe(0);
	expect(vi.mocked(deleteAsset).mock.calls).toEqual([[KEY]]);
});

it.each(["viewer", null])(
	"a caller changed to %s while waiting for content ownership cannot receive a deduplicated asset",
	async (role) => {
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		await asUser(async (client) => payload(await call(client)));
		const before = await rows();
		await asUser(async (client) => {
			const result = await whileBlocked(
				h,
				(pg) =>
					pg.query(
						"SELECT pg_advisory_xact_lock(hashtextextended($1, 0::bigint))",
						[`projects/${PROJECT}/${HASH}`],
					),
				() => call(client),
				async (settled) => {
					expect(settled).toBe(false);
					await controller((pg) =>
						role === null
							? pg.query(
									'DELETE FROM auth_member WHERE "userId" = $1 AND "organizationId" = $2',
									[ACTOR, PROJECT],
								)
							: pg.query(
									'UPDATE auth_member SET role = $1 WHERE "userId" = $2 AND "organizationId" = $3',
									[role, ACTOR, PROJECT],
								),
					);
				},
			);
			expect(payload(result, true)).toMatchObject({
				error_type: role === null ? "not_found" : "permission_denied",
			});
		});
		expect(await rows()).toEqual(before);
		expect(objects).toEqual(new Map([[KEY, PNG]]));
		expect(uploadAssetBytes).toHaveBeenCalledTimes(1);
		expect(deleteAsset).not.toHaveBeenCalled();
	},
);

it("recovery preserves committed bytes but refuses the asset result after membership was revoked", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await withPostgresCommitResponseLoss(
		h.uri(),
		async (peer) => {
			const pool = new Pool({ connectionString: peer.uri, max: 1 });
			__setAppPoolForTests(pool);
			try {
				await asUser(async (client) => {
					expect(payload(await call(client), true)).toMatchObject({
						error_type: "permission_denied",
					});
				});
				expect(peer.droppedResponses()).toBe(1);
				expect(await rows()).toHaveLength(1);
				expect(objects).toEqual(new Map([[KEY, PNG]]));
				expect(deleteAsset).not.toHaveBeenCalled();
			} finally {
				__setAppPoolForTests(h.pool());
				await pool.end();
			}
		},
		() =>
			controller((pg) =>
				pg.query(
					'UPDATE auth_member SET role = $1 WHERE "userId" = $2 AND "organizationId" = $3',
					["viewer", ACTOR, PROJECT],
				),
			),
	);
});

it("returns the exact committed asset after the PostgreSQL COMMIT response is lost", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await withPostgresCommitResponseLoss(h.uri(), async (peer) => {
		const pool = new Pool({ connectionString: peer.uri, max: 1 });
		__setAppPoolForTests(pool);
		try {
			const result = await asUser(async (client) =>
				payload(await call(client)),
			);
			expect(peer.droppedResponses()).toBe(1);
			const stored = await rows();
			expect(stored).toHaveLength(1);
			expect(result).toEqual({
				asset_id: stored[0].id,
				kind: "image",
				deduplicated: false,
			});
			expect(stored[0]).toMatchObject({
				status: "ready",
				content_hash: HASH,
				gcs_object_key: KEY,
			});
			expect(objects).toEqual(new Map([[KEY, PNG]]));
			expect(uploadAssetBytes).toHaveBeenCalledTimes(1);
			expect(deleteAsset).not.toHaveBeenCalled();
			expect(
				await asUser(async (client) => payload(await call(client))),
			).toEqual({ ...result, deduplicated: true });
			expect(await rows()).toEqual(stored);
		} finally {
			__setAppPoolForTests(h.pool());
			await pool.end();
		}
	});
});
