import { it as baseIt, expect } from "vitest";
import {
	respondWithObject,
	withResponsesPeer,
} from "@/lib/agent/__tests__/responsesPeer";
import type { SubGenerationUsageMeter } from "@/lib/agent/modelRunContext";
import { MODEL_ROLES } from "@/lib/models";
import { DesignGenerationContext } from "../designGenerationContext";

let active:
	| {
			transport: typeof globalThis.fetch;
			nextReview: () => unknown;
			usage: Parameters<SubGenerationUsageMeter["track"]>[];
	  }
	| undefined;
export function reviewContext(args: {
	actor: string;
	project: string;
	run: string;
	session: string;
	nextReview: () => unknown;
}) {
	if (!active) throw new Error("The native reviewer peer is not running");
	active.nextReview = args.nextReview;
	const peer = active;
	return new DesignGenerationContext({
		apiKey: "synthetic-local-only",
		transport: peer.transport,
		userId: args.actor,
		projectId: args.project,
		runId: args.run,
		designSessionId: args.session,
		usagePhase: "design-review",
		meter: {
			track: (...entry) => {
				peer.usage.push(entry);
			},
		},
	});
}
export const it = baseIt.extend<{ reviewerPeer: undefined }>({
	reviewerPeer: [
		async ({ task: _task }, use) => {
			const requests: Array<Record<string, unknown>> = [];
			const errors: unknown[] = [];
			await withResponsesPeer(
				(request, response) => {
					const chunks: Buffer[] = [];
					request.on("data", (chunk: Buffer) => chunks.push(chunk));
					request.on("end", () => {
						try {
							if (
								!active ||
								request.method !== "POST" ||
								request.url !== "/v1/responses"
							)
								throw new Error("Unexpected reviewer request");
							requests.push(JSON.parse(Buffer.concat(chunks).toString()));
							respondWithObject(response, JSON.stringify(active.nextReview()));
						} catch (error) {
							errors.push(error);
							response.writeHead(400);
							response.end("Unexpected reviewer request");
						}
					});
				},
				async (_provider, transport) => {
					const peer = {
						transport,
						nextReview: (): unknown => {
							throw new Error("No reviewer output specified");
						},
						usage: [] as Parameters<SubGenerationUsageMeter["track"]>[],
					};
					active = peer;
					try {
						await use(undefined);
						expect(errors).toEqual([]);
						expect(peer.usage).toHaveLength(requests.length);
						for (const request of requests)
							expect(request).toMatchObject({
								model: MODEL_ROLES.designReviewer.modelId,
								stream: true,
								store: false,
								text: { format: { type: "json_schema", strict: true } },
							});
						for (const [usage, options] of peer.usage) {
							expect(usage).toMatchObject({
								inputTokens: 11,
								outputTokens: 7,
								cacheReadTokens: 3,
							});
							expect(options).toEqual({
								model: MODEL_ROLES.designReviewer.modelId,
								phase: "design-review",
							});
						}
					} finally {
						active = undefined;
					}
				},
			);
		},
		{ auto: true },
	],
});
