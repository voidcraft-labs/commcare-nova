/**
 * Organization-level and location-property rules — app-scoped, because
 * neither collection belongs to a module or a form.
 *
 * Two of these rules exist because CommCare adjudicates the same strings:
 * a level's `code` is `LocationType.code`, a `SlugField` that is
 * domain-unique through `LocationType.Meta.unique_together` and reaches
 * the wire as the fixture's `@type` and its `{code}_id` lineage attribute
 * name; a location property's `slug` is a `Field.slug` on the domain's
 * `LocationFields` definition, adjudicated by exactly the machinery user
 * properties go through (`custom_data_fields/edit_model.py::XmlSlugField`
 * and `models.py::validate_reserved_words`). A name CommCare refuses is a
 * push that fails on identity grounds long after the author wrote it, so
 * Nova refuses it at construction.
 *
 * The rest are Nova's own structural integrity: a level graph with a
 * broken or looping parent chain, or an address book pointing at a level
 * that is not above it, has no coherent fixture — and unlike HQ, which
 * documents such states as "undefined outcomes" in its own fixture query,
 * Nova refuses to build one.
 *
 * What is NOT here is anything that depends on the locations store.
 * "No place still stands at this level" and "this persona's assignment
 * still points at a live place" are proved inside the commit
 * transaction, because they are questions about rows the document cannot
 * see and because a document-time answer would already be stale by the
 * time it was acted on.
 */

import {
	ancestorLevels,
	type BlueprintDoc,
	levelOwnsCases,
	locationPropertiesOf,
	MAX_ATOMIC_LOCATION_DESCENDANTS,
	MAX_LOCATION_VALUES,
	type OrganizationLevel,
	organizationLevelsOf,
	personasOf,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";
import { userPropertySlugVerdict } from "../userPropertySlug";

/** Case-insensitive display-name key, so two levels can't look identical. */
function nameKey(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * A source's complete reverse-hop destination branch must fit in one atomic
 * create. Count per source rather than globally: independent organization
 * branches remain representable even when the app has many destinations in
 * total.
 */
function reverseOwnerDestinationLimit(doc: BlueprintDoc): ValidationError[] {
	const destinations = new Set<string>();
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			const owner = operation.owner;
			if (
				owner?.kind === "term" &&
				owner.term.kind === "owner-location-at-level"
			) {
				destinations.add(owner.term.levelUuid);
			}
		}
	}
	const levels = organizationLevelsOf(doc);
	const bySource = new Map<string, OrganizationLevel[]>();
	for (const destinationUuid of destinations) {
		const destination = levels[destinationUuid];
		if (destination === undefined) continue;
		const source = ancestorLevels(destination, levels).find(levelOwnsCases);
		if (source === undefined) continue;
		const entries = bySource.get(source.uuid) ?? [];
		entries.push(destination);
		bySource.set(source.uuid, entries);
	}
	const branchSize = (sourceUuid: string, visiting: Set<string>): number => {
		if (visiting.has(sourceUuid)) return 0;
		const nextVisiting = new Set(visiting).add(sourceUuid);
		return (bySource.get(sourceUuid) ?? []).reduce(
			(total, destination) =>
				total + 1 + branchSize(destination.uuid, nextVisiting),
			0,
		);
	};
	for (const source of Object.values(levels)) {
		const count = branchSize(source.uuid, new Set());
		if (count <= MAX_ATOMIC_LOCATION_DESCENDANTS) continue;
		return [
			validationError(
				"ORGANIZATION_REVERSE_OWNER_DESTINATION_LIMIT",
				"app",
				`A new ${source.name} place would require ${count} reverse-hop owner destinations, but Nova can create at most ${MAX_ATOMIC_LOCATION_DESCENDANTS} required descendants atomically. Reuse destination levels or use fixed place owners so every future place can still be created.`,
				{},
				{ sourceLevelUuid: source.uuid, destinationCount: String(count) },
			),
		];
	}
	return [];
}

function levelIdentities(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const codes = new Set<string>();
	const names = new Set<string>();
	for (const level of Object.values(organizationLevelsOf(doc))) {
		if (codes.has(level.code)) {
			errors.push(
				validationError(
					"ORGANIZATION_LEVEL_CODE_DUPLICATE",
					"app",
					`Two levels both use the code "${level.code}". A level's code is how expressions and the device tell one level from another, so each needs its own.`,
					{},
					{ code: level.code },
				),
			);
		}
		codes.add(level.code);

		const key = nameKey(level.name);
		if (names.has(key)) {
			errors.push(
				validationError(
					"ORGANIZATION_LEVEL_NAME_DUPLICATE",
					"app",
					`Two levels are both called "${level.name}". Give each level a name of its own — otherwise there's no way to tell them apart when placing a location.`,
					{},
					{ name: level.name },
				),
			);
		}
		names.add(key);
	}
	return errors;
}

/**
 * The parent chain resolves and terminates.
 *
 * A dangling parent is unbuildable; a cycle would hang every ancestor
 * walk in the emitter and the fixture. HQ enforces the same acyclicity
 * (`tree_utils.py::assert_no_cycles`) in Python only — there is no
 * database constraint — so it is genuinely reachable rather than
 * theoretical.
 */
function levelHierarchy(doc: BlueprintDoc): ValidationError[] {
	const levels = organizationLevelsOf(doc);
	const errors: ValidationError[] = [];
	for (const level of Object.values(levels)) {
		const parentUuid = level.parentLevelUuid;
		if (parentUuid === undefined) continue;
		if (levels[parentUuid] === undefined) {
			errors.push(
				validationError(
					"ORGANIZATION_LEVEL_PARENT_UNKNOWN",
					"app",
					`"${level.name}" sits under a level that no longer exists. Choose the level it belongs under, or make it a top level.`,
					{},
					{ level: level.name },
				),
			);
			continue;
		}
		// The general ancestor helper deliberately stops BEFORE a repeated node
		// because callers need a total walk over repairable documents. Validation
		// keeps its own seen set so the repeated edge itself remains observable.
		const seen = new Set<string>([level.uuid]);
		let current: OrganizationLevel | undefined = level;
		let cyclic = false;
		while (current?.parentLevelUuid !== undefined) {
			if (seen.has(current.parentLevelUuid)) {
				cyclic = true;
				break;
			}
			seen.add(current.parentLevelUuid);
			current = levels[current.parentLevelUuid];
		}
		if (cyclic) {
			errors.push(
				validationError(
					"ORGANIZATION_LEVEL_CYCLE",
					"app",
					`"${level.name}" ends up under itself. Levels run top to bottom, so following one upward has to reach a top level eventually.`,
					{},
					{ level: level.name },
				),
			);
		}
	}
	return errors;
}

/**
 * Every level a level names is a level, and the two that must be
 * ancestors are ancestors.
 *
 * `shared-branch`'s starting point and the depth caps are directions
 * through the hierarchy, so pointing them sideways or downward describes
 * a walk that does not exist. HQ's own fixture query lists exactly this
 * as an undefined outcome — "expand_from could point to a location that
 * is not an ancestor" — and then does not check it.
 */
function levelReferences(doc: BlueprintDoc): ValidationError[] {
	const levels = organizationLevelsOf(doc);
	const errors: ValidationError[] = [];

	const unknown = (level: { name: string }, what: string) =>
		validationError(
			"ORGANIZATION_LEVEL_REFERENCE_UNKNOWN",
			"app",
			`"${level.name}" ${what} a level that no longer exists. Pick one that does.`,
			{},
			{ level: level.name },
		);

	/**
	 * A depth cap names how far DOWN a walk reaches, so it must be the level
	 * itself or one below it. Pointing one at an ancestor is not merely odd: it
	 * compiles to an `expand_to` naming a level that is not below the assigned
	 * type, which `get_location_fixture_ids.sql` resolves as a depth that clips
	 * the worker's own branch to nothing — a silently empty address book from an
	 * app the gate called valid.
	 */
	const notBelow = (level: { name: string }, target: string, what: string) => {
		const named = levels[target];
		return validationError(
			"ORGANIZATION_LEVEL_CAP_NOT_BELOW",
			"app",
			`"${level.name}" ${what} ${named === undefined ? "a level" : `"${named.name}"`}, which isn't below it. A depth limit has to name the level itself or one under it.`,
			{},
			{ level: level.name },
		);
	};

	const isSelfOrBelow = (level: OrganizationLevel, target: string): boolean => {
		if (target === level.uuid) return true;
		const candidate = levels[target];
		if (candidate === undefined) return false;
		return ancestorLevels(candidate, levels).some(
			(ancestor) => ancestor.uuid === level.uuid,
		);
	};

	for (const level of Object.values(levels)) {
		const above = new Set(
			ancestorLevels(level, levels).map((ancestor) => ancestor.uuid),
		);

		const flow = level.caseFlow;
		if (
			flow.workers === "assigned" &&
			flow.descendantCases.kind === "down-to"
		) {
			const target = flow.descendantCases.levelUuid;
			if (levels[target] === undefined) {
				errors.push(unknown(level, "sends cases down to"));
			} else if (!isSelfOrBelow(level, target)) {
				errors.push(notBelow(level, target, "sends cases down to"));
			}
		}

		const book = level.addressBook;
		if (book.reach === "own-branch-limited") {
			const selected = new Set(book.levelUuids);
			if (!selected.has(level.uuid)) {
				errors.push(
					validationError(
						"ORGANIZATION_LEVEL_SCOPE_GAP",
						"app",
						`"${level.name}" limits its address book without including its own level. Include ${level.name} so the assigned place itself reaches the device.`,
						{},
						{ level: level.name },
					),
				);
			}
			for (const uuid of book.levelUuids) {
				if (levels[uuid] === undefined) {
					errors.push(unknown(level, "limits its address book to"));
				} else if (!isSelfOrBelow(level, uuid)) {
					errors.push(notBelow(level, uuid, "limits its address book to"));
				} else {
					const candidate = levels[uuid];
					const missing = ancestorLevels(candidate, levels).find(
						(ancestor) =>
							ancestor.uuid !== level.uuid &&
							isSelfOrBelow(level, ancestor.uuid) &&
							!selected.has(ancestor.uuid),
					);
					if (missing !== undefined) {
						errors.push(
							validationError(
								"ORGANIZATION_LEVEL_SCOPE_GAP",
								"app",
								`"${level.name}" carries ${candidate.name} places but skips ${missing.name} on the way there. Include every level in between so CommCare can traverse the branch.`,
								{},
								{ level: level.name },
							),
						);
					}
				}
			}
		} else if (
			book.reach === "own-branch" &&
			book.downToLevelUuid !== undefined
		) {
			if (levels[book.downToLevelUuid] === undefined) {
				errors.push(unknown(level, "stops its address book at"));
			} else if (!isSelfOrBelow(level, book.downToLevelUuid)) {
				errors.push(
					notBelow(level, book.downToLevelUuid, "stops its address book at"),
				);
			}
		}

		if (book.reach === "shared-branch") {
			if (levels[book.fromLevelUuid] === undefined) {
				errors.push(unknown(level, "starts its address book from"));
			} else if (!above.has(book.fromLevelUuid)) {
				const from = levels[book.fromLevelUuid];
				errors.push(
					validationError(
						"ORGANIZATION_LEVEL_SCOPE_NOT_ANCESTOR",
						"app",
						`"${level.name}" starts its address book from "${from.name}", which isn't above it. An address book widens by starting further up, so pick a level "${level.name}" sits under.`,
						{},
						{ level: level.name },
					),
				);
			}
			if (book.downToLevelUuid !== undefined) {
				const from = levels[book.fromLevelUuid];
				if (levels[book.downToLevelUuid] === undefined) {
					errors.push(unknown(level, "stops its address book at"));
				} else if (
					from !== undefined &&
					!isSelfOrBelow(from, book.downToLevelUuid)
				) {
					errors.push(
						notBelow(from, book.downToLevelUuid, "stops its address book at"),
					);
				}
			}
		}

		if (
			book.reach === "whole-organization" &&
			book.downToLevelUuid !== undefined &&
			levels[book.downToLevelUuid] === undefined
		) {
			errors.push(unknown(level, "stops its address book at"));
		}

		if (
			(book.reach === "own-branch" || book.reach === "own-branch-limited") &&
			book.alsoIncludeTopDownToLevelUuid !== undefined &&
			levels[book.alsoIncludeTopDownToLevelUuid] === undefined
		) {
			errors.push(unknown(level, "also carries the organization down to"));
		}
	}
	return errors;
}

function locationPropertyIdentities(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const claimed = new Set<string>();
	for (const property of Object.values(locationPropertiesOf(doc))) {
		// Deliberately the user-property rule, not a copy of it. HQ runs one
		// `custom_data_fields` machinery for both field types and splits them
		// only by `field_type`, so the legality is genuinely the same rule —
		// a second implementation could only drift from it.
		const verdict = userPropertySlugVerdict(property.slug, claimed);
		claimed.add(property.slug);
		if (verdict.ok) continue;
		errors.push(
			validationError(
				verdict.code === "duplicate"
					? "LOCATION_PROPERTY_SLUG_DUPLICATE"
					: "LOCATION_PROPERTY_SLUG_INVALID",
				"app",
				`"${property.label}" saves under the name "${property.slug}", which CommCare won't accept. ${verdict.userMessage}`,
				{},
				{ slug: property.slug },
			),
		);
	}
	return errors;
}

function locationPropertyLevels(doc: BlueprintDoc): ValidationError[] {
	const levels = organizationLevelsOf(doc);
	const errors: ValidationError[] = [];
	for (const property of Object.values(locationPropertiesOf(doc))) {
		for (const uuid of property.levelUuids ?? []) {
			if (levels[uuid] === undefined) {
				errors.push(
					validationError(
						"LOCATION_PROPERTY_LEVEL_UNKNOWN",
						"app",
						`"${property.label}" applies to a level that no longer exists. Choose the levels it applies to, or let it apply everywhere.`,
						{},
						{ slug: property.slug },
					),
				);
			}
		}
	}
	return errors;
}

/**
 * Required catalog entries have to fit in the same bounded value bag every
 * place write uses. Count their actual overlap per level: many optional or
 * disjoint properties remain legal, while an impossible required row never
 * reaches either the Builder or a locations-store refusal.
 */
function locationPropertyRequiredCapacity(
	doc: BlueprintDoc,
): ValidationError[] {
	const properties = Object.values(locationPropertiesOf(doc));
	const levels = Object.values(organizationLevelsOf(doc));
	const overCapacity = levels.find((level) => {
		let required = 0;
		for (const property of properties) {
			if (property.required !== true) continue;
			if (
				property.levelUuids !== undefined &&
				!property.levelUuids.includes(level.uuid)
			)
				continue;
			required += 1;
			if (required > MAX_LOCATION_VALUES) return true;
		}
		return false;
	});
	if (overCapacity !== undefined) {
		return [
			validationError(
				"LOCATION_PROPERTY_REQUIRED_CAPACITY",
				"app",
				`Places at "${overCapacity.name}" would require more than ${MAX_LOCATION_VALUES} pieces of information, but one place can store at most ${MAX_LOCATION_VALUES}. Make some optional or narrow which levels they apply to.`,
				{},
			),
		];
	}

	// With no levels yet, universally required fields still constrain every
	// future level. Refuse a catalog that would make adding the first rung a
	// dead end rather than waiting for that later gesture to fail.
	const universalRequired = properties.filter(
		(property) =>
			property.required === true && property.levelUuids === undefined,
	).length;
	return universalRequired > MAX_LOCATION_VALUES
		? [
				validationError(
					"LOCATION_PROPERTY_REQUIRED_CAPACITY",
					"app",
					`Every place would require ${universalRequired} pieces of information, but one place can store at most ${MAX_LOCATION_VALUES}. Make some optional before adding more.`,
					{},
				),
			]
		: [];
}

/**
 * A persona's primary place is not repeated in the rest of its list.
 *
 * HQ's `CommCareUserResource` takes `primary_location` and `locations`
 * together and requires the primary to appear in the list, so Nova emits
 * the primary followed by the others — a primary that also appeared among
 * the others would send it twice. The rest of the assignment's integrity
 * (that these uuids name live, unarchived places) is proved in the commit
 * transaction, since only the store knows.
 */
function personaAssignments(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const persona of Object.values(personasOf(doc))) {
		const locations = persona.locations;
		if (locations === undefined) continue;
		const additional = locations.additionalUuids ?? [];
		// One place, listed twice, in either position. Both send the same
		// location to CommCare twice — the primary-repeated case is just the one
		// that is easy to notice.
		if (
			additional.includes(locations.primaryUuid) ||
			new Set(additional).size !== additional.length
		) {
			errors.push(
				validationError(
					"PERSONA_LOCATION_PRIMARY_REPEATED",
					"app",
					`${persona.name} has the same place listed twice. Their main place is always included, so list each other place once.`,
					{},
					{ name: persona.name },
				),
			);
		}
	}
	return errors;
}

export const ORGANIZATION_RULES = [
	levelIdentities,
	levelHierarchy,
	levelReferences,
	reverseOwnerDestinationLimit,
	locationPropertyIdentities,
	locationPropertyLevels,
	locationPropertyRequiredCapacity,
	personaAssignments,
];
