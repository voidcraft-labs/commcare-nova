import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	__resetAttachmentCoordinatorForTests,
	discardAttachment,
	retargetAttachment,
	stageAttachment,
} from "../attachmentClient";

const nativeFetch = globalThis.fetch;
const nativeSetTimeout = globalThis.setTimeout;
const base = "http://attachments.test";
const file = new File([new Uint8Array([0, 127, 255])], "photo é.png", {
	type: "image/png",
});
const args = {
	appId: "app/name",
	entryKey: "entry",
	fieldUuid: "field",
	instancePath: "/data/photo",
	file,
};
const initiation = {
	attachmentId: "attachment/name",
	attachmentName: "stored.png",
	uploadUrl: `${base}/storage`,
	uploadContentType: "image/png",
	uploadHeaders: { "x-goog-if-generation-match": "0" },
};
const confirmed = {
	attachmentId: "attachment/name",
	attachmentName: "stored.png",
	originalFilename: file.name,
	sizeBytes: 3,
};
type RequestRecord = {
	method: string;
	path: string;
	contentType?: string;
	generation?: string | string[];
	bytes: Buffer;
};
type Reply = { status?: number; body?: unknown; stall?: boolean };
type Phase = "initiate" | "put" | "confirm" | "retarget" | "delete";
function targets(phase: Phase, request: RequestRecord): boolean {
	return phase === "initiate"
		? request.path.endsWith("/attachments")
		: phase === "put"
			? request.path === "/storage"
			: phase === "confirm"
				? request.method === "POST" && !request.path.endsWith("/attachments")
				: phase === "retarget"
					? request.method === "PATCH"
					: request.method === "DELETE";
}
function operate(phase: Phase, signal?: AbortSignal) {
	return phase === "retarget"
		? retargetAttachment({
				appId: args.appId,
				attachmentId: confirmed.attachmentId,
				expectedInstancePath: "/data/photo",
				instancePath: "/data/evidence",
				signal,
			})
		: phase === "delete"
			? discardAttachment({
					appId: args.appId,
					attachmentId: confirmed.attachmentId,
					signal,
				})
			: stageAttachment({ ...args, signal });
}

async function withAttachmentHttp(
	reply: (request: RequestRecord) => Reply,
	run: (
		requests: RequestRecord[],
		stalled: Promise<ServerResponse | undefined>,
	) => Promise<void>,
) {
	const requests: RequestRecord[] = [];
	const handlers: Promise<void>[] = [];
	const responses: ServerResponse[] = [];
	const stalled = Promise.withResolvers<ServerResponse | undefined>();
	await withSocketHttpPeer(
		"attachments.test",
		(request, response) => {
			responses.push(response);
			const handler = (async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of request) chunks.push(Buffer.from(chunk));
				const record = {
					method: request.method ?? "",
					path: request.url ?? "",
					contentType: request.headers["content-type"],
					generation: request.headers["x-goog-if-generation-match"],
					bytes: Buffer.concat(chunks),
				};
				requests.push(record);
				const result = reply(record);
				response.writeHead(result.status ?? 200, {
					"Content-Type": "application/json",
				});
				if (result.stall) {
					response.write(" ");
					stalled.resolve(response);
				} else
					response.end(
						result.body === undefined ? "" : JSON.stringify(result.body),
					);
			})();
			handlers.push(handler);
		},
		async () => {
			vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
				nativeFetch(new URL(String(input), base), init),
			);
			try {
				await run(requests, stalled.promise);
			} finally {
				await __resetAttachmentCoordinatorForTests();
				for (const response of responses) response.destroy();
				await Promise.all(handlers);
				stalled.resolve(undefined);
				vi.unstubAllGlobals();
				vi.useRealTimers();
			}
		},
	);
}

function defaultReply(request: RequestRecord): Reply {
	if (request.path === "/api/apps/app%2Fname/attachments")
		return { body: initiation };
	if (request.path === "/storage") return {};
	if (request.method === "DELETE") return { status: 204 };
	if (request.method === "PATCH")
		return { body: { instancePath: "/data/evidence" } };
	return { body: confirmed };
}

describe("attachment HTTP transport", () => {
	it.each([200, 412])(
		"sends actual file bytes and create-only headers, then confirms after PUT %s",
		async (putStatus) => {
			await withAttachmentHttp(
				(request) =>
					request.path === "/storage"
						? { status: putStatus }
						: defaultReply(request),
				async (requests) => {
					expect(await stageAttachment(args)).toEqual(confirmed);
					expect(
						requests.map(({ method, path }) => ({ method, path })),
					).toEqual([
						{ method: "POST", path: "/api/apps/app%2Fname/attachments" },
						{ method: "PUT", path: "/storage" },
						{
							method: "POST",
							path: "/api/apps/app%2Fname/attachments/attachment%2Fname",
						},
					]);
					expect(JSON.parse(requests[0].bytes.toString())).toEqual({
						entryKey: "entry",
						fieldUuid: "field",
						instancePath: "/data/photo",
						filename: file.name,
						sizeBytes: 3,
					});
					expect(requests[1]).toMatchObject({
						contentType: "image/png",
						generation: "0",
						bytes: Buffer.from([0, 127, 255]),
					});
					expect(requests[2].bytes.length).toBe(0);
				},
			);
		},
	);
	it("rejects the failed upload while its compensating DELETE is still open", async () => {
		await withAttachmentHttp(
			(request) =>
				request.path === "/storage"
					? { status: 500 }
					: request.method === "DELETE"
						? { stall: true }
						: defaultReply(request),
			async (requests, stalled) => {
				await expect(stageAttachment(args)).rejects.toThrow(
					"The upload didn't finish",
				);
				await stalled;
				expect(requests.map(({ method }) => method)).toEqual([
					"POST",
					"PUT",
					"DELETE",
				]);
				expect(requests[2].path).toBe(
					"/api/apps/app%2Fname/attachments/attachment%2Fname",
				);
			},
		);
	});
	it("uses the server's returned path after a compare-and-swap disagreement", async () => {
		await withAttachmentHttp(
			() => ({ body: { instancePath: "/data/server-path" } }),
			async (requests) => {
				expect(
					await retargetAttachment({
						appId: args.appId,
						attachmentId: confirmed.attachmentId,
						expectedInstancePath: "/data/photo",
						instancePath: "/data/evidence",
					}),
				).toBe("/data/server-path");
				expect(requests[0]).toMatchObject({
					method: "PATCH",
					path: "/api/apps/app%2Fname/attachments/attachment%2Fname",
				});
				expect(JSON.parse(requests[0].bytes.toString())).toEqual({
					expectedInstancePath: "/data/photo",
					instancePath: "/data/evidence",
				});
			},
		);
	});
	it.each(["initiate", "put", "confirm", "retarget", "delete"] as const)(
		"cancels a stalled %s response body and closes its socket",
		async (phase) => {
			const controller = new AbortController();
			await withAttachmentHttp(
				(request) => {
					return targets(phase, request)
						? { stall: true }
						: defaultReply(request);
				},
				async (_requests, stalled) => {
					const task = operate(phase, controller.signal);
					const rejected = expect(task).rejects.toMatchObject({
						name: "AbortError",
					});
					try {
						const response = await stalled;
						if (!response) throw new Error("Expected stalled response");
						const closed = new Promise<void>((resolve) =>
							response.once("close", resolve),
						);
						controller.abort(new DOMException("Entry retired", "AbortError"));
						await rejected;
						await closed;
					} finally {
						controller.abort();
						await rejected;
					}
				},
			);
		},
	);
	it.each(
		(["initiate", "put", "confirm", "retarget", "delete"] as const).flatMap(
			(phase) => [200, 409].map((status) => ({ phase, status })),
		),
	)(
		"keeps the deadline active through the $phase HTTP $status body",
		async ({ phase, status }) => {
			const controller = new AbortController();
			await withAttachmentHttp(
				(request) =>
					targets(phase, request)
						? { status, stall: true }
						: defaultReply(request),
				async (_requests, stalled) => {
					const deadlines: Array<{
						id: ReturnType<typeof setTimeout>;
						fire: () => void;
					}> = [];
					vi.spyOn(globalThis, "setTimeout").mockImplementation(
						(callback, delay, ...values) => {
							const id = nativeSetTimeout(callback, delay, ...values);
							if (delay === 30_000)
								deadlines.push({ id, fire: () => callback(...values) });
							return id;
						},
					);
					const clear = vi.spyOn(globalThis, "clearTimeout");
					const task = operate(phase, controller.signal);
					const rejected = expect(task).rejects.toThrow(/timed out/i);
					try {
						const response = await stalled;
						if (!response) throw new Error("Expected stalled response");
						const closed = new Promise<void>((resolve) =>
							response.once("close", resolve),
						);
						const deadline = deadlines.at(-1);
						if (!deadline) throw new Error("Expected foreground deadline");
						deadline.fire();
						await rejected;
						await closed;
						expect(clear).toHaveBeenCalledWith(deadline.id);
					} finally {
						controller.abort();
						await Promise.allSettled([task]);
						vi.restoreAllMocks();
					}
				},
			);
		},
	);
});
