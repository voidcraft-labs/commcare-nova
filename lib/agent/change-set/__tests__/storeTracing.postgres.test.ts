import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";

const h = setupAppStateTestDb("authoring_store_trace_", {
	authSchema: "migrated",
});

// The child owns a 30-second timeout and is joined before execFile settles.
// Give its parent enough time to observe that failure before Vitest tears down the database.
it("exports fixed workspace operation names as parents of native database spans without work content", {
	timeout: 45_000,
}, async () => {
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[
			"--conditions=react-server",
			"--import",
			"tsx",
			"lib/agent/change-set/__tests__/fixtures/storeTracingProbe.mts",
		],
		{
			cwd: process.cwd(),
			env: { ...process.env, NOVA_DB_LOCAL_URL: h.uri() },
			timeout: 30_000,
		},
	);
	const line = stdout
		.split("\n")
		.find((value) => value.startsWith("SENTRY_STORE_PROBE="));
	if (!line) throw new Error("The child process produced no tracing evidence.");
	const batches = z
		.array(
			z.object({
				version: z.literal(2),
				items: z.array(
					z.object({
						name: z.string(),
						span_id: z.string(),
						parent_span_id: z.string().optional(),
						attributes: z.record(z.string(), z.object({ value: z.unknown() })),
					}),
				),
			}),
		)
		.parse(JSON.parse(line.slice("SENTRY_STORE_PROBE=".length)));
	const spans = batches.flatMap((batch) => batch.items);
	expect(spans.some((span) => span.name === "store tracing probe")).toBe(true);
	for (const name of [
		"loadChangeSet",
		"loadChangeSetSteps",
		"authorizeChangeSet",
		"stageChangeSetRequest",
	]) {
		const operation = spans.find(
			(span) => span.name === `authoring.store.${name}`,
		);
		expect(operation).toBeDefined();
		expect(operation?.attributes).toMatchObject({
			"code.file.path": { value: "lib/agent/change-set/store.ts" },
			"code.function.name": { value: name },
		});
		const children = spans.filter(
			(span) => span.parent_span_id === operation?.span_id,
		);
		expect(children.length).toBeGreaterThan(0);
		if (name === "loadChangeSet" || name === "loadChangeSetSteps")
			expect(
				children.some(
					(span) =>
						span.attributes["sentry.origin"]?.value === "auto.db.postgres",
				),
			).toBe(true);
	}
	expect(line).not.toContain("sensitive-");
	expect(line).not.toContain("00000000-0000-4000-8000-000000000042");
});
