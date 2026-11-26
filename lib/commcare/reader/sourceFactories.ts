import {
	activeActions,
	isMultiSelectMenu,
	publishedCaseBlocks,
} from "../hq/publishedCaseBlocks";
import type { InstanceFactories } from "../xpath/instanceSources";
import type { DraftForm } from "./context";
import { isJsonObject } from "./jsonCursor";
import type { ReaderInput } from "./types";

const byReading = new WeakMap<ReaderInput, InstanceFactories>();

/** is_valid_results_instance_name consults all modules with a search_config,
 * even where that menu's search has been turned off. Report fixture aliases
 * use a working report UUID on the two v2 restore formats. HQ's source
 * scrubs those UUIDs, so an implicit slug cannot establish its worker identity. */
export function sourceFactories(input: ReaderInput): InstanceFactories {
	const known = byReading.get(input);
	if (known !== undefined) return known;
	const namedResults = new Set<string>();
	const scrubbedReportSlugs = new Set<string>();
	const raw = input.source.raw;
	const reportV2 =
		raw.mobile_ucr_restore_version === undefined ||
		raw.mobile_ucr_restore_version === "1.5" ||
		raw.mobile_ucr_restore_version === "2.0";
	if (Array.isArray(raw.modules)) {
		for (const menu of raw.modules) {
			if (!isJsonObject(menu)) continue;
			if (
				menu.doc_type === "Module" ||
				menu.doc_type === "AdvancedModule" ||
				menu.doc_type === "ShadowModule"
			) {
				const config = menu.search_config;
				if (
					isJsonObject(config) &&
					typeof config.instance_name === "string" &&
					config.instance_name !== ""
				)
					namedResults.add(`results:${config.instance_name}`);
			}
			if (
				reportV2 &&
				menu.doc_type === "ReportModule" &&
				Array.isArray(menu.report_configs)
			) {
				for (const report of menu.report_configs) {
					if (
						isJsonObject(report) &&
						typeof report.report_slug === "string" &&
						report.report_slug
					)
						scrubbedReportSlugs.add(report.report_slug);
				}
			}
		}
	}
	const facts = {
		namedResults,
		scrubbedReportSlugs,
		...input.sourceProjectFactories,
		observe: input.observeFactory,
	};
	byReading.set(input, facts);
	return facts;
}

/** Concrete Form/AdvancedForm build after FormBase.add_missing_instances.
 * Only generated case blocks can add native instances here. A Save to Case
 * block already in the attachment does not run these generators. */
export function generatedFormInstances(
	input: ReaderInput,
	form: DraftForm,
	uploads: ReadonlySet<string>,
): ReadonlyMap<string, string> {
	const added = new Map([["commcaresession", "jr://instance/session"]]);
	const raw = input.source.raw;
	const menu = Array.isArray(raw.modules) && raw.modules[form.menu];
	if (!isJsonObject(menu)) return added;
	const basic = form.docType === "Form";
	if (basic && isMultiSelectMenu(menu))
		added.set(
			"selected_cases",
			"jr://instance/selected-entities/selected_cases",
		);
	const actions = form.json.peek("actions");
	if (!isJsonObject(actions)) return added;
	const active = basic
		? activeActions(actions, form.json.peek("requires"))
		: new Set<string>();
	const loads = Array.isArray(actions.load_update_cases)
		? actions.load_update_cases
		: [];
	let casedb = basic
		? active.has("case_preload") || active.has("usercase_preload")
		: loads.some(
				(load) =>
					isJsonObject(load) &&
					isJsonObject(load.preload) &&
					Object.keys(load.preload).length > 0,
			);
	const blocks = publishedCaseBlocks(raw).forms.get(form.xmlns)?.blocks ?? [];
	for (const block of blocks) {
		if (block.kind === "save-to-case") continue;
		// _add_case_updates follows the parent path for basic own updates and
		// advanced loads. Subcase/open/usercase blocks directly add their updates.
		if (
			(block.kind === "basic-own" ||
				(block.kind === "advanced" && block.action === "load")) &&
			[...block.properties.keys()].some((key) => key.includes("/"))
		)
			casedb = true;
		// XFormCaseBlock.add_case_updates partitions exact upload refs into
		// attachment updates before applying any save-only-if-edited test.
		if (
			input.saveOnlyEditedApplied === true &&
			[...block.editOnly].some((key) => {
				const ref = block.properties.get(key);
				return ref !== undefined && !uploads.has(ref);
			})
		)
			casedb = true;
		if (
			raw.case_sharing !== true ||
			block.kind === "basic-usercase" ||
			block.ownerWritten
		)
			continue;
		const creates =
			block.kind === "basic-own"
				? block.opens
				: block.kind === "basic-subcase" ||
					(block.action === "open" &&
						(block.indices.length === 0 ||
							(!block.indices.some(
								(index) => index.relationship === "question",
							) &&
								block.indices.some(
									(index) => index.relationship === "child",
								))));
		if (creates) added.set("groups", "jr://fixture/user-groups");
	}
	if (casedb) added.set("casedb", "jr://instance/casedb");
	return added;
}
