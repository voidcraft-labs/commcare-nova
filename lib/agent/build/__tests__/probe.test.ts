import { describe, expect, it } from "vitest";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import { collectIdentitySchemaPointers } from "@/lib/agent/identityPointerRegistry";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { wireToolSchema } from "@/lib/agent/wireSchemas";

describe("probe", () => {
	it("classifies every change-set tool's compact projection", () => {
		const mcpBySa = new Map(
			SHARED_TOOL_REGISTRY.map((e) => [e.saName, e.mcpName]),
		);
		const failures: string[] = [];
		const families = new Map<string, Set<string>>();
		for (const [name, entry] of CHANGE_SET_TOOL_REGISTRY) {
			const json = wireToolSchema(entry.tool.inputSchema).jsonSchema;
			try {
				const pointers = collectIdentitySchemaPointers(
					mcpBySa.get(name) ?? name,
					json as Record<string, unknown>,
				);
				for (const p of pointers) {
					const set = families.get(p.family) ?? new Set();
					set.add(`${name}${p.schemaPointer}`);
					families.set(p.family, set);
				}
			} catch (e) {
				failures.push(`${name}: ${(e as Error).message}`);
			}
		}
		console.log("FAILURES", JSON.stringify(failures, null, 1));
		console.log(
			"FAMILIES",
			[...families].map(([f, s]) => `${f}=${s.size}`).join(" "),
		);
		expect(CHANGE_SET_TOOL_REGISTRY.size).toBeGreaterThan(0);
	});
});
