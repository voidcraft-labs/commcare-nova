/**
 * The credential order and the deployment classes over CommCare HQ's own
 * answers: the refusals, the deleted and linked apps, the module HQ cannot
 * read and the 429 the lane retained under `proof/hq-reads/cutover/answers/`
 * and `proof/hq-reads/publish/`, served to the real readers through a peer
 * that answers each member's key on its own.
 */

import type { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	type RetainedPublishRead,
	replyRetained,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import {
	classifyDeployment,
	type DeploymentReads,
	HqReadPacer,
	readDeployment,
} from "../hqRead";
import type { DecryptClock } from "../kmsDecrypt";
import { deploymentNotices } from "../notice";
import { readRawDocument } from "../oldShape";
import { questionPaths } from "../questionPaths";
import {
	migratedFixtureDocument,
	readFixtureCarriers,
} from "./fixtures/preStep";
import {
	FORM_IDS_PATH,
	PEER_APP,
	PEER_DOMAIN,
	PEER_HOST,
	retainedCutoverRead,
	SOURCE_PATH,
} from "./fixtures/retainedCutoverReads";

const DOCUMENT = "navigation-base";
const today = questionPaths(
	readRawDocument(DOCUMENT, readFixtureCarriers(DOCUMENT)),
);
const target = migratedFixtureDocument(DOCUMENT);

const credentialsOf = (userId: string): CommCareCredentials => ({
	username: `${userId}@example.org`,
	apiKey: `key-${userId}`,
	server: "production",
});

/** A clock whose waits pass at once. */
function ownedClock(): DecryptClock {
	let now = Date.parse("2026-10-15T10:00:00.000Z");
	return {
		now: () => now,
		sleep: async (milliseconds) => {
			now += milliseconds;
		},
	};
}

function answer(
	peer: MockAgent,
	path: string,
	userId: string,
	retained: RetainedHqAnswer,
) {
	replyRetained(
		peer.get(PEER_HOST).intercept({
			path,
			method: "GET",
			headers: { authorization: `ApiKey ${userId}@example.org:key-${userId}` },
		}),
		retained,
	);
}

const cutoverAnswer = (name: string) =>
	retainedCutoverRead("answers", `${name}.json`);
const sourceRead = () =>
	retainedCutoverRead(DOCUMENT, "after-create", "app-source.json");
const formIdRead = () =>
	retainedCutoverRead(DOCUMENT, "after-create", "application.json");

async function readAs(credentials: string[]): Promise<DeploymentReads> {
	const clock = ownedClock();
	return readDeployment(
		{ server: "production", domain: PEER_DOMAIN, remoteAppId: PEER_APP },
		{
			credentials,
			credentialSource: async (userId) => credentialsOf(userId),
			pacer: new HqReadPacer(clock),
			clock,
		},
	);
}

function classed(reads: DeploymentReads) {
	return classifyDeployment({
		reads,
		today,
		published: { kind: "document", source: "stored", menus: today },
		transientAsUnreadable: false,
	});
}

describe("the credential order over HQ's refusals", () => {
	it.each([
		["source-wrong-key", 401],
		["source-not-a-member", 403],
		["source-no-edit-apps", 403],
	])(
		"moves the source read past %s to the next member, and leaves the form id read with the first",
		async (name, status) => {
			const retained = cutoverAnswer(name);
			expect(retained.status).toBe(status);
			await withHttpPeer(async (peer) => {
				answer(peer, SOURCE_PATH, "member-a", retained);
				answer(peer, SOURCE_PATH, "member-b", sourceRead());
				answer(peer, FORM_IDS_PATH, "member-a", formIdRead());
				const reads = await readAs(["member-a", "member-b"]);
				expect(classed(reads).outcome).toBe("read-in-full");
				expect(reads.keyUses.map((use) => use.userId)).toEqual([
					"member-a",
					"member-b",
				]);
			});
		},
	);

	it.each([
		"application-wrong-key",
		"application-not-a-member",
		"application-no-access-api-permission",
		"application-no-api-access",
		"application-cutoff",
	])("moves the form id read past %s to the next member", async (name) => {
		await withHttpPeer(async (peer) => {
			answer(peer, SOURCE_PATH, "member-a", sourceRead());
			answer(peer, FORM_IDS_PATH, "member-a", cutoverAnswer(name));
			answer(peer, FORM_IDS_PATH, "member-b", formIdRead());
			const reads = await readAs(["member-a", "member-b"]);
			expect(classed(reads).outcome).toBe("read-in-full");
		});
	});

	it("classes a deployment every member's key was refused for as unreadable", async () => {
		await withHttpPeer(async (peer) => {
			answer(peer, SOURCE_PATH, "member-a", cutoverAnswer("source-wrong-key"));
			answer(
				peer,
				SOURCE_PATH,
				"member-b",
				cutoverAnswer("source-not-a-member"),
			);
			const reads = await readAs(["member-a", "member-b"]);
			const result = classed(reads);
			expect(result.outcome).toBe("unreadable");
			expect(deploymentNotices(result, target).map((n) => n.reason)).toEqual([
				"ids-change-once-unreadable",
				"data-paths-move-once",
				"settings-unknown-unreadable",
			]);
		});
	});
});

describe("the deployment classes over HQ's answers", () => {
	it.each([
		["source-deleted", "deleted", ["hq-app-deleted"]],
		["source-missing", "deleted", ["hq-app-deleted"]],
		["source-linked", "unsupported", ["hq-app-not-nova-made"]],
	] as const)(
		"classes the retained %s source as %s",
		async (name, outcome, notices) => {
			await withHttpPeer(async (peer) => {
				answer(
					peer,
					SOURCE_PATH,
					"member-a",
					retainedPublishRead(name as RetainedPublishRead),
				);
				const reads = await readAs(["member-a"]);
				const result = classed(reads);
				expect(result.outcome).toBe(outcome);
				expect(result.identities).toEqual([]);
				expect(deploymentNotices(result, target).map((n) => n.reason)).toEqual(
					notices,
				);
			});
		},
	);

	it.each([
		"application-no-api-access",
		"application-cutoff",
		"application-no-access-api-permission",
		"application-deleted",
		"application-missing",
	])(
		"classes a readable source beside the form id answer %s as no-form-ids",
		async (name) => {
			await withHttpPeer(async (peer) => {
				answer(peer, SOURCE_PATH, "member-a", sourceRead());
				answer(peer, FORM_IDS_PATH, "member-a", cutoverAnswer(name));
				const reads = await readAs(["member-a"]);
				const result = classed(reads);
				expect(result.outcome).toBe("no-form-ids");
				expect(result.formIdsUnknown).toHaveLength(
					today.reduce((sum, menu) => sum + menu.forms.length, 0),
				);
				expect(
					result.identities.every(
						(row) => row.remoteUniqueId === null || row.entityKind === "module",
					),
				).toBe(true);
				expect(
					deploymentNotices(result, target).map((n) => n.reason),
				).toContain("form-ids-change-once");
			});
		},
	);

	it("reads a module HQ cannot read as one whose forms align with nothing", async () => {
		await withHttpPeer(async (peer) => {
			answer(
				peer,
				FORM_IDS_PATH,
				"member-a",
				cutoverAnswer("application-module-error"),
			);
			answer(peer, SOURCE_PATH, "member-a", sourceRead());
			const reads = await readAs(["member-a"]);
			expect(reads.formIds?.kind).toBe("ok");
			if (reads.formIds?.kind !== "ok") return;
			expect(
				reads.formIds.value.some((module) => module.kind === "error"),
			).toBe(true);
		});
	});

	it("reads the linked app's form ids as HQ answers them", async () => {
		await withHttpPeer(async (peer) => {
			answer(peer, SOURCE_PATH, "member-a", sourceRead());
			answer(
				peer,
				FORM_IDS_PATH,
				"member-a",
				cutoverAnswer("application-linked"),
			);
			const reads = await readAs(["member-a"]);
			expect(reads.formIds?.kind).toBe("ok");
		});
	});

	it("classes HQ's 429, which carries no Retry-After, as transient after three attempts, never an edge refusal", async () => {
		const limited = cutoverAnswer("application-429");
		expect(limited.status).toBe(429);
		expect(
			Object.keys(limited.headers).map((key) => key.toLowerCase()),
		).not.toContain("retry-after");
		await withHttpPeer(async (peer) => {
			answer(peer, SOURCE_PATH, "member-a", sourceRead());
			for (let attempt = 0; attempt < 3; attempt++) {
				answer(peer, FORM_IDS_PATH, "member-a", limited);
			}
			const reads = await readAs(["member-a"]);
			expect(reads.formIds).toEqual({ kind: "transient", cause: "429" });
			expect(classed(reads).outcome).toBe("transient");
		});
	});
});
