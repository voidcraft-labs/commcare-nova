import { describe, expect, it } from "vitest";
import { spellPredicateSelf } from "@/lib/commcare/xpath/selfSteps";

describe("spellPredicateSelf", () => {
	it("spells a one-step `.` inside a predicate as `./.`", () => {
		expect(
			spellPredicateSelf("count(/data/items/item/choice[. = 'yes'])"),
		).toBe("count(/data/items/item/choice[./. = 'yes'])");
		expect(
			spellPredicateSelf("count(/data/a[string-length(.) > 0][. != 'x'])"),
		).toBe("count(/data/a[string-length(./.) > 0][./. != 'x'])");
		expect(spellPredicateSelf("/data/a[b = /data/c[. = 'y']]")).toBe(
			"/data/a[b = /data/c[./. = 'y']]",
		);
	});

	it("leaves a `.` outside every predicate, and one step of a longer path, as written", () => {
		expect(spellPredicateSelf(". = 'yes'")).toBe(". = 'yes'");
		expect(spellPredicateSelf("/data/a[./b = 1]")).toBe("/data/a[./b = 1]");
		expect(spellPredicateSelf("/data/a[b/. = 1]")).toBe("/data/a[b/. = 1]");
		expect(spellPredicateSelf("/data/a[.. = 1]")).toBe("/data/a[.. = 1]");
		expect(spellPredicateSelf("/data/a[@x = 1.5]")).toBe("/data/a[@x = 1.5]");
		expect(spellPredicateSelf("/data/a['.' = .5]")).toBe("/data/a['.' = .5]");
	});

	it("is idempotent", () => {
		const once = spellPredicateSelf("count(/data/x[. = 'yes'])");
		expect(spellPredicateSelf(once)).toBe(once);
	});
});
