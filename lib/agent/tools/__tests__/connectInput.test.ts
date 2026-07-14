// Unit tests for `buildConnectConfig` — the connect-block merge + parse
// boundary shared by `updateForm` (partial patch against the existing
// config) and the creation tools (no existing config). The contract under
// test is the sub-config-scoped "omission keeps, null clears" law: an
// omitted sub-config passes through, an explicit null REMOVES it, a
// stated one overlays — with `id` as the one null-reads-as-not-supplied
// slot (it is the sub-config's cross-version identity; a cleared id would
// be silently re-minted by `enforceConnectIds`, an identity change).

import { describe, expect, it } from "vitest";
import type { ConnectConfig, XPathExpression } from "@/lib/domain";
import { buildConnectConfig } from "../shared/connectInput";

/** Marker "AST" for tests — identity is all the merge logic touches. */
const expr = (text: string): XPathExpression =>
	({ __test_expr: text }) as unknown as XPathExpression;

const parseExpr = (text: string): XPathExpression => expr(`parsed:${text}`);

function existingConfig(): ConnectConfig {
	return {
		learn_module: {
			id: "lm-1",
			name: "Lesson",
			description: "Content",
			time_estimate: 10,
		},
		assessment: { id: "as-1", user_score: expr("#form/score") },
		deliver_unit: {
			id: "du-1",
			name: "Visit",
			entity_id: expr("#form/site"),
			entity_name: expr("#form/site_name"),
		},
	};
}

describe("buildConnectConfig — edit path (existing config)", () => {
	it("null removes exactly the named sub-config; omitted ones pass through", () => {
		const existing = existingConfig();
		const merged = buildConnectConfig(
			{ assessment: null },
			existing,
			parseExpr,
		);
		expect(merged.assessment).toBeUndefined();
		expect("assessment" in merged).toBe(false);
		// Untouched sub-configs are the SAME objects, not rebuilt copies.
		expect(merged.learn_module).toBe(existing.learn_module);
		expect(merged.deliver_unit).toBe(existing.deliver_unit);
	});

	it("removing every sub-config yields an empty config for the caller to collapse", () => {
		const merged = buildConnectConfig(
			{ learn_module: null, assessment: null, deliver_unit: null, task: null },
			existingConfig(),
			parseExpr,
		);
		expect(Object.keys(merged)).toEqual([]);
	});

	it("null clears deliver_unit's entity slots back to the wire defaults", () => {
		const merged = buildConnectConfig(
			{ deliver_unit: { name: "Visit", entity_id: null } },
			existingConfig(),
			parseExpr,
		);
		expect("entity_id" in (merged.deliver_unit ?? {})).toBe(false);
		// An omitted inner slot keeps its stored expression.
		expect(merged.deliver_unit?.entity_name).toEqual(expr("#form/site_name"));
		expect(merged.deliver_unit?.id).toBe("du-1");
	});

	it("a null id keeps the existing id — identity is not clearable", () => {
		const merged = buildConnectConfig(
			{ deliver_unit: { name: "Renamed visit", id: null } },
			existingConfig(),
			parseExpr,
		);
		expect(merged.deliver_unit?.id).toBe("du-1");
		expect(merged.deliver_unit?.name).toBe("Renamed visit");
	});

	it("stated XPath slots cross the parse boundary", () => {
		const merged = buildConnectConfig(
			{ assessment: { user_score: "#form/final_score" } },
			existingConfig(),
			parseExpr,
		);
		expect(merged.assessment?.user_score).toEqual(
			expr("parsed:#form/final_score"),
		);
		expect(merged.assessment?.id).toBe("as-1");
	});
});

describe("buildConnectConfig — creation path (no existing config)", () => {
	it("null degrades to not-supplied — removal of nothing is a no-op", () => {
		const merged = buildConnectConfig(
			{ assessment: null, deliver_unit: { name: "Home visit" } },
			undefined,
			parseExpr,
		);
		expect("assessment" in merged).toBe(false);
		expect(merged.deliver_unit).toEqual({ name: "Home visit" });
	});
});
