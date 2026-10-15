/**
 * What the cutover sends Cloud KMS to decrypt a member's stored key, how a
 * refusal surfaces, and `--prove-decrypt`: which key it proves the grant
 * with, how it waits while IAM applies the grant, and that it sends nothing
 * to HQ and writes no row. KMS is a peer under the test's control at the
 * endpoint's address; the waits run on the test's own clock.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	type DecryptClock,
	KmsDecryptRefusedError,
	type KmsDecryptTransport,
	kmsDecrypt,
	storedKeyName,
} from "../kmsDecrypt";
import { runMigrate } from "../run";
import { fixtureApp, seedFixtureApp } from "./fixtures/seed";

const h = setupAppStateTestDb("hq_cutover_kms_", { authSchema: "migrated" });

const PROJECT = "project-kms";
const KEY_NAME = storedKeyName("commcare-nova-test");

interface Received {
	readonly path: string;
	readonly authorization: string | undefined;
	readonly body: { ciphertext?: string };
}

/** A KMS peer: answers each decrypt with the next scripted answer. */
class KmsPeer {
	readonly received: Received[] = [];
	answers: { status: number; body: unknown }[] = [];
	private server: Server | null = null;

	async start(): Promise<string> {
		this.server = createServer((request, response) => {
			this.answer(request).then(
				({ status, body }) => {
					response.writeHead(status, { "content-type": "application/json" });
					response.end(JSON.stringify(body));
				},
				(error: unknown) => {
					response.writeHead(500, { "content-type": "text/plain" });
					response.end(String(error));
				},
			);
		});
		await new Promise<void>((resolve) =>
			this.server?.listen(0, "127.0.0.1", resolve),
		);
		const { port } = this.server.address() as AddressInfo;
		return `http://127.0.0.1:${port}`;
	}

	private async answer(request: IncomingMessage) {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		this.received.push({
			path: request.url ?? "",
			authorization: request.headers.authorization,
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
		});
		return (
			this.answers.shift() ?? {
				status: 500,
				body: { error: { status: "INTERNAL" } },
			}
		);
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server === null) return;
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

const PERMISSION_DENIED = {
	status: 403,
	body: { error: { code: 403, status: "PERMISSION_DENIED" } },
};

function plaintextAnswer(text: string) {
	return {
		status: 200,
		body: { plaintext: Buffer.from(text, "utf8").toString("base64") },
	};
}

/** A clock the test owns: each wait moves it on, and the waits are recorded. */
function testClock(): DecryptClock & { readonly waits: number[] } {
	let now = 0;
	const waits: number[] = [];
	return {
		waits,
		now: () => now,
		sleep: async (milliseconds) => {
			waits.push(milliseconds);
			now += milliseconds;
		},
	};
}

let peer: KmsPeer;
let transport: KmsDecryptTransport;

beforeEach(async () => {
	peer = new KmsPeer();
	transport = {
		endpoint: await peer.start(),
		keyName: KEY_NAME,
		accessToken: async () => "test-token",
	};
});

afterEach(async () => {
	await peer.stop();
});

async function seedMember(
	userId: string,
	joinedAt: Date,
	settings: { ciphertext: string; domains: readonly string[] } | null,
): Promise<void> {
	await h.seedProjectMember(userId, PROJECT, "editor");
	await sql`UPDATE auth_member SET "createdAt" = ${joinedAt} WHERE "userId" = ${userId}`.execute(
		h.db(),
	);
	if (settings === null) return;
	await sql`
		INSERT INTO user_settings (user_id, commcare_username, commcare_api_key, commcare_server, approved_domains)
		VALUES (${userId}, ${`${userId}@example.org`}, ${settings.ciphertext}, 'production',
			${JSON.stringify(settings.domains.map((name) => ({ name, displayName: name })))}::jsonb)
	`.execute(h.db());
}

async function seedDeployedApp(createdBy: string): Promise<void> {
	await seedFixtureApp(
		h.db(),
		fixtureApp("navigation-base", {
			appId: "app-kms",
			projectId: PROJECT,
			owner: createdBy,
		}),
	);
	const deployment = await sql<{ id: string }>`
		INSERT INTO app_deployments (app_id, project_id, server, domain, state, phases, created_by)
		VALUES ('app-kms', ${PROJECT}, 'production', 'field-ops', 'uploaded', '{}'::jsonb, ${createdBy})
		RETURNING id::text AS id
	`.execute(h.db());
	await sql`
		INSERT INTO app_deployment_resources (deployment_id, kind, nova_resource_id, remote_id, ownership, pushed_revision, pushed_at)
		VALUES (${deployment.rows[0]?.id ?? ""}::uuid, 'app', 'app-kms', 'hq-app-kms', 'nova-created', 1, now())
	`.execute(h.db());
}

describe("the KMS decrypt", () => {
	it("posts the stored ciphertext to the key's decrypt method with the identity's token", async () => {
		peer.answers = [plaintextAnswer("member-api-key")];
		await expect(kmsDecrypt("c2VjcmV0", transport)).resolves.toBe(
			"member-api-key",
		);
		expect(peer.received).toEqual([
			{
				path: `/v1/${KEY_NAME}:decrypt`,
				authorization: "Bearer test-token",
				body: { ciphertext: "c2VjcmV0" },
			},
		]);
	});

	it("surfaces a refusal as a stop that names no key", async () => {
		peer.answers = [PERMISSION_DENIED];
		const refusal = await kmsDecrypt("c2VjcmV0", transport).catch(
			(error: unknown) => error,
		);
		expect(refusal).toBeInstanceOf(KmsDecryptRefusedError);
		expect(refusal).toMatchObject({ kind: "permission", status: 403 });
		expect(String((refusal as Error).message)).not.toContain("c2VjcmV0");
		peer.answers = [{ status: 404, body: { error: { status: "NOT_FOUND" } } }];
		await expect(kmsDecrypt("c2VjcmV0", transport)).rejects.toMatchObject({
			kind: "other",
		});
	});
});

describe("--prove-decrypt", () => {
	it("decrypts only the first qualifying member's key, in user id order, retrying while IAM applies the grant", async () => {
		await seedMember("member-b", new Date("2026-01-01T00:00:00Z"), {
			ciphertext: "key-of-b",
			domains: ["field-ops"],
		});
		await seedMember("member-a", new Date("2026-02-01T00:00:00Z"), {
			ciphertext: "key-of-a",
			domains: ["field-ops"],
		});
		await seedMember("member-0", new Date("2026-01-01T00:00:00Z"), {
			ciphertext: "key-of-0",
			domains: ["another-space"],
		});
		await seedDeployedApp("member-b");
		const clock = testClock();
		peer.answers = [PERMISSION_DENIED, PERMISSION_DENIED, plaintextAnswer("x")];
		const counted = await sql<{ count: string }>`
			SELECT count(*)::text AS count FROM app_migration_notice_key_readers
		`.execute(h.db());
		const result = await runMigrate(h.db(), {
			mode: "prove-decrypt",
			kms: () => transport,
			clock,
		});
		expect(result.outcome).toEqual({ outcome: "ok" });
		expect(result.exitCode).toBe(0);
		expect(peer.received.map((request) => request.body.ciphertext)).toEqual([
			"key-of-a",
			"key-of-a",
			"key-of-a",
		]);
		expect(clock.waits).toEqual([10_000, 10_000]);
		expect(JSON.stringify(result.report.all())).not.toContain("key-of-a");
		const after = await sql<{ count: string }>`
			SELECT count(*)::text AS count FROM app_migration_notice_key_readers
		`.execute(h.db());
		expect(after.rows).toEqual(counted.rows);
	});

	it("prints failed once ten minutes of permission refusals have passed", async () => {
		await seedMember("member-a", new Date("2026-01-01T00:00:00Z"), {
			ciphertext: "key-of-a",
			domains: ["field-ops"],
		});
		await seedDeployedApp("member-a");
		const clock = testClock();
		peer.answers = Array.from({ length: 100 }, () => PERMISSION_DENIED);
		const result = await runMigrate(h.db(), {
			mode: "prove-decrypt",
			kms: () => transport,
			clock,
		});
		expect(result.outcome).toEqual({ outcome: "failed" });
		expect(result.exitCode).toBe(1);
		expect(clock.now()).toBe(600_000);
		expect(peer.received).toHaveLength(61);
	});

	it("prints no-key where no member's key qualifies, sending nothing", async () => {
		await seedMember("member-a", new Date("2026-01-01T00:00:00Z"), null);
		await seedDeployedApp("member-a");
		const result = await runMigrate(h.db(), {
			mode: "prove-decrypt",
			kms: () => transport,
			clock: testClock(),
		});
		expect(result.outcome).toEqual({ outcome: "no-key" });
		expect(result.exitCode).toBe(0);
		expect(peer.received).toEqual([]);
	});
});
