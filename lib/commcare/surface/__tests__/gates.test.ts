/**
 * The gate entries against the generated surface, and the accessor the
 * project-space check reads flags through.
 *
 * A gate entry copies a toggle's slug, namespaces and class from the surface,
 * which the weekly pin pull request regenerates from HQ's latest code. If the
 * copy drifts, the probe asks HQ about a slug it no longer registers (HQ
 * answers 400 and the check reads "unverified" for every publish) or about a
 * flag HQ no longer keys by project space. These checks compare the copy with
 * the surface item, and run the accessor over every toggle gate entry; that
 * every key and symbol a gate entry names is a surface item holding it is the
 * manifest test's (`manifest.test.ts`).
 *
 * A gate entry's content links and an inventory entry's `gates` state one
 * relation from its two ends, authored apart, so the gate end is checked to
 * hold every link the inventory end states.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { domainFeatureFlag, toggleGate } from "../gates";
import {
	gateEntriesFileSchema,
	gateEntryIdSchema,
	INVENTORY_AREAS,
	inventoryEntryIdSchema,
} from "../schema";

const SURFACE_DIR = join(process.cwd(), "lib/commcare/surface");

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(join(SURFACE_DIR, path), "utf8"));
}

const GATES = gateEntriesFileSchema.parse(readJson("entries/gates.json"));
const ITEMS = (
	readJson("surface.json") as {
		items: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	}
).items;

/**
 * The inventory entries, in inventory order, with the gates each names: its
 * own `gates` and its retiring reasons' gates. The entries' own schema is
 * the manifest test's.
 */
const INVENTORY = INVENTORY_AREAS.flatMap((area) =>
	z
		.array(
			z.object({
				id: inventoryEntryIdSchema,
				gates: z.array(gateEntryIdSchema),
				reasons: z
					.array(
						z.object({
							kind: z.string(),
							gate: gateEntryIdSchema.optional(),
						}),
					)
					.optional(),
			}),
		)
		.parse(readJson(`entries/${area}.json`))
		.map((entry) => ({
			id: entry.id,
			gates: new Set([
				...entry.gates,
				...(entry.reasons ?? []).flatMap((reason) =>
					reason.kind === "retiring" && reason.gate !== undefined
						? [reason.gate]
						: [],
				),
			]),
		})),
);

describe("gate entries", () => {
	it("hold each toggle's slug, namespaces, class and privilege as the surface records them", () => {
		const drift = GATES.flatMap((gate) => {
			if (gate.kind !== "toggle") return [];
			const item = ITEMS[`toggle:${gate.symbols[0]}`];
			const held = {
				class: gate.hqToggleClass,
				slug: gate.slug,
				namespaces: gate.namespaces,
				privilege: gate.privilege,
			};
			const upstream = {
				class: item?.class,
				slug: item?.slug,
				namespaces: item?.namespaces,
				privilege: item?.privilege,
			};
			return JSON.stringify(held) === JSON.stringify(upstream)
				? []
				: [`${gate.id}: ${JSON.stringify(held)} ≠ ${JSON.stringify(upstream)}`];
		});
		expect(drift).toEqual([]);
	});

	it("keep a removed toggle's slug out of HQ's registry", () => {
		const registered = new Set(
			Object.entries(ITEMS)
				.filter(([key]) => key.startsWith("toggle:"))
				.map(([, item]) => item.slug),
		);
		const back = GATES.filter((gate) => gate.kind === "removed-toggle")
			.flatMap((gate) => gate.symbols)
			.filter((slug) => registered.has(slug));
		expect(back).toEqual([]);
	});

	it("govern only inventory entries that exist, in inventory order", () => {
		const position = new Map(
			INVENTORY.map((entry, index) => [entry.id, index]),
		);
		const dangling = GATES.flatMap((gate) =>
			gate.contentEntries
				.filter((id) => !position.has(id))
				.map((id) => `${gate.id} governs ${id}`),
		);
		expect(dangling).toEqual([]);
		const unordered = GATES.filter((gate) =>
			gate.contentEntries.some(
				(id, index) =>
					index > 0 &&
					(position.get(id) ?? 0) <
						(position.get(gate.contentEntries[index - 1] ?? "") ?? 0),
			),
		).map((gate) => gate.id);
		expect(unordered).toEqual([]);
	});

	it("govern every inventory entry that names them", () => {
		const byId = new Map(GATES.map((gate) => [gate.id, gate]));
		const unlinked = INVENTORY.flatMap((entry) =>
			[...entry.gates].flatMap((id) => {
				const gate = byId.get(id);
				if (gate === undefined)
					return [`${entry.id} names ${id}, which no gate entry holds`];
				return gate.contentEntries.includes(entry.id)
					? []
					: [`${entry.id} names ${id}, whose content entries leave it out`];
			}),
		);
		expect(unlinked).toEqual([]);
	});
});

describe("domainFeatureFlag", () => {
	const toggles = GATES.filter((gate) => gate.kind === "toggle");
	const frozen = toggles.filter(
		(gate) => gate.hqToggleClass === "FrozenPrivilegeToggle",
	);
	const notDomainOnly = toggles.filter(
		(gate) =>
			gate.hqToggleClass !== "FrozenPrivilegeToggle" &&
			JSON.stringify(gate.namespaces) !== JSON.stringify(["domain"]),
	);
	const probeable = toggles.filter(
		(gate) => !frozen.includes(gate) && !notDomainOnly.includes(gate),
	);

	it("gives a project-space flag's slug from its gate entry", () => {
		expect(probeable.length).toBeGreaterThan(0);
		for (const gate of probeable) {
			const [symbol] = gate.symbols;
			expect(domainFeatureFlag(symbol as string)).toEqual({
				symbol,
				slug: gate.slug,
				namespace: "domain",
			});
		}
	});

	it("refuses a FrozenPrivilegeToggle, whose slug HQ's feature-flag filter never lists", () => {
		expect(frozen.length).toBeGreaterThan(0);
		for (const gate of frozen) {
			expect(() => domainFeatureFlag(gate.symbols[0] as string)).toThrow(
				/FrozenPrivilegeToggle/,
			);
		}
	});

	it("refuses a toggle keyed by anything but the project space alone", () => {
		expect(notDomainOnly.length).toBeGreaterThan(0);
		for (const gate of notDomainOnly) {
			expect(() => domainFeatureFlag(gate.symbols[0] as string)).toThrow(
				/not by project space alone/,
			);
		}
	});

	it("refuses a symbol no gate entry records", () => {
		expect(() => toggleGate("NOT_A_GATED_TOGGLE")).toThrow(
			/no toggle entry for the HQ flag NOT_A_GATED_TOGGLE/,
		);
	});
});

describe("a gate's effects", () => {
	const gate = (
		readJson("entries/gates.json") as ReadonlyArray<Record<string, unknown>>
	).find((entry) => entry.id === "toggle/USH_EMPTY_CASE_LIST_TEXT");
	const text = { artifact: "app_strings:*", path: "/m*_no_items_text" };
	const detail = {
		artifact: "suite.xml",
		path: "/suite/detail[@id=*]/no_items_text[*]",
	};
	const issues = (effects?: unknown): string[] => {
		const { effects: _held, ...entry } = gate ?? {};
		const result = gateEntriesFileSchema.safeParse([
			effects === undefined ? entry : { ...entry, effects },
		]);
		return result.success ? [] : result.error.issues.map((i) => i.message);
	};
	it("are rooted classes, each once, in order; empty where flips changed nothing; absent where none ran", () => {
		expect(gate).toBeDefined();
		expect(issues([text, detail])).toEqual([]);
		expect(issues([])).toEqual([]);
		expect(issues()).toEqual([]);
	});
	it("refuse a relative path, a class listed twice, and classes out of order", () => {
		expect(issues([{ ...detail, path: "suite/detail" }])).toEqual([
			"An effect's path is structural, from the artifact's root (`/suite/...`).",
		]);
		expect(issues([text, text])).toEqual([
			`The effect ${text.artifact} ${text.path} is listed twice; list each class once.`,
		]);
		expect(issues([detail, text])).toEqual([
			expect.stringContaining(
				`${text.artifact} ${text.path} comes after ${detail.artifact} ${detail.path}`,
			),
		]);
	});
});
