/**
 * fieldRegistry — invariant tests for the per-kind metadata table.
 *
 * `fieldRegistry` is the single source of truth for kind-keyed UI
 * affordances: the icon shown in the inspector header, the tooltip
 * label, the convertible-target list. Components read these without
 * fallbacks because the registry's shape is the contract — a missing
 * entry would render an empty span / break a tooltip silently. Walking
 * the registry once here catches a dropped entry the moment a new kind
 * lands.
 */

import { describe, expect, it } from "vitest";
import { fieldKinds, fieldRegistry } from "@/lib/domain";

describe("fieldRegistry", () => {
	it("ships an icon body for every registered kind", () => {
		// `<Icon body={...}>` renders the SVG fragment verbatim. An empty
		// body string would render an empty `<svg>` with no warning, so
		// the type guard is "non-empty string".
		for (const kind of fieldKinds) {
			const meta = fieldRegistry[kind];
			expect(meta.icon, `kind=${kind}`).toBeDefined();
			expect(typeof meta.icon.body, `kind=${kind}`).toBe("string");
			expect(meta.icon.body.length, `kind=${kind}`).toBeGreaterThan(0);
		}
	});

	it("ships a label for every registered kind", () => {
		// Tooltip + menu copy reads `meta.label` without a fallback; a
		// missing label would surface as a blank tooltip or invisible
		// menu item.
		for (const kind of fieldKinds) {
			const meta = fieldRegistry[kind];
			expect(meta.label, `kind=${kind}`).toBeTruthy();
		}
	});
});
