import * as Sentry from "@sentry/node";
import { serverDataCollection } from "../../../../../sentry.dataCollection";

const events: unknown[] = [];
const client = Sentry.initWithoutDefaultIntegrations({
	dsn: "https://public@example.invalid/1",
	tracesSampleRate: 1,
	dataCollection: serverDataCollection,
	integrations: [
		Sentry.postgresIntegration(),
		Sentry.spanStreamingIntegration(),
	],
	transport: () => ({
		send: async (envelope) => {
			for (const [header, payload] of envelope[1]) {
				if (header.type === "transaction" || header.type === "span")
					events.push(payload as Event);
			}
			return { statusCode: 200 };
		},
		flush: async () => true,
	}),
});
const {
	loadChangeSet,
	loadChangeSetSteps,
	authorizeChangeSet,
	stageChangeSetRequest,
} = await import("../../store");
const { closeCaseStoreDatabase } = await import(
	"../../../../case-store/postgres/connection"
);
try {
	await Sentry.startSpan(
		{ name: "store tracing probe", forceTransaction: true },
		async () => {
			await loadChangeSet("00000000-0000-4000-8000-000000000042");
			await loadChangeSetSteps("00000000-0000-4000-8000-000000000042");
			try {
				await authorizeChangeSet({
					changeSetId: "00000000-0000-4000-8000-000000000042",
					actorUserId: "sensitive-actor-identity",
					runId: "sensitive-run-identity",
				});
				throw new Error(
					"An absent workspace unexpectedly passed authorization.",
				);
			} catch (error) {
				if (
					!(error instanceof Error) ||
					error.message !== "This private candidate is unavailable."
				)
					throw error;
			}
			try {
				await stageChangeSetRequest({
					changeSetId: "00000000-0000-4000-8000-000000000042",
					actorUserId: "sensitive-actor-identity",
					runId: "sensitive-run-identity",
					requestId: "sensitive-request-identity",
					inputDigest: "sensitive-input-digest",
					toolName: "edit_field",
					expectedRevision: 0,
					outcome: {
						kind: "reject",
						code: "TARGET_INVALID",
						message: "sensitive-work-content",
					},
				});
				throw new Error("An absent workspace unexpectedly staged a request.");
			} catch (error) {
				if (
					!(error instanceof Error) ||
					error.message !== "This change set no longer exists."
				)
					throw error;
			}
		},
	);
	await client?.flush();
	process.stdout.write(`SENTRY_STORE_PROBE=${JSON.stringify(events)}\n`);
} finally {
	await closeCaseStoreDatabase();
	await client?.close();
}
