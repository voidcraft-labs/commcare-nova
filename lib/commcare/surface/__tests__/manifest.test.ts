/**
 * The manifest against the generated surface (plan work item 7, decision 7).
 *
 * Contract: every entries file parses with the manifest schema, and what the
 * entries name exists: each surface key an inventory or gate entry names is
 * an item of the surface (the generated `surface.json` with the authored
 * `media-formats.json` beside it), each gate entry's symbols are held by
 * their items, and each gate an entry links is a gate entry: an inventory
 * entry's `gates` and retiring reasons, and a gate entry's own links to other
 * gates (a removed toggle's `class.gate`, a preflight's `requires`). No two
 * inventory entries claim one surface key at one value class, no REFUSED
 * entry without a value class shares a key with another entry, and every
 * inventory entry names a surface key or says why it cannot (`noSurfaceKey`),
 * never both. The manifest check holds Nova's exports to these entries
 * (`proof/checks/manifest_usage.py`), so a dangling key silently stops
 * holding a use, two entries claiming one key at one value class give that
 * class two dispositions, a REFUSED entry without a value class refuses every
 * use of its keys and so leaves every other entry naming one of them dead,
 * and an entry with neither keys nor a reason is one the check can never
 * consult.
 *
 * Each rule is read by one function over the manifest's files, which the real
 * manifest passes; each rule then has a failing case planted into the real
 * manifest beside it, so a rule that stops reading its field fails here.
 * The test also prints the coverage number the plan names, "N of M entries
 * held": the inventory entries whose disposition is HELD (a Nova slot holds
 * them today) of all inventory entries.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type GateEntry,
	gateEntriesFileSchema,
	INVENTORY_AREAS,
	type InventoryEntry,
	inventoryEntriesFileSchema,
} from "../schema";

const SURFACE_DIR = join(process.cwd(), "lib/commcare/surface");

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(join(SURFACE_DIR, path), "utf8"));
}

type Item = Readonly<Record<string, unknown>>;

interface Manifest {
	readonly inventory: readonly InventoryEntry[];
	readonly gates: readonly GateEntry[];
	/** Every surface item by key: the generated surface and the authored media formats. */
	readonly items: ReadonlyMap<string, Item>;
}

function loadManifest(): Manifest {
	const surface = readJson("surface.json") as {
		items: Readonly<Record<string, Item>>;
	};
	const media = readJson("media-formats.json") as {
		items: Readonly<Record<string, Item>>;
	};
	return {
		inventory: INVENTORY_AREAS.flatMap((area) =>
			inventoryEntriesFileSchema.parse(readJson(`entries/${area}.json`)),
		),
		gates: gateEntriesFileSchema.parse(readJson("entries/gates.json")),
		items: new Map([
			...Object.entries(surface.items),
			...Object.entries(media.items),
		]),
	};
}

/** The gates an inventory entry links: its own and its retiring reasons'. */
function linkedGates(entry: InventoryEntry): string[] {
	const retiring =
		entry.disposition === "REFUSED"
			? entry.reasons.flatMap((reason) =>
					reason.kind === "retiring" ? [reason.gate] : [],
				)
			: [];
	return [...new Set([...entry.gates, ...retiring])];
}

function missingKeys(manifest: Manifest): string[] {
	return manifest.inventory.flatMap((entry) =>
		entry.surfaceKeys
			.filter((key) => !manifest.items.has(key))
			.map(
				(key) =>
					`${entry.id} names ${key}, which no surface item holds. Check the key's spelling against lib/commcare/surface/surface.json, or regenerate the surface if upstream added it.`,
			),
	);
}

/**
 * A gate entry's symbols, each by the item its surface key names: the item
 * exists, and a privilege's item holds the symbol as its slug. A removed
 * toggle names no item (HQ's registry no longer holds it), so it has none to
 * check here.
 */
function unheldSymbols(manifest: Manifest): string[] {
	return manifest.gates.flatMap((gate) =>
		gate.kind === "removed-toggle"
			? []
			: gate.symbols.flatMap((symbol, index) => {
					const key = gate.surfaceKeys[index] ?? "";
					const item = manifest.items.get(key);
					if (item === undefined)
						return [
							`${gate.id} names ${symbol} by ${key}, which no surface item holds. Check the symbol against HQ at the pin, or regenerate the surface if upstream renamed it.`,
						];
					if (gate.kind === "privilege" && item.slug !== symbol)
						return [
							`${gate.id} names the privilege ${symbol} by ${key}, whose item holds the slug ${String(item.slug)}. Name the constant in corehq/privileges.py that holds ${symbol}.`,
						];
					return [];
				}),
	);
}

/** The gates a gate entry links: the flag a removed toggle's content now
 *  sits under, and the gates its preflight requires. */
function gateLinks(gate: GateEntry): string[] {
	return [
		...new Set([
			...(gate.class.kind === "now" ? [gate.class.gate] : []),
			...(gate.preflight.requires?.gates ?? []),
		]),
	];
}

function danglingGates(manifest: Manifest): string[] {
	const gates = new Set(manifest.gates.map((gate) => gate.id));
	const links: ReadonlyArray<readonly [string, string[]]> = [
		...manifest.inventory.map(
			(entry) => [entry.id, linkedGates(entry)] as const,
		),
		...manifest.gates.map((gate) => [gate.id, gateLinks(gate)] as const),
	];
	return links.flatMap(([id, linked]) =>
		linked
			.filter((gate) => !gates.has(gate))
			.map(
				(gate) =>
					`${id} links the gate ${gate}, which no gate entry holds (lib/commcare/surface/entries/gates.json). Link an existing gate entry, or add this one.`,
			),
	);
}

function sharedClasses(manifest: Manifest): string[] {
	const claims = new Map<string, string[]>();
	for (const entry of manifest.inventory)
		for (const key of entry.surfaceKeys) {
			const at = `${key} at ${entry.valueClass === undefined ? "no value class" : `value class ${entry.valueClass}`}`;
			claims.set(at, [...(claims.get(at) ?? []), entry.id]);
		}
	return [...claims].flatMap(([at, ids]) =>
		ids.length > 1
			? [
					`${ids.join(" and ")} each claim ${at}. Give each entry its own value class, so the check knows which one a use of the key falls in.`,
				]
			: [],
	);
}

/**
 * A REFUSED entry refused only because HQ's build refuses its state is the
 * bar's, which the manifest check never reads beside other entries naming its
 * keys (`manifest_usage.py::_standing_plan`); any other REFUSED entry without
 * a value class takes every use of its keys.
 */
function takesEveryUse(entry: InventoryEntry): boolean {
	return (
		entry.disposition === "REFUSED" &&
		entry.valueClass === undefined &&
		entry.reasons.some((reason) => reason.kind !== "not-hq-buildable")
	);
}

function deadBesideClasslessRefusal(manifest: Manifest): string[] {
	const naming = new Map<string, InventoryEntry[]>();
	for (const entry of manifest.inventory)
		for (const key of entry.surfaceKeys)
			naming.set(key, [...(naming.get(key) ?? []), entry]);
	return [...naming].flatMap(([key, entries]) =>
		entries.filter(takesEveryUse).flatMap((refusing) => {
			const others = entries.filter((entry) => entry !== refusing);
			if (others.length === 0) return [];
			const held = others.map((entry) => entry.id).join(" and ");
			return [
				`${refusing.id} refuses every use of ${key} (REFUSED, no value class), so ${held} can hold none. Give ${refusing.id} the value class it refuses, or let it name a key of its own.`,
			];
		}),
	);
}

function unexplained(manifest: Manifest): string[] {
	return manifest.inventory.flatMap((entry) => {
		const named = entry.surfaceKeys.length > 0;
		const reason = entry.noSurfaceKey !== undefined;
		if (named === reason)
			return [
				named
					? `${entry.id} names surface keys and also says why it names none (noSurfaceKey). Keep the keys and drop the reason, or the reverse.`
					: `${entry.id} names no surface key and does not say why. Name the surface keys of what it covers, or say in noSurfaceKey why none can hold it.`,
			];
		return [];
	});
}

const RULES = {
	"every key an inventory entry names is a surface item": missingKeys,
	"every gate entry's symbols are held by their surface items": unheldSymbols,
	"every gate an entry links is a gate entry": danglingGates,
	"no two inventory entries claim one key at one value class": sharedClasses,
	"no REFUSED entry without a value class shares a key with another entry":
		deadBesideClasslessRefusal,
	"every inventory entry names a surface key or says why it cannot":
		unexplained,
} as const;

type Rule = keyof typeof RULES;

const MANIFEST = loadManifest();

function entry(id: string): InventoryEntry {
	const found = MANIFEST.inventory.find((each) => each.id === id);
	if (found === undefined)
		throw new Error(
			`The test plants its cases on ${id}, which the inventory no longer holds. Choose another entry of the same shape.`,
		);
	return found;
}

function gate(kind: GateEntry["kind"]): GateEntry {
	const found = MANIFEST.gates.find((each) => each.kind === kind);
	if (found === undefined)
		throw new Error(
			`The gate entries hold no ${kind} gate to plant a case on.`,
		);
	return found;
}

function withInventory(...planted: InventoryEntry[]): Manifest {
	return { ...MANIFEST, inventory: [...MANIFEST.inventory, ...planted] };
}

function withGates(...planted: GateEntry[]): Manifest {
	return { ...MANIFEST, gates: [...MANIFEST.gates, ...planted] };
}

// Entries the planted cases start from: a HELD entry with a value class, a
// REFUSED one with a retiring reason, one that says why it names no key, and a
// REFUSED one whose reasons are not only HQ's build's.
const HELD = entry("questions/text-input-xsd-string");
const REFUSING = MANIFEST.inventory.find(
	(each) =>
		each.disposition === "REFUSED" &&
		each.reasons.some((reason) => reason.kind !== "not-hq-buildable"),
);
const RETIRING = MANIFEST.inventory.find(
	(each) =>
		each.disposition === "REFUSED" &&
		each.reasons.some((reason) => reason.kind === "retiring"),
);
const KEYLESS = MANIFEST.inventory.find(
	(each) => each.noSurfaceKey !== undefined,
);

describe("the manifest", () => {
	it.each(Object.keys(RULES) as Rule[])("holds: %s", (rule) => {
		expect(RULES[rule](MANIFEST)).toEqual([]);
	});

	const held = MANIFEST.inventory.filter(
		(each) => each.disposition === "HELD",
	).length;
	const coverage = `${held} of ${MANIFEST.inventory.length} entries held`;
	it(`counts its coverage: ${coverage}`, () => {
		console.info(coverage);
		expect(held).toBeGreaterThan(0);
		expect(held).toBeLessThan(MANIFEST.inventory.length);
	});
});

describe("each rule refuses a planted entry the real manifest lacks", () => {
	const cases: ReadonlyArray<{
		readonly rule: Rule;
		readonly planted: () => Manifest;
		readonly problem: string;
	}> = [
		{
			rule: "every key an inventory entry names is a surface item",
			planted: () =>
				withInventory({
					...HELD,
					id: "questions/planted-dangling-key",
					surfaceKeys: [...HELD.surfaceKeys, "xform:not-an-element"],
					valueClass: "planted",
				}),
			problem:
				"questions/planted-dangling-key names xform:not-an-element, which no surface item holds.",
		},
		{
			rule: "every gate entry's symbols are held by their surface items",
			planted: () => {
				const toggle = gate("toggle");
				return withGates({
					...toggle,
					id: "toggle/NOT_A_TOGGLE",
					symbols: ["NOT_A_TOGGLE"],
					surfaceKeys: ["toggle:NOT_A_TOGGLE"],
				});
			},
			problem:
				"toggle/NOT_A_TOGGLE names NOT_A_TOGGLE by toggle:NOT_A_TOGGLE, which no surface item holds.",
		},
		{
			rule: "every gate entry's symbols are held by their surface items",
			planted: () => {
				const privilege = gate("privilege");
				return withGates({
					...privilege,
					id: "privilege/not_a_slug",
					symbols: ["not_a_slug"],
				});
			},
			problem: `privilege/not_a_slug names the privilege not_a_slug by ${gate("privilege").surfaceKeys[0]}, whose item holds the slug ${gate("privilege").symbols[0]}.`,
		},
		{
			rule: "every gate an entry links is a gate entry",
			planted: () =>
				withInventory({
					...HELD,
					id: "questions/planted-dangling-gate",
					valueClass: "planted",
					gates: ["toggle/NOT_A_GATE"],
				}),
			problem:
				"questions/planted-dangling-gate links the gate toggle/NOT_A_GATE, which no gate entry holds",
		},
		{
			rule: "every gate an entry links is a gate entry",
			planted: () => {
				if (RETIRING?.disposition !== "REFUSED")
					throw new Error("The inventory holds no retiring entry to plant on.");
				return withInventory({
					...RETIRING,
					id: `${RETIRING.area}/planted-retiring`,
					valueClass: "planted",
					gates: [],
					reasons: [
						{ kind: "retiring", gate: "toggle/NOT_A_GATE", named: "planted" },
					],
				});
			},
			problem:
				"/planted-retiring links the gate toggle/NOT_A_GATE, which no gate entry holds",
		},
		{
			rule: "every gate an entry links is a gate entry",
			planted: () => {
				const removed = gate("removed-toggle");
				return withGates({
					...removed,
					id: "removed-toggle/planted_now",
					class: { kind: "now", gate: "toggle/NOT_A_GATE" },
				});
			},
			problem:
				"removed-toggle/planted_now links the gate toggle/NOT_A_GATE, which no gate entry holds",
		},
		{
			rule: "every gate an entry links is a gate entry",
			planted: () => {
				const toggle = gate("toggle");
				return withGates({
					...toggle,
					id: "toggle/PLANTED_REQUIRES",
					preflight: {
						...toggle.preflight,
						requires: { operator: "all", gates: ["toggle/NOT_A_GATE"] },
					},
				});
			},
			problem:
				"toggle/PLANTED_REQUIRES links the gate toggle/NOT_A_GATE, which no gate entry holds",
		},
		{
			rule: "no REFUSED entry without a value class shares a key with another entry",
			planted: () => {
				if (REFUSING?.disposition !== "REFUSED")
					throw new Error(
						"The inventory holds no REFUSED entry outside HQ's build to plant on.",
					);
				const {
					valueClass: _class,
					noSurfaceKey: _reason,
					...classless
				} = REFUSING;
				return withInventory({
					...classless,
					id: `${REFUSING.area}/planted-classless-refusal`,
					surfaceKeys: [HELD.surfaceKeys[0] ?? ""],
				});
			},
			problem: `/planted-classless-refusal refuses every use of ${HELD.surfaceKeys[0]} (REFUSED, no value class), so questions/text-input-xsd-string`,
		},
		{
			rule: "no two inventory entries claim one key at one value class",
			planted: () =>
				withInventory({
					...HELD,
					id: "questions/planted-second-claim",
					surfaceKeys: [HELD.surfaceKeys[0] ?? ""],
				}),
			problem: `questions/text-input-xsd-string and questions/planted-second-claim each claim ${HELD.surfaceKeys[0]} at value class ${HELD.valueClass}.`,
		},
		{
			rule: "every inventory entry names a surface key or says why it cannot",
			planted: () =>
				withInventory({
					...HELD,
					id: "questions/planted-unexplained",
					surfaceKeys: [],
				}),
			problem:
				"questions/planted-unexplained names no surface key and does not say why.",
		},
		{
			rule: "every inventory entry names a surface key or says why it cannot",
			planted: () => {
				if (KEYLESS === undefined)
					throw new Error("The inventory holds no keyless entry to plant on.");
				return withInventory({
					...KEYLESS,
					id: `${KEYLESS.area}/planted-both`,
					surfaceKeys: ["xform:model"],
					valueClass: "planted",
				});
			},
			problem:
				"/planted-both names surface keys and also says why it names none (noSurfaceKey).",
		},
	];

	it.each(cases)("$rule: $problem", ({ rule, planted, problem }) => {
		const found = RULES[rule](planted());
		expect(found).toHaveLength(1);
		expect(found[0]).toContain(problem);
	});

	it("passes a REFUSED entry without a value class that only HQ's build refuses, beside another entry naming its key", () => {
		// The bar reports every export HQ's build refuses, and the check never
		// reads such an entry beside others (`_standing_plan`), so it takes no
		// use from the entry it shares the key with.
		if (REFUSING?.disposition !== "REFUSED")
			throw new Error(
				"The inventory holds no REFUSED entry outside HQ's build to plant on.",
			);
		const {
			valueClass: _class,
			noSurfaceKey: _reason,
			...classless
		} = REFUSING;
		const planted = withInventory({
			...classless,
			id: `${REFUSING.area}/planted-build-refusal`,
			surfaceKeys: [HELD.surfaceKeys[0] ?? ""],
			reasons: [{ kind: "not-hq-buildable", named: "a planted refusal" }],
		});
		expect(deadBesideClasslessRefusal(planted)).toEqual([]);
	});

	it("parses no entries file that breaks the schema", () => {
		const area = INVENTORY_AREAS[0];
		const entries = readJson(`entries/${area}.json`) as unknown[];
		expect(inventoryEntriesFileSchema.safeParse(entries).success).toBe(true);
		const broken = [
			{ ...(entries[0] as Record<string, unknown>), disposition: "MAYBE" },
		];
		expect(inventoryEntriesFileSchema.safeParse(broken).success).toBe(false);
		const blank = [
			{ ...(entries[0] as Record<string, unknown>), noSurfaceKey: "" },
		];
		expect(inventoryEntriesFileSchema.safeParse(blank).success).toBe(false);
	});
});
