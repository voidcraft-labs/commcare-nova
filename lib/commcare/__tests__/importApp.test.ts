/** Native fetch and multipart decoding against the real HQ import contract.
 * HQ's app_import_api.py returns literal success, an app id, optional warnings,
 * and the updated version. The persisted publish consequences live in the MCP
 * Postgres suite; this file owns response and request protocol edge cases. */
import { afterEach, expect, it, vi } from "vitest";
import {
	readMultipartRequest,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { importApp } from "../client";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const HOST = "https://india.commcarehq.org",
	PATH = "/a/clinic/apps/api/import_app/";
const APP = { doc_type: "Application", name: "Visits" };
const AUTH = { authorization: "ApiKey account:fixture-key" };
const RATE_LIMITED = {
	statusCode: 429,
	data: "",
	responseOptions: { headers: { "retry-after": "0.9505331516265869" } },
};

afterEach(() => vi.useRealTimers());

it("sends create and update multipart bytes, preserving the explicit name, mapped id and returned warnings/version", async () => {
	await withHttpPeer(async (peer) => {
		for (const update of [false, true]) {
			const uploads: FormData[] = [];
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "POST", headers: AUTH })
				.reply(async (request) => {
					uploads.push(await readMultipartRequest(request));
					return {
						statusCode: update ? 200 : 201,
						data: JSON.stringify({
							success: true,
							app_id: "working-app",
							...(update ? { version: 7 } : {}),
							warnings: ["Unknown multimedia path"],
						}),
					};
				});
			expect(
				await importApp(
					CREDS,
					"clinic",
					"Visits & follow-up",
					APP,
					update ? "working-app" : undefined,
				),
			).toEqual({
				success: true,
				appId: "working-app",
				version: update ? 7 : null,
				warnings: ["Unknown multimedia path"],
			});
			expect(uploads).toHaveLength(1);
			const form = uploads[0];
			expect([...form.keys()]).toEqual([
				"waf_padding",
				"app_name",
				...(update ? ["app_id"] : []),
				"app_file",
			]);
			expect(String(form.get("waf_padding")).length).toBeGreaterThanOrEqual(
				8192,
			);
			expect(form.get("app_name")).toBe("Visits & follow-up");
			expect(form.get("app_id")).toBe(update ? "working-app" : null);
			const file = form.get("app_file");
			if (!(file instanceof Blob)) throw new Error("Expected app file");
			expect(file.type).toBe("application/json");
			expect(JSON.parse(await file.text())).toEqual(APP);
		}
	});
});

it.each(
	[
		{ name: "null envelope", data: null },
		{ name: "array envelope", data: [] },
		{ name: "missing verdict", data: {} },
		{
			name: "truthy non-boolean verdict",
			data: { success: "false", app_id: "working-app" },
		},
		{ name: "missing app id", data: { success: true } },
		{ name: "blank app id", data: { success: true, app_id: "" } },
		{ name: "unroutable app id", data: { success: true, app_id: "../other" } },
		{
			name: "wrong update id",
			data: { success: true, app_id: "other-app" },
			update: true,
		},
		{
			name: "invalid version",
			data: { success: true, app_id: "working-app", version: 1.5 },
		},
		{
			name: "non-array warnings",
			data: {
				success: true,
				app_id: "working-app",
				warnings: "private diagnostic",
			},
		},
		{
			name: "non-text warning",
			data: { success: true, app_id: "working-app", warnings: [{}] },
		},
	].map((row) => ({ ...row, update: "update" in row && row.update })),
)(
	"refuses an unusable import acknowledgement: $name",
	async ({ data, update }) => {
		await withHttpPeer(async (peer) => {
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "POST" })
				.reply(200, JSON.stringify(data));
			expect(
				await importApp(
					CREDS,
					"clinic",
					"Visits",
					APP,
					update ? "working-app" : undefined,
				),
			).toEqual({ success: false, status: 502 });
		});
	},
);

it("keeps HQ's explicit application rejection distinct from a malformed or lost response", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: PATH, method: "POST" })
			.reply(200, { success: false, error: "Invalid source" });
		peer
			.get(HOST)
			.intercept({ path: PATH, method: "POST" })
			.reply(200, "<html>Sign in</html>");
		peer
			.get(HOST)
			.intercept({ path: PATH, method: "POST" })
			.replyWithError(new Error("connection lost"));
		for (const status of [422, 502, 503])
			expect(await importApp(CREDS, "clinic", "Visits", APP)).toEqual({
				success: false,
				status,
			});
	});
});

it("distinguishes a missing mapped app, an HQ permission refusal and an edge refusal without following redirects", async () => {
	await withHttpPeer(async (peer) => {
		for (const [status, text] of [
			[404, "Application not found"],
			[403, "CommCare HQ permission refused"],
			[403, "<html><title>403 Forbidden</title></html>"],
			[302, "Moved"],
		] as const)
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "POST" })
				.reply(status, text, {
					headers: { location: "https://redirected.invalid/" },
				});
		for (const [status, edgeRefusal] of [
			[404, false],
			[403, false],
			[403, true],
			[302, false],
		] as const)
			expect(
				await importApp(CREDS, "clinic", "Visits", APP, "working-app"),
			).toEqual({ success: false, status, edgeRefusal });
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(4).fill(HOST + PATH));
	});
});

it("rejects unroutable target identifiers before sending bytes", async () => {
	await withHttpPeer(async (peer) => {
		expect(await importApp(CREDS, "../outside", "Visits", APP)).toEqual({
			success: false,
			status: 400,
		});
		expect(
			await importApp(CREDS, "clinic", "Visits", APP, "../outside"),
		).toEqual({ success: false, status: 400 });
		expect(peer.getCallHistory()?.calls()).toEqual([]);
	});
});

it("answers HQ's 429 without a resend when the wait would outlast the import's deadline", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: PATH, method: "POST" })
			.reply(() => {
				/* The answer arrives with half a second of the deadline left. */
				vi.setSystemTime(Date.now() + 59_500);
				return RATE_LIMITED;
			});
		expect(await importApp(CREDS, "clinic", "Visits", APP)).toEqual({
			success: false,
			status: 429,
			edgeRefusal: false,
			retryAfterMs: 951,
		});
		expect(peer.getCallHistory()?.calls()).toHaveLength(1);
	});
});

it("sends nothing more when the deadline ends the wait, and answers HQ's 429", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await withHttpPeer(async (peer) => {
		const sent = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<void>();
		peer
			.get(HOST)
			.intercept({ path: PATH, method: "POST" })
			.reply(async () => {
				sent.resolve();
				await answer.promise;
				return RATE_LIMITED;
			});
		const pending = importApp(CREDS, "clinic", "Visits", APP);
		try {
			await sent.promise;
			/* The deadline's timer runs on, while the wall clock it was set
			 * from has barely moved, so the wait is begun and the deadline
			 * falls inside it. */
			await vi.advanceTimersByTimeAsync(59_500);
			answer.resolve();
			await vi.advanceTimersByTimeAsync(600);
			expect(await pending).toEqual({
				success: false,
				status: 429,
				edgeRefusal: false,
				retryAfterMs: 951,
			});
		} finally {
			answer.resolve();
			await pending.catch(() => undefined);
		}
		expect(peer.getCallHistory()?.calls()).toHaveLength(1);
	});
});
