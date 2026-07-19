import { describe, expect, it } from "vitest";
import { literal, match, neq, prop, term } from "@/lib/domain/predicate";
import { currentVerbLabel } from "../cards/PredicateVerbMenu";
import { predicateCardSchemas } from "../editorSchemas";
import { predicateFocusTitle } from "../RuleFocusContext";

describe("predicate authoring labels", () => {
	it("uses the same friendly inequality contraction in menus and focus summaries", () => {
		const condition = neq(prop("patient", "status"), literal("closed"));

		expect(predicateCardSchemas.neq.label).toBe("Isn’t");
		expect(predicateFocusTitle(condition)).toBe("Isn’t");
	});

	it("reuses Search's outcome labels for forgiving matches", () => {
		expect(
			currentVerbLabel(
				match(prop("patient", "name"), term(literal("Ann")), "fuzzy"),
			),
		).toBe("Similar spelling");
		expect(
			currentVerbLabel(
				match(
					prop("patient", "visit_date"),
					term(literal("2026-07-17")),
					"fuzzy-date",
				),
			),
		).toBe("Flexible date");
		expect(predicateCardSchemas.match.description).toBe(
			"Match by similar spelling, the beginning of text, sound, or a flexible date",
		);
	});
});
