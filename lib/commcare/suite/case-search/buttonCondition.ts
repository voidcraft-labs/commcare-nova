import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	moduleHasCaseListMenuItem,
	type Uuid,
} from "@/lib/domain";
import { effectivePostSubmit } from "@/lib/domain/postSubmit";
import { moduleExpressionContexts } from "../../expressionContext";
import {
	caseListSessionDatums,
	entrySessionDatums,
	type FormLinkProjectionContext,
	formLinkProjectionContext,
	moduleDestinationFrameChildren,
	moduleIndexOf,
	parentMenuDestinationFrameChildren,
	previousFrameChildren,
	projectAfterSubmit,
} from "../../formLinkProjection";
import { identityLookupWireNaming } from "../../lookup/naming";
import {
	buildStackElement,
	deriveFormLinkStack,
	derivePostSubmitStack,
	type SessionDatum,
} from "../../session";
import { InstanceSink } from "../../xpath/wire/instances";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import { searchActionRelevant } from "../case-list/shortDetail";
import { moduleUsesInlineSearch } from "./inlineSearch";

/**
 * The instances a menu's Search button condition reads that CommCare HQ's
 * build does not declare on some entry that shows the menu's case list, by
 * id, in reading order.
 *
 * HQ writes the condition as the Search action's `relevant` unchanged
 * (`sections/details.py::DetailContributor._get_relevant_expression`), but
 * declares an entry's instances from the XPath it collects for that entry
 * (`post_process/instances.py::_get_all_xpaths_for_entry`): its datums, the
 * details they show, its assertions and its stack's frames, where a detail's
 * part (`xml_models.py::Detail.get_all_xpaths`) collects each action's frames
 * and never an action's `relevant`. Core decides whether the button shows in
 * the scope of the entry the worker is in (`Detail.getCustomActions` →
 * `CommCareSession.getEvaluationContext`), and a read of an instance that
 * scope lacks throws, so the list does not open.
 *
 * Every entry whose datum shows the list (`detail-select` the menu's
 * `m{N}_case_short`) is counted: the case list's own entry
 * (`Module.caseListMenuItem`) by its datums, and each form's entry by its
 * datums and the frames its after-submit writes (the same projections the
 * compiler's `deriveEntryDefinition` renders, so a form returning to the list
 * with its case declares the session there). An instance only a list column,
 * an assertion or a return frame brings onto the entry is not counted, so a
 * condition reading one is refused where HQ might still declare it. A table
 * is named by its own id (`identityLookupWireNaming`), so two reads of one
 * table meet at one id. A menu whose forms read the search has no Search
 * button, so nothing is read there.
 */
export function searchButtonUndeclaredInstances(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly string[] {
	const mod = doc.modules[moduleUuid];
	if (mod === undefined || mod.caseType === undefined) return [];
	if (moduleUsesInlineSearch(mod)) return [];
	const condition =
		effectiveCaseSearchConfig(mod)?.searchButtonDisplayCondition;
	if (condition === undefined) return [];
	const naming = identityLookupWireNaming();
	const read = idsOf(
		searchActionRelevant(
			condition,
			moduleExpressionContexts(doc, moduleUuid, naming),
			naming,
		),
	);
	if (read.length === 0) return [];
	const ctx = formLinkProjectionContext(doc, { lookupNaming: naming });
	// The list's own selection is on every entry that shows the list.
	const selection = datumIds(caseListSessionDatums(doc, ctx, moduleUuid));
	if (read.every((id) => selection.has(id))) return [];
	const detail = `m${moduleIndexOf(ctx, moduleUuid)}_case_short`;
	const scopes = listEntryScopes(doc, ctx, detail);
	if (scopes.length === 0) return read.filter((id) => !selection.has(id));
	return read.filter((id) => scopes.some((scope) => !scope.has(id)));
}

/** The instances each entry that shows the list `detail` declares, as far as
 *  its datums and its after-submit frames read them. */
function listEntryScopes(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	detail: string,
): Set<string>[] {
	const shows = (datums: readonly SessionDatum[]) =>
		datums.some((datum) => datum.detailSelect === detail);
	const scopes: Set<string>[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) continue;
		if (moduleHasCaseListMenuItem(mod)) {
			const datums = caseListSessionDatums(doc, ctx, moduleUuid);
			if (shows(datums)) scopes.push(datumIds(datums));
		}
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const datums = entrySessionDatums(doc, ctx, moduleUuid, formUuid);
			if (!shows(datums)) continue;
			const scope = datumIds(datums);
			for (const id of stackIds(doc, ctx, moduleUuid, formUuid)) scope.add(id);
			scopes.push(scope);
		}
	}
	return scopes;
}

/** The instances a form entry's after-submit frames read, projected as the
 *  compiler projects them (`compiler.ts`, `deriveEntryDefinition`). */
function stackIds(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
	moduleUuid: Uuid,
	formUuid: Uuid,
): readonly string[] {
	const postSubmit = effectivePostSubmit(doc, formUuid) ?? "app_home";
	const links = projectAfterSubmit(doc, ctx, formUuid);
	const destination =
		links === undefined
			? postSubmit
			: links.fallback.kind === "built-in"
				? links.fallback.destination
				: undefined;
	const previousFrame =
		destination === "previous"
			? previousFrameChildren(doc, ctx, moduleUuid, formUuid)
			: [];
	const moduleFrame = moduleDestinationFrameChildren(doc, ctx, moduleUuid);
	const parentFrame =
		destination === "parentMenu"
			? parentMenuDestinationFrameChildren(doc, ctx, moduleUuid)
			: [];
	const moduleIndex = moduleIndexOf(ctx, moduleUuid);
	const operations =
		links === undefined
			? derivePostSubmitStack(
					postSubmit,
					moduleIndex,
					previousFrame,
					moduleFrame,
					parentFrame,
				)
			: deriveFormLinkStack(
					links,
					moduleIndex,
					previousFrame,
					moduleFrame,
					parentFrame,
				);
	const sink = new InstanceSink();
	buildStackElement(operations, { mode: { target: "suite" }, instances: sink });
	return sink.declarations().map((declaration) => declaration.id);
}

function datumIds(datums: readonly SessionDatum[]): Set<string> {
	const ids = new Set<string>();
	for (const datum of datums) {
		if (datum.nodeset !== undefined)
			for (const id of idsOf(datum.nodeset)) ids.add(id);
		if (datum.function !== undefined)
			for (const id of idsOf(datum.function)) ids.add(id);
	}
	return ids;
}

function idsOf(expr: WireExpr): string[] {
	return [
		...new Set(
			[...serializeWire(expr, { target: "suite" }).instances].map(
				(instance) => instance.id,
			),
		),
	];
}
