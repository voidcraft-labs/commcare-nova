/**
 * The definition/binding split: the tool definitions the anatomy renders
 * are the definitions the live agents mount.
 *
 * The design loop persists a toolset digest per context and rolls a session
 * to a new generation when it changes, so a definitions-only record that
 * digested differently from the mounted set would either misreport the
 * grammar or, worse, be trusted as the grammar while the live digest moved.
 * Each proof compares the definitions-only record against the bound set AND
 * against the digest captured on `main` before the split.
 */

import { describe, expect, it } from "vitest";
import { buildExecutorTools } from "@/lib/agent/build/executorLoop";
import {
	createDesignLoopTools,
	type DesignLoopToolDeps,
	designLoopToolDefinitions,
	designToolsetDigest,
} from "@/lib/agent/design/loop/tools";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { solutionsArchitectToolDefinitions } from "@/lib/agent/solutionsArchitect";
import { wireToolSchema } from "@/lib/agent/wireSchemas";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import fixture from "./fixtures/promptDigests.json";

/** `createDesignLoopTools` binds `execute` closures over its deps and reads
 * none of them until a tool runs, so a throwing proxy proves the mount is
 * definition-pure while yielding the exact bound record. */
const eagerDepsTrap = new Proxy({} as DesignLoopToolDeps, {
	get(_target, property) {
		throw new Error(
			`createDesignLoopTools read deps.${String(property)} at mount time.`,
		);
	},
});

describe("design loop tool definitions", () => {
	it("digest and order the 20 loop tools as the runner persists them", async () => {
		const definitions = designLoopToolDefinitions();
		expect(Object.keys(definitions)).toEqual(fixture.designToolOrder);
		expect(await designToolsetDigest(definitions)).toBe(
			fixture.designToolsetDigest,
		);
	});

	it("match the bound tools the agent mounts, key for key", async () => {
		const bound = createDesignLoopTools(eagerDepsTrap);
		const definitions = designLoopToolDefinitions();
		expect(Object.keys(bound)).toEqual(Object.keys(definitions));
		expect(await designToolsetDigest(bound)).toBe(
			await designToolsetDigest(definitions),
		);
		for (const name of Object.keys(definitions)) {
			expect(bound[name as keyof typeof bound]).toHaveProperty("execute");
		}
	});
});

describe("executor tool definitions", () => {
	it("digest and order the stable native registry as the attempt persists it", () => {
		const tools = buildExecutorTools();
		expect(Object.keys(tools)).toEqual(fixture.executorToolOrder);
		expect(canonicalJsonDigest(tools)).toBe(fixture.executorToolsetDigest);
	});
});

/** The chat wire projection is an SDK `Schema`, whose `jsonSchema` may
 * resolve lazily; the definition type widens it to `FlexibleSchema`. */
async function wireJsonSchema(schema: unknown): Promise<unknown> {
	if (
		typeof schema !== "object" ||
		schema === null ||
		!("jsonSchema" in schema)
	) {
		throw new Error("the definition's inputSchema is not a wire Schema");
	}
	return await (schema as { jsonSchema: unknown }).jsonSchema;
}

describe("Solutions Architect tool definitions", () => {
	it("list askQuestions first, then every shared tool in registry order, all strict: false", () => {
		const definitions = solutionsArchitectToolDefinitions();
		expect(Object.keys(definitions)).toEqual([
			"askQuestions",
			...SHARED_TOOL_REGISTRY.map((entry) => entry.saName),
		]);
		for (const definition of Object.values(definitions)) {
			expect(definition.strict).toBe(false);
		}
	});

	it("carry each shared tool's description and chat wire projection", async () => {
		const definitions = solutionsArchitectToolDefinitions();
		for (const entry of SHARED_TOOL_REGISTRY) {
			const definition = definitions[entry.saName];
			expect(definition, entry.saName).toBeDefined();
			expect(definition?.description).toBe(entry.tool.description);
			const expected = await wireToolSchema(
				entry.tool.inputSchema as Parameters<typeof wireToolSchema>[0],
			).jsonSchema;
			expect(
				await wireJsonSchema(definition?.inputSchema),
				entry.saName,
			).toEqual(expected);
		}
	});
});
