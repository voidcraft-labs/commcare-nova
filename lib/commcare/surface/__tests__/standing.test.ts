/**
 * The standing of a manifest entry and the cause of a `fix-in-hq` one.
 *
 * Contract: a standing follows the entry's disposition, and a REFUSED entry
 * is `never` where any reason is one a change in CommCare HQ does not lift
 * and `fix-in-hq` where every reason is one it lifts; the cause of a
 * `fix-in-hq` entry says whether CommCare HQ refuses the thing, the thing
 * breaks when the app runs, either, or the app is below the version floor.
 * The expected answers are written out here kind by kind, so a kind moved
 * from one list to the other, or a cause read from the wrong kind, fails by
 * name; a new reason kind with no answer here fails to compile.
 */

import { describe, expect, it } from "vitest";
import type { FixCause, ReadStanding } from "@/lib/publish/hqFindings";
import type {
	InventoryEntry,
	RefusalReason,
	RefusalReasonKind,
} from "../schema";
import { REFUSAL_REASON_KINDS } from "../schema";
import { fixCauseOf, standingOf } from "../standing";
import { loadManifest } from "./loadManifest";

const MANIFEST = loadManifest();

type Refused = Extract<InventoryEntry, { disposition: "REFUSED" }>;

function first<D extends InventoryEntry["disposition"]>(
	disposition: D,
): Extract<InventoryEntry, { disposition: D }> {
	const found = MANIFEST.inventory.find(
		(entry): entry is Extract<InventoryEntry, { disposition: D }> =>
			entry.disposition === disposition,
	);
	if (found === undefined)
		throw new Error(
			`The manifest holds no ${disposition} entry to plant a case on.`,
		);
	return found;
}

const REFUSED = first("REFUSED");

function reason(kind: RefusalReasonKind, condition?: string): RefusalReason {
	const limited = condition === undefined ? {} : { condition };
	return kind === "retiring"
		? {
				kind,
				gate: "toggle/SESSION_ENDPOINTS",
				named: "a planted flag",
				...limited,
			}
		: { kind, ...limited };
}

function refusedFor(...reasons: RefusalReason[]): Refused {
	return { ...REFUSED, id: `${REFUSED.area}/planted-refusal`, reasons };
}

/** Each reason kind alone on an entry: its standing and, for `fix-in-hq`, its cause. */
const BY_KIND: Record<
	RefusalReasonKind,
	{ readonly standing: ReadStanding; readonly cause: FixCause | null }
> = {
	retiring: { standing: "never", cause: null },
	freeform: { standing: "never", cause: null },
	untypeable: { standing: "never", cause: null },
	"unrepresentable-identity": { standing: "never", cause: null },
	"not-hq-editable": { standing: "fix-in-hq", cause: "hq-refuses" },
	"not-hq-buildable": { standing: "fix-in-hq", cause: "hq-refuses" },
	"broken-at-runtime": { standing: "fix-in-hq", cause: "breaks-when-run" },
	"unavailable-on-declared-platform": {
		standing: "fix-in-hq",
		cause: "breaks-when-run",
	},
	"below-commcare-version-floor": {
		standing: "fix-in-hq",
		cause: "below-floor",
	},
};

describe("standingOf", () => {
	it.each([
		["HELD", "held"],
		["TARGET-OWNED", "kept"],
		["INERT", "inert"],
		["HELD-NEW", "not-yet"],
	] as const)("reads a %s entry as %s", (disposition, standing) => {
		expect(standingOf(first(disposition))).toBe(standing);
	});

	it.each(REFUSAL_REASON_KINDS)(
		"reads a REFUSED entry whose one reason is %s by that kind's group",
		(kind) => {
			expect(standingOf(refusedFor(reason(kind)))).toBe(BY_KIND[kind].standing);
		},
	);

	it("reads a REFUSED entry holding a kind of each group as never", () => {
		const mixed = refusedFor(reason("not-hq-editable"), reason("retiring"));
		expect(standingOf(mixed)).toBe("never");
		expect(fixCauseOf(mixed)).toBeNull();
	});

	it.each([
		"forms-and-case-writes/form-links-target-any-other-module",
		"menus-and-case-lists/any-module-under-a-training-menu",
	])("reads %s, whose reasons mix the groups, as never", (id) => {
		const entry = MANIFEST.inventory.find((each) => each.id === id);
		expect(entry?.disposition).toBe("REFUSED");
		if (entry?.disposition !== "REFUSED") return;
		const kinds = new Set(entry.reasons.map((each) => each.kind));
		expect([...kinds].some((kind) => BY_KIND[kind].standing === "never")).toBe(
			true,
		);
		expect(
			[...kinds].some((kind) => BY_KIND[kind].standing === "fix-in-hq"),
		).toBe(true);
		expect(standingOf(entry)).toBe("never");
	});
});

describe("fixCauseOf", () => {
	it.each(REFUSAL_REASON_KINDS)(
		"gives the cause of a REFUSED entry whose one reason is %s",
		(kind) => {
			expect(fixCauseOf(refusedFor(reason(kind)))).toBe(BY_KIND[kind].cause);
		},
	);

	it("keeps one group's cause for several reasons of that group", () => {
		expect(
			fixCauseOf(
				refusedFor(reason("not-hq-editable"), reason("not-hq-buildable")),
			),
		).toBe("hq-refuses");
		expect(
			fixCauseOf(
				refusedFor(
					reason("broken-at-runtime"),
					reason("unavailable-on-declared-platform"),
				),
			),
		).toBe("breaks-when-run");
	});

	it("gives either for reasons of both groups, each limited by a condition", () => {
		const both = refusedFor(
			reason("not-hq-editable", "in a bind"),
			reason("broken-at-runtime", "in an output or setvalue"),
		);
		expect(standingOf(both)).toBe("fix-in-hq");
		expect(fixCauseOf(both)).toBe("either");
	});

	it("gives null for every entry of the manifest that is not fix-in-hq, and a cause for every one that is", () => {
		for (const entry of MANIFEST.inventory) {
			const cause = fixCauseOf(entry);
			if (standingOf(entry) === "fix-in-hq")
				expect(cause, entry.id).not.toBeNull();
			else expect(cause, entry.id).toBeNull();
		}
	});
});
