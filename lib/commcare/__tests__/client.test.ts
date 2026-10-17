import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readMultipartRequest,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import {
	replyRetained,
	retainedBodyText,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import {
	IMPORT_RETRY_MAX_WAIT_MS,
	importApp,
	importRetryWaitMs,
	isValidDomainSlug,
	testDomainAccess,
} from "../client";
import { retryAfterMs } from "../hq/http";

it("accepts HQ's legacy spelling only when it remains one exact URL path segment", async () => {
	const valid = [
		"myproject",
		"my-project",
		"my.project",
		"my:project",
		"my_project",
		"12345",
		"org.project_v2:staging",
		"a",
		"...",
	];
	await withHttpPeer(async (peer) => {
		for (const domain of valid) {
			expect(isValidDomainSlug(domain), domain).toBe(true);
			peer
				.get("https://india.commcarehq.org")
				.intercept({
					path: `/a/${domain}/apps/api/list_apps/`,
					method: "GET",
					headers: { authorization: "ApiKey account:key" },
				})
				.reply(200, { status: "success", applications: [] });
			expect(
				await testDomainAccess(
					{ username: "account", apiKey: "key", server: "india" },
					domain,
				),
			).toBe(true);
		}
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => new URL(call.fullUrl).pathname),
		).toEqual(valid.map((domain) => `/a/${domain}/apps/api/list_apps/`));
	});
});

it("rejects dot segments and URL syntax before an authenticated request", async () => {
	const invalid = [
		".",
		"..",
		"",
		"../etc/passwd",
		"domain/../../secret",
		"domain%2F..",
		"my project",
		"domain\n",
		"domain\0",
		"<script>",
		"domain?admin=true",
		"domain#fragment",
		"domain\\secret",
	];
	await withHttpPeer(async (peer) => {
		for (const domain of invalid) {
			expect(isValidDomainSlug(domain), JSON.stringify(domain)).toBe(false);
			expect(
				await testDomainAccess(
					{ username: "account", apiKey: "key", server: "india" },
					domain,
				),
			).toBe(false);
		}
		expect(peer.getCallHistory()?.calls()).toEqual([]);
	});
});

describe("importRetryWaitMs", () => {
	it("waits out HQ's own decimal Retry-After up to two seconds, and nothing else", () => {
		const second = retainedPublishRead("import-429-second").headers;
		const minute = retainedPublishRead("import-429-minute").headers;
		const header = (headers: Readonly<Record<string, string>>) =>
			Object.entries(headers).find(
				([name]) => name.toLowerCase() === "retry-after",
			)?.[1] ?? null;
		expect(importRetryWaitMs(header(second))).toBe(
			Math.ceil(Number(header(second)) * 1000),
		);
		expect(importRetryWaitMs(header(second))).toBeLessThanOrEqual(
			IMPORT_RETRY_MAX_WAIT_MS,
		);
		expect(importRetryWaitMs(header(minute))).toBeNull();
		expect(importRetryWaitMs(null)).toBeNull();
		expect(importRetryWaitMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
		expect(importRetryWaitMs("2")).toBe(2000);
	});
});

describe("retryAfterMs", () => {
	it("reads a count of seconds, decimal or padded, and no other form", () => {
		expect(retryAfterMs("30")).toBe(30_000);
		expect(retryAfterMs(" 1.2345 ")).toBe(1_235);
		expect(retryAfterMs("120")).toBe(120_000);
		expect(retryAfterMs(null)).toBeNull();
		expect(retryAfterMs("")).toBeNull();
		expect(retryAfterMs("-5")).toBeNull();
		expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
	});
});

describe("importApp under HQ's rate limit", () => {
	const CREDS = {
		username: "account",
		apiKey: "key",
		server: "india",
	} as const;
	const HOST = "https://india.commcarehq.org";
	const IMPORT = "/a/clinic/apps/api/import_app/";
	afterEach(() => vi.useRealTimers());

	/** Once the import's wait is scheduled beside its deadline, let it pass. */
	async function waitOutRetry() {
		await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2));
		await vi.advanceTimersByTimeAsync(IMPORT_RETRY_MAX_WAIT_MS);
	}

	it("sends the same import again after the short wait HQ names, at most twice", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			const bodies: string[] = [];
			const limited = retainedPublishRead("import-429-second");
			const intercept = () =>
				peer.get(HOST).intercept({ path: IMPORT, method: "POST" });
			const record = async (opts: { body?: unknown; headers?: unknown }) => {
				const form = await readMultipartRequest(opts);
				const file = form.get("app_file");
				bodies.push(file instanceof Blob ? await file.text() : "");
			};
			intercept().reply(async (opts) => {
				await record(opts);
				return {
					statusCode: limited.status,
					data: retainedBodyText(limited),
					responseOptions: { headers: { ...limited.headers } },
				};
			});
			intercept().reply(async (opts) => {
				await record(opts);
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, app_id: "app", version: 2 }),
				};
			});
			const pending = importApp(CREDS, "clinic", "Clinic", { a: 1 }, "app");
			await waitOutRetry();
			expect(await pending).toEqual({
				success: true,
				appId: "app",
				version: 2,
				warnings: [],
			});
			expect(bodies).toEqual(['{"a":1}', '{"a":1}']);
		});
	});

	it("refuses with HQ's 429 after a third, or on a wait it cannot take", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			const limited = retainedPublishRead("import-429-second");
			for (let i = 0; i < 3; i++)
				replyRetained(
					peer.get(HOST).intercept({ path: IMPORT, method: "POST" }),
					limited,
				);
			const pending = importApp(CREDS, "clinic", "Clinic", {}, "app");
			await waitOutRetry();
			await waitOutRetry();
			expect(await pending).toMatchObject({ success: false, status: 429 });

			replyRetained(
				peer.get(HOST).intercept({ path: IMPORT, method: "POST" }),
				retainedPublishRead("import-429-minute"),
			);
			expect(
				await importApp(CREDS, "clinic", "Clinic", {}, "app"),
			).toMatchObject({ success: false, status: 429 });
			expect(peer.getCallHistory()?.calls()).toHaveLength(4);
		});
	});
});
