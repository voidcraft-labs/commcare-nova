// Unit tests for `buildConnectConfig` — the connect-block structural merge
// boundary shared by `updateForm` (partial patch against the existing
// config) and the creation tools (no existing config). The contract under
// test is the sub-config-scoped "omission keeps, null clears" law: an
// omitted sub-config passes through, an explicit null REMOVES it, a
// stated one overlays — with `id` as the one null-reads-as-not-supplied
// slot (it is the sub-config's identity; a cleared id would be silently
// re-minted by `enforceConnectIds`, an identity change).

import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import type { ConnectDeliverConfig, ConnectLearnConfig } from "@/lib/domain";
import { connectConfigSchema } from "@/lib/domain";
import { connectFormPatchSchema } from "../../planningSchemas";
import { buildConnectConfig } from "../shared/connectInput";

function existingLearnConfig(): ConnectLearnConfig {
	return {
		learn_module: {
			id: "lm_1",
			name: "Lesson",
			description: "Content",
			time_estimate: 10,
		},
		assessment: { id: "as_1", user_score: xp("100") },
	};
}

function existingDeliverConfig(): ConnectDeliverConfig {
	return {
		deliver_unit: {
			id: "du_1",
			name: "Visit",
			entity_id: xp("'site-id'"),
			entity_name: xp("'Site name'"),
		},
	};
}

describe("buildConnectConfig — edit path (existing config)", () => {
	it("null removes exactly the named sub-config; omitted ones pass through", () => {
		const existing = existingLearnConfig();
		const before = structuredClone(existing);
		expect(connectConfigSchema.parse(existing)).toEqual(existing);
		const merged = buildConnectConfig({ assessment: null }, existing);
		expect(merged.assessment).toBeUndefined();
		expect("assessment" in merged).toBe(false);
		// Untouched sub-configs are the SAME objects, not rebuilt copies.
		expect(merged.learn_module).toBe(existing.learn_module);
		expect(existing).toEqual(before);
	});

	it("removing every sub-config yields an empty draft that the caller must reject", () => {
		const merged = buildConnectConfig(
			{ learn_module: null, assessment: null },
			existingLearnConfig(),
		);
		expect(Object.keys(merged)).toEqual([]);
	});

	it("null removes deliver_unit's entity slot while retaining its sibling", () => {
		const merged = buildConnectConfig(
			{ deliver_unit: { name: "Visit", entity_id: null } },
			existingDeliverConfig(),
		);
		expect("entity_id" in (merged.deliver_unit ?? {})).toBe(false);
		// An omitted inner slot keeps its stored expression.
		expect(merged.deliver_unit?.entity_name).toEqual(xp("'Site name'"));
		expect(merged.deliver_unit?.id).toBe("du_1");
	});

	it("a null id keeps the existing id — identity is not clearable", () => {
		const merged = buildConnectConfig(
			{ deliver_unit: { name: "Renamed visit", id: null } },
			existingDeliverConfig(),
		);
		expect(merged.deliver_unit?.id).toBe("du_1");
		expect(merged.deliver_unit?.name).toBe("Renamed visit");
	});

	it("stated XPath slots preserve their canonical AST after actual input parsing", () => {
		const score = xp("80");
		const merged = buildConnectConfig(
			connectFormPatchSchema.parse({ assessment: { user_score: score } }),
			existingLearnConfig(),
		);
		expect(merged.assessment?.user_score).toEqual(score);
		expect(connectConfigSchema.parse(merged)).toEqual(merged);
		expect(merged.assessment?.id).toBe("as_1");
	});
});

describe("buildConnectConfig — creation path (no existing config)", () => {
	it("null degrades to not-supplied — removal of nothing is a no-op", () => {
		const merged = buildConnectConfig(
			{ assessment: null, deliver_unit: { name: "Home visit" } },
			undefined,
		);
		expect("assessment" in merged).toBe(false);
		expect(merged.deliver_unit).toEqual({ name: "Home visit" });
	});

	it("uses a separate live config only as the omitted-id identity source", () => {
		const live = existingLearnConfig();
		const replacement = buildConnectConfig(
			{
				learn_module: {
					name: "Replacement content",
					description: "New description",
					time_estimate: 25,
				},
			},
			undefined,
			live,
		);
		expect(replacement).toEqual({
			learn_module: {
				id: "lm_1",
				name: "Replacement content",
				description: "New description",
				time_estimate: 25,
			},
		});
		expect(replacement).not.toHaveProperty("assessment");
	});
});
