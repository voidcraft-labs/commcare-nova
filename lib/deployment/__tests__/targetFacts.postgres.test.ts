/**
 * `readTargetFacts` against real Postgres: a viewer reads a deployment's
 * facts and never its source, a baseline that gives none answers null, and
 * an unchanged baseline is projected once per instance.
 *
 * What a mocked test cannot show: the reader's first statement really
 * selects no bytes, and a second read of the same row is answered by that
 * statement alone (the query count is taken through a Kysely plugin on the
 * injected handle), with the row's own date; a rewritten baseline, or a
 * changed ownership of GPS capture over the same bytes, is read afresh; and
 * a baseline rewritten between the two statements is answered from the
 * bytes the second one read.
 */

import { gzipSync } from "node:zlib";
import type {
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { __setAppDbForTests } from "@/lib/db/pg";
import { normalizeHqAppSource } from "../hqSourceBaseline";
import {
	type DeploymentScope,
	foldDeploymentAttempt,
	readTargetFacts,
	recordCreatedRemoteApp,
	recordRemoteResource,
} from "../store";
import type { AppBaselineWrite, AppOwnership } from "../types";

const h = setupAppStateTestDb("target_facts_", {
	authSchema: "migrated",
	poolMax: 4,
});

const AT = "2026-11-10T09:00:00.000Z";
const LATER = "2026-11-11T09:00:00.000Z";
const LATEST = "2026-11-12T09:00:00.000Z";
const TARGET = { server: "production" as const, domain: "acme" };

const OWNERSHIP: AppOwnership = {
	addOns: [],
	profileProperties: ["cc-show-saved", "cc-show-incomplete"],
	profileCustomProperties: [],
	autoGpsCapture: false,
};

async function seed(): Promise<DeploymentScope> {
	await h.seedApp({
		id: "app-1",
		owner: "u1",
		project_id: "proj-1",
		app_name: "Vaccine Tracker",
	});
	await h.seedProjectMember("u1", "proj-1", "owner");
	return {
		appId: "app-1",
		projectId: "proj-1",
		role: "owner",
		actorUserId: "u1",
	};
}

async function viewerOf(scope: DeploymentScope): Promise<DeploymentScope> {
	await h.seedProjectMember("u2", scope.projectId, "viewer");
	return { ...scope, role: "viewer", actorUserId: "u2" };
}

/**
 * A read of an app whose fuzzy search setting is `fuzzy`, stored as a
 * publish stores it; `autoGpsCapture` sets the app's own GPS capture, and
 * `novaOwnsAutoGpsCapture` says whether Nova's body set it.
 */
function readBaseline(
	remoteAppId: string,
	fuzzy: string,
	options: {
		readonly origin?: "create" | "push";
		readonly observedAt?: string;
		readonly autoGpsCapture?: boolean;
		readonly novaOwnsAutoGpsCapture?: boolean;
	} = {},
): AppBaselineWrite {
	const read = normalizeHqAppSource({
		doc_type: "Application",
		name: "Vaccine Tracker",
		langs: ["en"],
		translations: { en: { en: "English" } },
		profile: { properties: { "cc-fuzzy-search-enabled": fuzzy } },
		...(options.autoGpsCapture === true ? { auto_gps_capture: true } : {}),
		modules: [],
		_attachments: {},
	});
	if ("malformed" in read) throw new Error(read.malformed);
	return {
		origin: options.origin ?? "push",
		remoteAppId,
		sourceGzip: gzipSync(Buffer.from(read.text, "utf8")),
		sourceBytes: read.bytes,
		sourceDigest: read.digest,
		ownership: {
			...OWNERSHIP,
			autoGpsCapture: options.novaOwnsAutoGpsCapture ?? false,
		},
		observedAt: options.observedAt ?? AT,
		discard: null,
	};
}

function unreadBaseline(remoteAppId: string): AppBaselineWrite {
	return {
		origin: "unread",
		remoteAppId,
		sourceGzip: null,
		sourceBytes: null,
		sourceDigest: null,
		ownership: null,
		observedAt: AT,
		discard: null,
	};
}

async function publish(
	scope: DeploymentScope,
	baseline: AppBaselineWrite,
	ownership: { readonly adoptedBy?: string } = {},
) {
	await foldDeploymentAttempt(
		scope,
		TARGET,
		"preflight",
		{ status: "succeeded", at: AT },
		{ ensure: true },
	);
	return recordRemoteResource(scope, TARGET, {
		kind: "app",
		novaResourceId: scope.appId,
		remoteId: baseline.remoteAppId,
		ownership: ownership.adoptedBy === undefined ? "nova-created" : "adopted",
		adoptedBy: ownership.adoptedBy ?? null,
		pushedRevision: 1,
		uploadedAt: AT,
		remoteRevision: null,
		baseline,
	});
}

/**
 * Count the statements the reader sends, through the handle it reads from.
 * `afterFirst` runs once the first statement has answered and before the
 * reader sees that answer, on a handle the count does not watch.
 */
function countStatements(afterFirst?: () => Promise<void>): {
	readonly count: () => number;
} {
	let statements = 0;
	let ranAfterFirst = false;
	const plugin: KyselyPlugin = {
		transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
			statements += 1;
			return args.node;
		},
		async transformResult(
			args: PluginTransformResultArgs,
		): Promise<QueryResult<UnknownRow>> {
			if (afterFirst !== undefined && !ranAfterFirst) {
				ranAfterFirst = true;
				await afterFirst();
			}
			return args.result;
		},
	};
	__setAppDbForTests(h.db().withPlugin(plugin));
	return { count: () => statements };
}

afterEach(() => {
	__setAppDbForTests(null);
});

describe("readTargetFacts", () => {
	it("answers a viewer with the projection and refuses a caller with no role", async () => {
		const scope = await seed();
		await publish(scope, readBaseline("hq-app", "yes"));
		const viewer = await viewerOf(scope);

		const facts = await readTargetFacts(viewer, TARGET);
		expect(facts).toMatchObject({
			observedAt: AT,
			profileProperties: { "cc-fuzzy-search-enabled": "yes" },
			languageNames: null,
			seeds: "nova",
		});
		expect(facts).not.toHaveProperty("source");

		await expect(
			readTargetFacts({ ...scope, role: "", actorUserId: "u3" }, TARGET),
		).rejects.toMatchObject({ name: "DeploymentError", code: "not_found" });
	});

	it("reads an app brought in as the project space's to seed", async () => {
		const scope = await seed();
		await publish(scope, readBaseline("hq-app", "yes"), { adoptedBy: "u1" });
		expect(await readTargetFacts(scope, TARGET)).toMatchObject({
			languageNames: { en: { en: "English" } },
			seeds: "target",
		});
	});

	it("answers null with no deployment, no baseline, an unread or a shell's baseline, and a baseline that does not verify", async () => {
		const scope = await seed();
		expect(await readTargetFacts(scope, TARGET)).toBeNull();

		await foldDeploymentAttempt(
			scope,
			TARGET,
			"preflight",
			{ status: "succeeded", at: AT },
			{ ensure: true },
		);
		expect(await readTargetFacts(scope, TARGET)).toBeNull();

		await recordCreatedRemoteApp(scope, TARGET, {
			remoteId: "hq-shell",
			baseline: readBaseline("hq-shell", "yes", { origin: "create" }),
		});
		expect(await readTargetFacts(scope, TARGET)).toBeNull();

		await publish(scope, unreadBaseline("hq-app"));
		expect(await readTargetFacts(scope, TARGET)).toBeNull();

		/* Bytes that are not the ones the digest names. */
		const tampered = readBaseline("hq-app", "yes", { observedAt: LATER });
		await publish(scope, {
			...tampered,
			sourceGzip: gzipSync(Buffer.from("{}", "utf8")),
		});
		expect(await readTargetFacts(scope, TARGET)).toBeNull();
	});

	it("projects an unchanged baseline once, and a rewritten one afresh", async () => {
		const scope = await seed();
		await publish(scope, readBaseline("hq-app", "yes"));

		const first = countStatements();
		expect(
			(await readTargetFacts(scope, TARGET))?.profileProperties[
				"cc-fuzzy-search-enabled"
			],
		).toBe("yes");
		/* The row without its bytes, then the bytes. */
		expect(first.count()).toBe(2);

		const second = countStatements();
		expect(
			(await readTargetFacts(scope, TARGET))?.profileProperties[
				"cc-fuzzy-search-enabled"
			],
		).toBe("yes");
		expect(second.count()).toBe(1);

		/* A refresh that rewrites the date over the same bytes is still a
		 * hit, and the date is the row's. */
		__setAppDbForTests(h.db());
		await publish(scope, readBaseline("hq-app", "yes", { observedAt: LATER }));
		const redated = countStatements();
		expect(await readTargetFacts(scope, TARGET)).toMatchObject({
			observedAt: LATER,
			profileProperties: { "cc-fuzzy-search-enabled": "yes" },
		});
		expect(redated.count()).toBe(1);

		__setAppDbForTests(h.db());
		await publish(scope, readBaseline("hq-app", "no", { observedAt: LATEST }));
		const third = countStatements();
		expect(await readTargetFacts(scope, TARGET)).toMatchObject({
			observedAt: LATEST,
			profileProperties: { "cc-fuzzy-search-enabled": "no" },
		});
		expect(third.count()).toBe(2);
	});

	it("projects the same bytes afresh when the baseline's ownership of GPS capture changes", async () => {
		const scope = await seed();
		await publish(
			scope,
			readBaseline("hq-app", "yes", {
				autoGpsCapture: true,
				novaOwnsAutoGpsCapture: false,
			}),
		);
		expect((await readTargetFacts(scope, TARGET))?.autoGpsCapture).toBe(true);

		await publish(
			scope,
			readBaseline("hq-app", "yes", {
				autoGpsCapture: true,
				novaOwnsAutoGpsCapture: true,
				observedAt: LATER,
			}),
		);
		const after = countStatements();
		expect(await readTargetFacts(scope, TARGET)).toMatchObject({
			observedAt: LATER,
			autoGpsCapture: false,
		});
		expect(after.count()).toBe(2);
	});

	it("answers a baseline rewritten between its two statements with the bytes it read and their own date", async () => {
		const scope = await seed();
		await publish(scope, readBaseline("hq-app", "yes"));
		const newer = readBaseline("hq-app", "no", { observedAt: LATER });
		const unwatched = h.db();

		const racing = countStatements(async () => {
			await unwatched
				.updateTable("app_deployment_baselines")
				.set({
					source_gzip: newer.sourceGzip,
					source_bytes: newer.sourceBytes,
					source_digest: newer.sourceDigest,
					observed_at: LATER,
				})
				.execute();
		});
		expect(await readTargetFacts(scope, TARGET)).toMatchObject({
			observedAt: LATER,
			profileProperties: { "cc-fuzzy-search-enabled": "no" },
		});
		expect(racing.count()).toBe(2);

		/* The projection was kept under the bytes it read. */
		const next = countStatements();
		expect(await readTargetFacts(scope, TARGET)).toMatchObject({
			observedAt: LATER,
			profileProperties: { "cc-fuzzy-search-enabled": "no" },
		});
		expect(next.count()).toBe(1);
	});
});
