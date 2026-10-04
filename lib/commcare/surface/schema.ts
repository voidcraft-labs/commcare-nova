// lib/commcare/surface/schema.ts
//
// The manifest's authored layer. `entries/<area>.json` holds one inventory
// entry per counted row of an HQ round-trip inventory area, and one for each
// item Nova's exports use that no row covers (`origin`); `entries/gates.json` holds one
// gate entry per gate the inventory's gates file names. Each entry keeps the
// row's text as written (`*Cell`, `cell`, `item`, `content`) beside the
// structured fields code reads; surface keys and gate links name items of the
// generated surface and other gate entries, and an inventory entry that names
// no surface key says why (`noSurfaceKey`).
//
// Every JSON file under `entries/` parses with the file schemas below.

import { z } from "zod";

/** The inventory's area files, by file stem. */
export const INVENTORY_AREAS = [
	"application-and-settings",
	"menus-and-case-lists",
	"case-search",
	"forms-and-case-writes",
	"questions",
	"expressions-and-data",
] as const;
export const inventoryAreaSchema = z.enum(INVENTORY_AREAS);
export type InventoryArea = z.infer<typeof inventoryAreaSchema>;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A surface item's key, `<family>:<name>` (`schema:Detail.display`,
 * `toggle:SESSION_ENDPOINTS`, `appearance:android/minimal`). The family
 * vocabulary belongs to the generated surface; a key names an item there.
 */
export const surfaceKeySchema = z
	.string()
	.regex(
		/^[a-z][a-z0-9-]*:\S+$/,
		"A surface key is a family and a name joined by a colon, such as `toggle:SESSION_ENDPOINTS`.",
	);
export type SurfaceKey = z.infer<typeof surfaceKeySchema>;

/**
 * The value class an entry covers where the inventory splits one surface
 * item into several rows by value (the inventory's rule 3), as a slug.
 */
export const valueClassSchema = z
	.string()
	.regex(
		SLUG_PATTERN,
		"A value class is a lowercase slug, such as `literal-or-typed-value`.",
	);

/** An inventory entry's id: its area, a slash, and a slug unique in that area. */
export const inventoryEntryIdSchema = z
	.string()
	.regex(
		/^[a-z-]+\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
		"An inventory entry id is its area and a slug, such as `menus-and-case-lists/detail-display`.",
	);

/**
 * What HQ reads to decide a gate: a toggle, a removed toggle whose slug
 * documents still carry, a plan privilege, a CommCare build version, or a
 * project-space setting.
 */
export const GATE_KINDS = [
	"toggle",
	"removed-toggle",
	"privilege",
	"build-version",
	"project-space-setting",
] as const;
export const gateKindSchema = z.enum(GATE_KINDS);
export type GateKind = z.infer<typeof gateKindSchema>;

/**
 * A gate entry's id: its kind, a slash, and the symbols it names joined by
 * `+` (`toggle/SESSION_ENDPOINTS`, `privilege/templated_intents+custom_intents`).
 */
export const gateEntryIdSchema = z
	.string()
	.regex(
		new RegExp(`^(?:${GATE_KINDS.join("|")})/\\S+$`),
		"A gate entry id is its kind and its symbols, such as `toggle/SESSION_ENDPOINTS`.",
	);
export type GateEntryId = z.infer<typeof gateEntryIdSchema>;

export const DISPOSITIONS = [
	"HELD",
	"HELD-NEW",
	"TARGET-OWNED",
	"INERT",
	"REFUSED",
] as const;
export const dispositionSchema = z.enum(DISPOSITIONS);
export type Disposition = z.infer<typeof dispositionSchema>;

/**
 * A change a HELD row names to the grammar of the Nova slot that holds it:
 * `text` is the change as the row words it, and `scope` the items the row
 * extends it over or the limit it sets on it, where the row gives one apart
 * from the change.
 */
export const slotChangeSchema = z.strictObject({
	direction: z.enum(["widen", "narrow"]),
	text: z.string().min(1),
	scope: z.string().min(1).optional(),
});
export type SlotChange = z.infer<typeof slotChangeSchema>;

/** The inventory's rule 5: the only reasons an import is refused. */
export const REFUSAL_REASON_KINDS = [
	"retiring",
	"freeform",
	"not-hq-editable",
	"not-hq-buildable",
	"broken-at-runtime",
	"unrepresentable-identity",
	"untypeable",
	"below-commcare-version-floor",
	"unavailable-on-declared-platform",
] as const;
export type RefusalReasonKind = (typeof REFUSAL_REASON_KINDS)[number];

/**
 * One reason a REFUSED entry is refused. `named` is the gate, editor rule,
 * validator or failure the reason names, as the row words it; `condition` is
 * the case the reason is limited to, where the row limits it. A retiring
 * reason links the gate entry of the flag that retires the content.
 */
export const refusalReasonSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("retiring"),
		gate: gateEntryIdSchema,
		named: z.string().min(1),
		condition: z.string().min(1).optional(),
	}),
	z.strictObject({
		kind: z.enum(REFUSAL_REASON_KINDS).exclude(["retiring"]),
		named: z.string().min(1).optional(),
		condition: z.string().min(1).optional(),
	}),
]);
export type RefusalReason = z.infer<typeof refusalReasonSchema>;

export const PLATFORM_READINGS = [
	"runs",
	"ignored",
	"unavailable",
	"different",
	"not-applicable",
] as const;
export type PlatformReading = (typeof PLATFORM_READINGS)[number];

/** How one runtime reads the item, with the row's note on that reading. */
export const platformBehaviorSchema = z.strictObject({
	reading: z.enum(PLATFORM_READINGS),
	note: z.string().min(1).optional(),
});
export type PlatformBehavior = z.infer<typeof platformBehaviorSchema>;

const eachPlatformSchema = z.strictObject({
	kind: z.literal("each"),
	cell: z.string().min(1),
	webApps: platformBehaviorSchema,
	android: platformBehaviorSchema,
});
/** No runtime reads the item as app content Nova holds. */
const notApplicablePlatformsSchema = z.strictObject({
	kind: z.literal("not-applicable"),
	cell: z.string().min(1),
	note: z.string().min(1).optional(),
});
/** The item reads on each platform as the rows of another section say. */
const asSectionPlatformsSchema = z.strictObject({
	kind: z.literal("as-section"),
	cell: z.string().min(1),
	section: z.string().min(1),
});
/** A refused item has no platform reading. */
const refusedPlatformsSchema = z.strictObject({
	kind: z.literal("none"),
	cell: z.literal("—"),
});
const heldPlatformsSchema = z.discriminatedUnion("kind", [
	eachPlatformSchema,
	notApplicablePlatformsSchema,
	asSectionPlatformsSchema,
]);
export const platformsSchema = z.discriminatedUnion("kind", [
	eachPlatformSchema,
	notApplicablePlatformsSchema,
	asSectionPlatformsSchema,
	refusedPlatformsSchema,
]);
export type Platforms = z.infer<typeof platformsSchema>;

/**
 * The emission markers the row's Emission cell carries: `printed` (written
 * from Nova's typed expression, with the source's meaning), `unproducible`
 * and `save-breaking` (Nova's current emission lies outside HQ's editable
 * envelope), `omit` (Nova writes nothing) and `n/a` (the item has no
 * emission of its own).
 */
export const EMISSION_MARKERS = [
	"printed",
	"unproducible",
	"save-breaking",
	"omit",
	"n/a",
] as const;
export type EmissionMarker = (typeof EMISSION_MARKERS)[number];

export const emissionSchema = z
	.strictObject({
		cell: z.string().min(1),
		markers: z.array(z.enum(EMISSION_MARKERS)),
	})
	.refine(
		(emission) => new Set(emission.markers).size === emission.markers.length,
		{ message: "An emission lists each marker once.", path: ["markers"] },
	);
export type Emission = z.infer<typeof emissionSchema>;

// An entry's structured fields restate its cells: a HELD entry's slot
// changes are the `widen` and `narrow` changes its Disposition cell names, a
// REFUSED entry's reasons are the rule-5 reasons that cell gives, and the
// platform readings and emission markers are those of the row's Web Apps /
// Android and Emission cells.
const inventoryEntryHead = {
	id: inventoryEntryIdSchema,
	area: inventoryAreaSchema,
	/** The `##` section, named as the inventory's Counts table names it. */
	section: z.string().min(1),
	/** The `###` subsection, where the row sits under one. */
	subsection: z.string().min(1).optional(),
	/** The row's HQ item cell, as written. */
	item: z.string().min(1),
	surfaceKeys: z.array(surfaceKeySchema),
	valueClass: valueClassSchema.optional(),
	/**
	 * Why the entry names no surface key, where it names none: what it covers
	 * is a relation between items, project-space or server state, content no
	 * reader reads, or an item the surface does not hold (which decision 7
	 * refuses as one no entry names, or HQ refuses before any reader reads it),
	 * none of which a surface item holds.
	 */
	noSurfaceKey: z.string().min(1).optional(),
	/**
	 * Where an entry comes from when no inventory row is its source:
	 * `export-use`, an item Nova's exports use that no counted row covers,
	 * written in the inventory's shape for the person to review in the pull
	 * request that adds it. The inventory's reconciliation leaves such an
	 * entry out of its rows and counts.
	 */
	origin: z.literal("export-use").optional(),
};
/** The row's Disposition cell, as written. */
const dispositionCellSchema = z.string().min(1);
const inventoryEntryTail = {
	emission: emissionSchema,
	/** The gates this content needs in a target, as gate entry ids. */
	gates: z.array(gateEntryIdSchema),
};

export const inventoryEntrySchema = z
	.discriminatedUnion("disposition", [
		z.strictObject({
			...inventoryEntryHead,
			disposition: dispositionSchema.extract(["HELD"]),
			dispositionCell: dispositionCellSchema,
			slotChanges: z.array(slotChangeSchema),
			platforms: heldPlatformsSchema,
			...inventoryEntryTail,
		}),
		z.strictObject({
			...inventoryEntryHead,
			disposition: dispositionSchema.extract(["HELD-NEW"]),
			dispositionCell: dispositionCellSchema,
			platforms: heldPlatformsSchema,
			...inventoryEntryTail,
		}),
		z.strictObject({
			...inventoryEntryHead,
			disposition: dispositionSchema.extract(["TARGET-OWNED", "INERT"]),
			dispositionCell: dispositionCellSchema,
			platforms: notApplicablePlatformsSchema,
			...inventoryEntryTail,
		}),
		z.strictObject({
			...inventoryEntryHead,
			disposition: dispositionSchema.extract(["REFUSED"]),
			dispositionCell: dispositionCellSchema,
			reasons: z.array(refusalReasonSchema).min(1),
			platforms: refusedPlatformsSchema,
			...inventoryEntryTail,
		}),
	])
	.refine((entry) => entry.id.startsWith(`${entry.area}/`), {
		message: "An inventory entry's id starts with its area.",
		path: ["id"],
	});
export type InventoryEntry = z.infer<typeof inventoryEntrySchema>;

export const HQ_TOGGLE_CLASSES = [
	"StaticToggle",
	"FrozenPrivilegeToggle",
	"FeatureRelease",
	"DynamicallyPredictablyRandomToggle",
] as const;
export type HqToggleClass = (typeof HQ_TOGGLE_CLASSES)[number];

/**
 * One namespace a toggle is keyed by, as the toggle holds it at runtime
 * (`corehq/toggles/__init__.py::StaticToggle.__init__`): `NAMESPACE_USER`
 * and an omitted list both become `null`; the others keep their values
 * (`NAMESPACE_DOMAIN` is `'domain'`).
 */
export const toggleNamespaceSchema = z.union([
	z.enum(["domain", "email_domain", "other"]),
	z.null(),
]);
export type ToggleNamespace = z.infer<typeof toggleNamespaceSchema>;

/**
 * A gate's class as the gates file names it: the app-building and privilege
 * classes, a removed toggle whose residue imports as INERT or REFUSED, a
 * removed toggle whose content another flag now gates, the removed toggles
 * with no field of their own, the adjacent privileges, the publish checks
 * outside the flags, and the build-version gates by what HQ does below the
 * version (leaves the feature out of the build, keeps its editors from
 * offering it, fails the build, changes only a display, or never turns on).
 */
export const gateClassSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.enum([
			"target-owned",
			"retiring",
			"inert",
			"no-field-of-their-own",
			"adjacent",
			"publish-check",
			"generation",
			"authoring",
			"build-error",
			"display-only",
			"disabled",
		]),
	}),
	z.strictObject({
		kind: z.literal("removed"),
		residue: z.enum(["inert", "refused"]),
	}),
	z.strictObject({ kind: z.literal("now"), gate: gateEntryIdSchema }),
]);
export type GateClass = z.infer<typeof gateClassSchema>;

/**
 * The target preflight the gates file sets for this gate: none, a
 * precondition the target must meet, a confirmation publish asks the person
 * for, or a refusal of the content, with the gates file's wording.
 * `requires` lists the gates the preflight needs where the wording names
 * gates beyond this one: all of them, or any one.
 */
export const gatePreflightSchema = z.strictObject({
	kind: z.enum(["none", "precondition", "confirmation", "refusal"]),
	cell: z.string().min(1),
	requires: z
		.strictObject({
			operator: z.enum(["all", "any"]),
			gates: z.array(gateEntryIdSchema).min(1),
		})
		.optional(),
});
export type GatePreflight = z.infer<typeof gatePreflightSchema>;

/**
 * A build output the gate changes, as the proof harness's configuration
 * sensitivity check sees it (`proof/checks/sensitivity.py`): HQ's build of a
 * Nova export with this gate alone flipped differs from the plain build in
 * `artifact` at `path`, both in the known-defect register's vocabulary.
 * `artifact` names what HQ built, with the app's data as `*`: `suite.xml`,
 * `profile.ccpr`, `form:*`, `app_strings:*`, `validate_app`, and a build
 * profile's files under its id as `*`. `path` is the difference's
 * structural path in it (`/suite/detail[@id=*]/no_items_text[*]`). The
 * check writes them (`python -m proof.checks.sensitivity effects`) from
 * every class its runs over the whole corpus showed, so they are what HQ was
 * seen to change, not everything it could.
 */
export const gateEffectSchema = z.strictObject({
	artifact: z.string().min(1),
	path: z
		.string()
		.startsWith(
			"/",
			"An effect's path is structural, from the artifact's root (`/suite/...`).",
		),
});
export type GateEffect = z.infer<typeof gateEffectSchema>;

/** A gate's effects: each class once, sorted by artifact and then path. */
const gateEffectsSchema = z
	.array(gateEffectSchema)
	.superRefine((effects, ctx) => {
		effects.forEach((effect, index) => {
			const previous = effects[index - 1];
			if (previous === undefined) return;
			const before =
				previous.artifact < effect.artifact ||
				(previous.artifact === effect.artifact && previous.path < effect.path);
			if (before) return;
			const twice =
				previous.artifact === effect.artifact && previous.path === effect.path;
			ctx.addIssue({
				code: "custom",
				path: [index],
				message: twice
					? `The effect ${effect.artifact} ${effect.path} is listed twice; list each class once.`
					: `The effect ${effect.artifact} ${effect.path} comes after ${previous.artifact} ${previous.path}; effects are sorted by artifact, then path, as proof/checks/sensitivity.py writes them.`,
			});
		});
	});

/** Where the gates file names the gate: a table row, or a paragraph. */
export const gateSourceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("row"),
		table: z.enum(["app-building-toggles", "removed-toggles", "privileges"]),
		line: z.number().int().positive(),
	}),
	z.strictObject({
		kind: z.literal("paragraph"),
		paragraph: z.enum(["publish-checks", "build-versions"]),
		line: z.number().int().positive(),
	}),
]);
export type GateSource = z.infer<typeof gateSourceSchema>;

const gateEntryBody = {
	/** The toggle constants, privilege slugs, removed slugs or setting fields
	 *  (`Class.field`) the gate names; for a build version, the
	 *  `CommCareFeatureSupportMixin` property, or the app-manager functions
	 *  that compare `build_version` themselves (`path::Class.function`). */
	symbols: z.array(z.string().regex(/^\S+$/)).min(1),
	/** The surface items HQ reads to decide the gate, one per symbol in the
	 *  symbols' order: `toggle:<SYMBOL>`, `privilege:<CONSTANT>` (a privilege
	 *  slug's constant in `corehq/privileges.py`),
	 *  `project-setting:<Model>.<field>`, or `version-gate:<property>` /
	 *  `version-gate:corehq/apps/app_manager/<path>::<qualname>`. A removed
	 *  toggle names none: HQ's registry no longer holds it. */
	surfaceKeys: z.array(surfaceKeySchema),
	/** How the gates file names the gate: a row's first cell, or the
	 *  paragraph's words for it, as written. */
	item: z.string().min(1),
	class: gateClassSchema,
	/** What the gate governs, as the gates file words it, where it does. */
	content: z.string().min(1).optional(),
	/** The inventory entries whose content the gate governs, in inventory
	 *  order: the rows the content names, and every row that names this gate
	 *  among its own `gates` or in a retiring reason. */
	contentEntries: z.array(inventoryEntryIdSchema),
	/** The gates file reads no gate on a platform. */
	platforms: z.literal("n/a"),
	preflight: gatePreflightSchema,
	/** What HQ's build changed when a sensitivity run flipped the gate: empty
	 *  where its flips changed nothing, and absent where no run flipped it.
	 *  The check flips each flag and project-space setting HQ's build read
	 *  while building a corpus document, and never a privilege, a build
	 *  version or a removed toggle. */
	effects: gateEffectsSchema.optional(),
	source: gateSourceSchema,
};

/**
 * The surface key a gate's symbol names. A toggle's constant, a
 * project-space setting's `Model.field`, and a build version's
 * `CommCareFeatureSupportMixin` property or app-manager function
 * (`path::qualname` under `corehq/apps/app_manager/`) each spell their key.
 * A privilege's key names the constant in `corehq/privileges.py` that holds
 * its slug (`save_to_case` is `VELLUM_SAVE_TO_CASE`), which only the surface
 * records, so only its family is spelled here: `prefix` marks that.
 */
function surfaceKeyOfSymbol(
	kind: Exclude<GateKind, "removed-toggle">,
	symbol: string,
): { readonly key: string; readonly prefix: boolean } {
	switch (kind) {
		case "toggle":
			return { key: `toggle:${symbol}`, prefix: false };
		case "project-space-setting":
			return { key: `project-setting:${symbol}`, prefix: false };
		case "build-version":
			return {
				key: symbol.includes("::")
					? `version-gate:corehq/apps/app_manager/${symbol}`
					: `version-gate:${symbol}`,
				prefix: false,
			};
		case "privilege":
			return { key: "privilege:", prefix: true };
	}
}

export const gateEntrySchema = z
	.discriminatedUnion("kind", [
		z.strictObject({
			id: gateEntryIdSchema,
			kind: gateKindSchema.extract(["toggle"]),
			/** The toggle's class. A FrozenPrivilegeToggle is gated by its
			 *  privilege: HQ's feature-flag filter never offers its slug
			 *  (`toggles/__init__.py::all_toggles_by_name_in_scope`). */
			hqToggleClass: z.enum(HQ_TOGGLE_CLASSES),
			/** The slug HQ keys the toggle by, as the surface records it. */
			slug: z.string().min(1),
			/** The namespaces the toggle is keyed by, at runtime. */
			namespaces: z.array(toggleNamespaceSchema).min(1),
			/** A FrozenPrivilegeToggle's privilege, by its constant in
			 *  `corehq/privileges.py`. */
			privilege: z.string().min(1).optional(),
			...gateEntryBody,
		}),
		z.strictObject({
			id: gateEntryIdSchema,
			kind: gateKindSchema.extract([
				"removed-toggle",
				"privilege",
				"project-space-setting",
			]),
			...gateEntryBody,
		}),
		z.strictObject({
			id: gateEntryIdSchema,
			kind: gateKindSchema.extract(["build-version"]),
			/** The lowest CommCare version the gate admits, where it has one. */
			minimumVersion: z
				.string()
				.regex(/^[0-9]+(?:\.[0-9]+)+$/)
				.optional(),
			...gateEntryBody,
		}),
	])
	.refine((entry) => entry.id.startsWith(`${entry.kind}/`), {
		message: "A gate entry's id starts with its kind.",
		path: ["id"],
	})
	.superRefine((entry, ctx) => {
		if (entry.kind === "removed-toggle") {
			if (entry.surfaceKeys.length > 0)
				ctx.addIssue({
					code: "custom",
					path: ["surfaceKeys"],
					message:
						"A removed toggle names no surface key: HQ's registry no longer holds it.",
				});
		} else if (entry.surfaceKeys.length !== entry.symbols.length) {
			ctx.addIssue({
				code: "custom",
				path: ["surfaceKeys"],
				message:
					"A gate entry names one surface key for each symbol, the item HQ reads to decide it.",
			});
		} else {
			const kind = entry.kind;
			entry.symbols.forEach((symbol, index) => {
				const key = entry.surfaceKeys[index] ?? "";
				const spelled = surfaceKeyOfSymbol(kind, symbol);
				const names = spelled.prefix
					? key.startsWith(spelled.key)
					: key === spelled.key;
				if (!names)
					ctx.addIssue({
						code: "custom",
						path: ["surfaceKeys", index],
						message: `Surface key ${index + 1} is \`${key}\`, but the symbol in the same place, \`${symbol}\`, names ${spelled.prefix ? `a \`${spelled.key}\` item` : `\`${spelled.key}\``}. A gate entry lists its surface keys in the order of its symbols.`,
					});
			});
		}
		if (entry.kind === "toggle") {
			if (entry.symbols.length !== 1)
				ctx.addIssue({
					code: "custom",
					path: ["symbols"],
					message:
						"A toggle entry names one toggle, such as `SESSION_ENDPOINTS`.",
				});
			if (
				(entry.hqToggleClass === "FrozenPrivilegeToggle") !==
				(entry.privilege !== undefined)
			)
				ctx.addIssue({
					code: "custom",
					path: ["privilege"],
					message:
						"A toggle entry records a privilege exactly when HQ declares it a FrozenPrivilegeToggle.",
				});
		}
		if (new Set(entry.contentEntries).size !== entry.contentEntries.length)
			ctx.addIssue({
				code: "custom",
				path: ["contentEntries"],
				message: "A gate entry lists each inventory entry it governs once.",
			});
	});
export type GateEntry = z.infer<typeof gateEntrySchema>;
export type ToggleGateEntry = Extract<GateEntry, { kind: "toggle" }>;

function uniqueIds<T extends { id: string }>(
	entries: readonly T[],
	ctx: z.RefinementCtx,
): void {
	const seen = new Set<string>();
	entries.forEach((entry, index) => {
		if (seen.has(entry.id))
			ctx.addIssue({
				code: "custom",
				path: [index, "id"],
				message: `Two entries share the id "${entry.id}"; each entry needs its own.`,
			});
		seen.add(entry.id);
	});
}

/** One `entries/<area>.json` file. */
export const inventoryEntriesFileSchema = z
	.array(inventoryEntrySchema)
	.superRefine(uniqueIds);

/** The `entries/gates.json` file. */
export const gateEntriesFileSchema = z
	.array(gateEntrySchema)
	.superRefine(uniqueIds);
