/**
 * Compact blueprint-summary renderer. Walks `BlueprintDoc` directly and
 * emits domain-vocabulary text (`field`, `kind`, `caseWrite`) — no
 * CommCare wire terms. The SA prompt composer and the MCP `get_app`
 * tool both consume this so the two surfaces show one canonical
 * domain-vocabulary view of an app.
 */

import {
	countFieldsUnder,
	orderedFieldUuids,
	orderedFormUuids,
} from "@/lib/doc/fieldWalk";
import { unwrittenProperties } from "@/lib/doc/unwrittenProperties";
import type {
	BlueprintDoc,
	CaseTileLayout,
	Column,
	Module,
	SearchInputDef,
	Uuid,
} from "@/lib/domain";
import {
	assignedLocationUuids,
	childModuleUuids,
	fieldCaseWrite,
	isContainer,
	isOwnerOnlyCaseSearchConfig,
	moduleSiblingUuids,
	orderedColumns,
	orderedLocationProperties,
	orderedOrganizationLevels,
	orderedPersonas,
	orderedUserProperties,
	orderedUserTypes,
	ownRecordValue,
	tileCellFor,
	userPropertiesOf,
	userTypesOf,
} from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import { unwrittenPropertiesReminder } from "./systemReminder";
import {
	ADVANCED_SLOT_NAMES,
	DISPLAY_SLOT_NAMES,
} from "./tools/case-search-config/shared";

/**
 * Render a field and its children as nested bullet lines. Shows `id`,
 * `kind`, and the `label` / `caseWrite` hints when present. Nested
 * containers indent their children by two spaces per level so depth is
 * visually obvious.
 */
function summarizeField(
	doc: BlueprintDoc,
	uuid: Uuid,
	indent: string,
): string | undefined {
	const field = doc.fields[uuid];
	if (!field) return undefined;
	// `label` is absent on hidden, `caseWrite` is absent on
	// structural/media kinds and on non-case fields — render each
	// piece only when it's meaningful.
	const pieces: string[] = [
		`${indent}- ${field.id} [uuid ${field.uuid}] (${field.kind})`,
	];
	// `label` is a `ProseTemplate`, so it has to be projected against the
	// owning document rather than interpolated — a template dropped into a
	// template literal stringifies to `[object Object]`, which would make
	// every field in the app indistinguishable to whoever reads this summary.
	if ("label" in field && field.label) {
		pieces[0] += `: "${projectProseTemplate(field.label, doc).text}"`;
	}
	const write = fieldCaseWrite(field);
	if (write) pieces[0] += ` → ${write.caseType}.${write.property}`;
	if (isContainer(field)) {
		const children = orderedFieldUuids(doc, uuid);
		const childLines = children
			.map((c) => summarizeField(doc, c, `${indent}  `))
			.filter((s): s is string => typeof s === "string");
		if (childLines.length > 0) pieces.push(childLines.join("\n"));
	}
	return pieces.join("\n");
}

/** Summarize one form: name, uuid, type, field count, nested field list. */
function summarizeForm(doc: BlueprintDoc, formUuid: Uuid): string {
	const form = doc.forms[formUuid];
	if (!form) return `  - Missing form [uuid ${formUuid}]`;
	const count = countFieldsUnder(doc, formUuid);
	const header = `  - Form "${form.name}" [uuid ${formUuid}] (${form.type}, ${count} field${count === 1 ? "" : "s"})`;
	const extras: string[] = [];
	if (form.postSubmit) extras.push(`    post_submit: ${form.postSubmit}`);
	if (form.connect) extras.push("    [Connect enabled]");
	if (form.closeCondition) {
		const op =
			form.closeCondition.operator === "selected" ? "has selected" : "=";
		// The SA speaks field ids — project the stored uuid through the current
		// field. Never expose or reinterpret the uuid as a friendly id.
		const closeFieldId =
			doc.fields[form.closeCondition.field]?.id ?? "<missing field>";
		extras.push(
			`    close_condition: ${closeFieldId} ${op} "${form.closeCondition.answer}"`,
		);
	}
	const topLevelFields = orderedFieldUuids(doc, formUuid);
	const fieldSummary =
		topLevelFields.length > 0
			? topLevelFields
					.map((u) => summarizeField(doc, u, "    "))
					.filter((s): s is string => typeof s === "string")
					.join("\n")
			: "    (no fields)";
	return [header, ...extras, fieldSummary].join("\n");
}

/**
 * Summarize a module's case list — selection behavior plus every column and search input
 * carries its `uuid`, the SA-facing handle for the atomic-op tools
 * (`updateCaseListColumn`, `removeCaseListColumn`,
 * `reorderCaseListColumns`, and the search-input parallels). Surfacing
 * the uuids in the prompt-time summary lets the SA target follow-up
 * edits without a `getModule` round-trip after a fresh-session edit
 * resume.
 *
 * Returns `undefined` when the module has no case-list config (survey-
 * only modules; freshly created case-carrying modules). Caller
 * concatenates only when a section was produced.
 */
function summarizeCaseList(mod: Module): string | undefined {
	const config = mod.caseListConfig;
	if (config === undefined) return undefined;
	if (
		config.columns.length === 0 &&
		config.searchInputs.length === 0 &&
		config.selection === undefined
	) {
		return undefined;
	}
	const lines: string[] = ["    case_list:"];
	if (config.selection !== undefined) {
		lines.push(
			`      selection: workers choose up to ${config.selection.maximum} ${config.selection.maximum === 1 ? "case" : "cases"} before continuing`,
		);
	}
	if (config.tile !== undefined) {
		lines.push(
			`      layout: tile${config.tile.persistOnForms === true ? " (kept above every form)" : ""}`,
		);
		// Grouping changes what a placement MEANS — a cell in the header band
		// is drawn once per group, from the group's first case — so a read
		// surface that reported the cells without it would have the model
		// rearranging a tile it does not know the shape of. Both consequences
		// it cannot infer ride along for the same reason.
		const grouping = config.tile.grouping;
		if (grouping !== undefined) {
			lines.push(
				`      grouped_by: ${grouping.identifier} connection, top ${grouping.headerRows === 1 ? "row is" : `${grouping.headerRows} rows are`} the group heading (drawn once per group from its first case; choosing a group opens that first case; cases with no ${grouping.identifier} connection are one group)`,
			);
		}
	}
	// Each screen reads its OWN sequence: the summary is what the SA reasons
	// about arrangement from, so a storage-order read would have it move the
	// wrong row.
	const results = orderedColumns(config, "list").filter(
		(column) => column.visibleInList !== false,
	);
	const details = orderedColumns(config, "detail").filter(
		(column) => column.visibleInDetail !== false,
	);
	if (results.length > 0) {
		lines.push("      results:");
		for (const col of results) {
			// A placement is reported only where the tile actually draws it, so
			// `tileCellFor` decides here exactly as it does for the wire. A stored
			// cell the layout does not draw is deliberately silent: telling the
			// model a field sits at 4,0 when nothing renders there makes it reason
			// around an obstacle that is not on the grid.
			lines.push(`        - ${formatColumn(col, tilePlace(col, config.tile))}`);
		}
	}
	if (details.length > 0) {
		lines.push("      details:");
		for (const col of details) {
			// Details is never a tile — long-detail tiles are out of scope by
			// contract — so no placement is reported here even when the column
			// carries one for Results.
			lines.push(`        - ${formatColumn(col, "")}`);
		}
	}
	const dormant = orderedColumns(config, "list").filter(
		(column) =>
			column.visibleInList === false && column.visibleInDetail === false,
	);
	if (dormant.length > 0) {
		lines.push("      saved_off_screen:");
		for (const col of dormant) {
			lines.push(`        - ${formatColumn(col, "")}`);
		}
	}
	const sortedColumns = orderedColumns(config, "list")
		.filter((column) => column.sort !== undefined)
		// Priority decides the order; Results position breaks a tie, which is what
		// the author sees when two carriers share a priority — so the walk starts
		// in the Results sequence and leans on `sort` being stable. The wire
		// (`suite/case-list/sortKeys.ts`) ties the same way, and a tied pair the
		// SA reads here has to match what it emits.
		.sort((a, b) => (a.sort?.priority ?? 0) - (b.sort?.priority ?? 0));
	if (sortedColumns.length > 0) {
		lines.push("      default_order:");
		for (const col of sortedColumns) {
			lines.push(
				`        - ${col.uuid}: "${col.header}" (${col.sort?.direction === "asc" ? "ascending" : "descending"})`,
			);
		}
	}
	if (config.searchInputs.length > 0) {
		lines.push("      search_inputs:");
		for (const input of [...config.searchInputs]) {
			lines.push(`        - ${formatSearchInput(input)}`);
		}
	}
	if (config.filter !== undefined) {
		lines.push(`      filter: (predicate kind: ${config.filter.kind})`);
	}
	return lines.join("\n");
}

/**
 * The ` @ x,y WxH` suffix for a column that DRAWS a square, or `""`.
 *
 * `tileCellFor` decides, exactly as the three emission paths do, so the SA is
 * never told a field occupies a square the wire leaves empty. A placement
 * reported for a column the tile does not draw would make the model route
 * around an obstacle that is not on the grid, and refuse its own next layout
 * for an overlap that does not exist. Rearranging a tile means knowing every
 * OTHER cell — two may never overlap — so the drawn ones are reported in full
 * rather than withheld.
 *
 * A case list with no drawn placements renders byte-identically to before,
 * which keeps every untiled app's prompt prefix cacheable.
 */
function tilePlace(col: Column, layout: CaseTileLayout | undefined): string {
	const cell = tileCellFor(col, layout);
	return cell === undefined
		? ""
		: ` @ ${cell.x},${cell.y} ${cell.width}x${cell.height}`;
}

/** One-line column summary — uuid + kind + header + per-kind hint, plus the
 *  tile placement suffix the caller resolved (empty on Details, which is never
 *  a tile). */
function formatColumn(col: Column, place: string): string {
	const body =
		col.kind === "calculated"
			? `(${col.kind}) "${col.header}"`
			: `(${col.kind}) ${col.field} → "${col.header}"`;
	return `${col.uuid}: ${body}${place}`;
}

/** One-line search-input summary — uuid + kind + name + label hint. */
function formatSearchInput(input: SearchInputDef): string {
	const body =
		input.kind === "simple"
			? `(simple) ${input.name} → ${input.property} (${input.type}, "${input.label}")`
			: `(advanced) ${input.name} (${input.type}, "${input.label}")`;
	return `${input.uuid}: ${body}`;
}

/**
 * Summarize a module's case-search config in one line so a fresh-
 * session SA reading the edit-mode prompt can confirm which display
 * labels are set and whether any advanced filters are authored
 * without a `getModule` round-trip. Returns `undefined` when the
 * module has no case-search config — caller concatenates only when a
 * section was produced.
 *
 * Output shape:
 *
 *   `case_search: display={titleSet,subtitleSet,…} advanced={excludedOwnerIds|none}`
 *
 * Display cluster summary: comma-separated list of the slot names that
 * are non-undefined; `none` when every slot is cleared. Advanced
 * cluster summary: names each authored slot (the excluded-owners
 * filter); `none` when no advanced filter is set. The one-liner stays
 * at a fixed width to keep the prompt cheap.
 */
function summarizeCaseSearch(mod: Module): string | undefined {
	const config = mod.caseSearchConfig;
	if (config === undefined) return undefined;
	if (isOwnerOnlyCaseSearchConfig(config)) {
		return "    case_search: disabled owner-availability={excludedOwnerIds}";
	}
	// Both summaries iterate the source-of-truth tuples that the SA
	// tool surface partitions on. A new slot landing on either tuple
	// flows into the SA's app-state summary here automatically — no
	// per-slot `config.foo !== undefined` check to drift out of sync
	// with the schema.
	const setDisplaySlots = DISPLAY_SLOT_NAMES.filter(
		(slot) => config[slot] !== undefined,
	);
	const displaySummary =
		setDisplaySlots.length === 0
			? "display={none}"
			: `display={${setDisplaySlots.join(", ")}}`;
	const setAdvancedSlots = ADVANCED_SLOT_NAMES.filter(
		(slot) => config[slot] !== undefined,
	);
	const advancedSummary =
		setAdvancedSlots.length === 0
			? "advanced={none}"
			: `advanced={${setAdvancedSlots.join(", ")}}`;
	return `    case_search: ${displaySummary} ${advancedSummary}`;
}

function indentBlock(block: string, indent: string): string {
	return block
		.split("\n")
		.map((line) => `${indent}${line}`)
		.join("\n");
}

/** Summarize a module: menu placement, name, case type, forms. */
function summarizeModule(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	indent = "",
): string {
	const mod = doc.modules[moduleUuid];
	if (!mod) return `${indent}- Missing module [uuid ${moduleUuid}]`;
	const caseInfo = mod.caseType ? ` (case_type: ${mod.caseType})` : "";
	const listOnly = mod.caseListOnly ? " [case list only]" : "";
	const parentInfo =
		mod.parentModuleUuid === undefined
			? " [top-level menu]"
			: ` [child menu of uuid ${mod.parentModuleUuid}]`;
	const header = `${indent}- Module "${mod.name}" [uuid ${moduleUuid}]${parentInfo}${caseInfo}${listOnly}`;
	const sections: string[] = [header];
	const caseList = summarizeCaseList(mod);
	if (caseList) sections.push(indentBlock(caseList, indent));
	const caseSearch = summarizeCaseSearch(mod);
	if (caseSearch) sections.push(indentBlock(caseSearch, indent));
	const formUuids = orderedFormUuids(doc, moduleUuid);
	const forms = formUuids.map((fUuid) => summarizeForm(doc, fUuid)).join("\n");
	if (forms) sections.push(indentBlock(forms, indent));
	return sections.join("\n");
}

/**
 * Produce the compact text summary of the app that lands in the SA's
 * edit-mode prompt. Reads from the normalized doc directly.
 */
export function summarizeBlueprint(doc: BlueprintDoc): string {
	const lines: string[] = [];

	lines.push(`### App: "${doc.appName}"`);
	if (doc.connectType) lines.push(`Connect type: ${doc.connectType}`);

	if (doc.caseTypes?.length) {
		lines.push("");
		lines.push("**Case types:**");
		for (const ct of doc.caseTypes) {
			const props = ct.properties.map((p) => p.name).join(", ");
			const parentInfo = ct.parent_type ? ` (child of ${ct.parent_type})` : "";
			lines.push(`- ${ct.name}${parentInfo}: ${props}`);
		}
	}

	const organizationLevels = orderedOrganizationLevels(doc);
	const locationProperties = orderedLocationProperties(doc);
	if (organizationLevels.length > 0 || locationProperties.length > 0) {
		lines.push("");
		lines.push("**Organization:**");
		if (organizationLevels.length > 0) {
			lines.push("  levels:");
			for (const level of organizationLevels) {
				lines.push(
					`    - "${level.name}" [uuid ${level.uuid}, code ${level.code}]${level.parentLevelUuid === undefined ? " root" : ` parent uuid ${level.parentLevelUuid}`}${level.caseFlow.workers === "assigned" ? " holds workers" : " no workers"}${level.caseFlow.ownsCases ? " owns cases" : " owns no cases"} case_flow=${JSON.stringify(level.caseFlow)} address_book=${JSON.stringify(level.addressBook)}`,
				);
			}
		}
		if (locationProperties.length > 0) {
			lines.push("  place_information:");
			for (const property of locationProperties) {
				lines.push(
					`    - ${property.slug}: ${JSON.stringify(property.label)} [uuid ${property.uuid}]${property.required === true ? " required" : ""}${property.choices === undefined ? "" : ` choices=${JSON.stringify(property.choices)}`}${property.levelUuids === undefined ? " all levels" : ` level_uuids=${JSON.stringify(property.levelUuids)}`}`,
				);
			}
		}
	}

	const userProperties = orderedUserProperties(doc);
	const userTypes = orderedUserTypes(doc);
	const personas = orderedPersonas(doc);
	if (
		userProperties.length > 0 ||
		userTypes.length > 0 ||
		personas.length > 0
	) {
		const propertyByUuid = userPropertiesOf(doc);
		const propertyOrder = new Map<string, number>(
			userProperties.map((property, index) => [property.uuid, index]),
		);
		const values = (bag: Record<string, string> | undefined) =>
			Object.entries(bag ?? {})
				.sort(
					([left], [right]) =>
						(propertyOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
							(propertyOrder.get(right) ?? Number.MAX_SAFE_INTEGER) ||
						left.localeCompare(right),
				)
				.map(
					([uuid, value]) =>
						`${ownRecordValue(propertyByUuid, uuid)?.slug ?? `<missing:${uuid}>`}=${JSON.stringify(value)} [property uuid ${uuid}]`,
				)
				.join(", ");
		lines.push("");
		lines.push("**Users and personas:**");
		if (userProperties.length > 0) {
			lines.push("  worker_information:");
			for (const property of userProperties) {
				lines.push(
					`    - ${property.slug}: ${JSON.stringify(property.label)} [uuid ${property.uuid}]${property.required === true ? " required" : ""}${property.choices === undefined ? "" : ` choices=${JSON.stringify(property.choices)}`}`,
				);
			}
		}
		if (userTypes.length > 0) {
			lines.push("  roles:");
			for (const role of userTypes) {
				const roleValues = values(role.values);
				lines.push(
					`    - "${role.name}" [uuid ${role.uuid}]${role.description === undefined ? "" : ` description=${JSON.stringify(role.description)}`}${roleValues === "" ? "" : ` values={${roleValues}}`}`,
				);
			}
		}
		if (personas.length > 0) {
			lines.push("  personas:");
			for (const persona of personas) {
				const role =
					persona.userTypeUuid === undefined
						? undefined
						: ownRecordValue(userTypesOf(doc), persona.userTypeUuid);
				const personaValues = values(persona.values);
				const locationUuids = assignedLocationUuids(persona.locations);
				lines.push(
					`    - "${persona.name}" [uuid ${persona.uuid}]${persona.description === undefined ? "" : ` description=${JSON.stringify(persona.description)}`}${role === undefined ? "" : ` role="${role.name}" [uuid ${role.uuid}]`}${personaValues === "" ? "" : ` overrides={${personaValues}}`}${locationUuids.length === 0 ? "" : ` locations=${JSON.stringify(locationUuids)} (first is main)`}`,
				);
			}
		}
	}

	lines.push("");
	lines.push("**Structure:**");
	// The authored preorder is rendered as the one-tier menu tree. Every
	// machine address remains a UUID; indentation is presentation only.
	for (const moduleUuid of moduleSiblingUuids(doc, null)) {
		lines.push(summarizeModule(doc, moduleUuid));
		for (const childUuid of childModuleUuids(doc, moduleUuid)) {
			lines.push(summarizeModule(doc, childUuid, "  "));
		}
	}

	// Ambient knowledge, not a finding: properties the app reads but no
	// form in it writes ride a closing system reminder so the SA holds
	// the fact while reasoning (get_app and the edit-mode prompt both
	// inherit this summary) without treating it as work to do or news
	// to announce.
	const unwritten = unwrittenProperties(doc);
	if (unwritten.length > 0) {
		lines.push("");
		lines.push(unwrittenPropertiesReminder(doc, unwritten));
	}

	return lines.join("\n");
}
