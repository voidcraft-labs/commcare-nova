/**
 * Step 17, `deployment-lines` (part 09 §9): what each live deployment of an
 * app is told about its next publish. It writes nothing to the document;
 * it reads the target the steps left, with its holds, and what each
 * published deployment's baseline carries, and selects each deployment's
 * lines in the order of `DEPLOYMENT_NOTICE_REASONS`:
 *
 * - `deep-links-need-republish` on every live deployment of an app with
 *   entry points, since the horizon's `+1` makes every manifest's source
 *   sequence stale;
 * - `placements-kept-unread` on each published deployment whose baseline is
 *   unknown, whose every placement section 8 kept;
 * - `form-data-paths-move` on each published deployment where a case block
 *   or an answer path moves at its next publish, with how many forms and
 *   why;
 * - `case-attachments-stop` on each published deployment that received, or
 *   may have received, a capture written as a file on the case;
 * - `next-publish-asks-more` where the target needs a confirmation or a
 *   capability its last publish did not.
 *
 * A readable baseline's moves are read block by block: each block the
 * baseline carries that the head's HQ import file no longer writes at the
 * same identity, and each model-iteration row of a query repeat the head
 * writes in the count placement. An unknown baseline's are the units
 * section 8 left unheld for a class of §8.5, which the head moves. Each
 * cause is read from the unit today's placement put there.
 */

import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	commtrackReasons,
	PLAN_FEATURE_FOR_PRIVILEGE,
	requiredPlanFeatures,
} from "@/lib/commcare/planPrivileges";
import { sameTypeBasicChildCases } from "@/lib/commcare/sameTypeChildCases";
import { collectFieldLocations } from "@/lib/commcare/xform/caseOps";
import { orderedFieldUuids, orderedFormUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { entryPointInventory } from "@/lib/domain/entryPoints";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { formOfField } from "@/lib/domain/fieldForm";
import { effectiveQueryRepeatPlacement } from "@/lib/domain/queryRepeatPlacement";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import {
	caseAttachmentsStop,
	deepLinksNeedRepublish,
	formDataPathsMove,
	type NoticeDeployment,
	nextPublishAsksMore,
	placementsKeptUnread,
} from "./notice";
import type { RawDocument } from "./oldShape";
import {
	blockIdentity,
	headFormsOf,
	ownClosesMoved,
	placementIdentity,
	publishedFormOf,
	targetRowPaths,
	type UnitReading,
	unheldCause,
} from "./placements";
import {
	type LiftedFacts,
	PATH_MOVE_CAUSES,
	type PathMove,
	type PathMoveCause,
	type PublishedDeployment,
} from "./types";

/** What the deployment lines read. */
export interface DeploymentLinesInput {
	readonly raw: RawDocument;
	/** The document the steps left, holds included. */
	readonly target: BlueprintDoc;
	readonly facts: Pick<
		LiftedFacts,
		"todaysPlacements" | "attachmentFields" | "fieldWrites"
	>;
	/** Every unit as the placement step read it (`placements.ts::readUnits`). */
	readonly units: readonly UnitReading[];
	/** Every live deployment of the app, published or not. */
	readonly live: readonly NoticeDeployment[];
	/** Section 8.1's published deployments. */
	readonly published: readonly PublishedDeployment[];
	/** The document lines the steps wrote, for the repeats whose count node
	 *  leaves the wire (`repeat-count-node-removed`, Q3). */
	readonly documentNotice: readonly MigrationNoticeEntry[];
	/** The Project's lookup naming, for an app that reads a table. */
	readonly lookupNaming?: LookupWireNaming;
}

export interface DeploymentLines {
	readonly pathMoves: readonly PathMove[];
	readonly notice: readonly MigrationNoticeEntry[];
}

/** Every form of the target, in menu order. */
function formsInOrder(target: BlueprintDoc): Uuid[] {
	return target.moduleOrder.flatMap((moduleUuid) =>
		orderedFormUuids(target, moduleUuid).filter(
			(formUuid) => target.forms[formUuid] !== undefined,
		),
	);
}

/** Every query repeat of a form, in field order. */
function queryRepeatsOf(target: BlueprintDoc, formUuid: Uuid): Uuid[] {
	const out: Uuid[] = [];
	const walk = (parent: Uuid): void => {
		for (const fieldUuid of orderedFieldUuids(target, parent)) {
			const field = target.fields[fieldUuid];
			if (field?.kind === "repeat" && field.repeat_mode === "query_bound")
				out.push(fieldUuid);
			walk(fieldUuid);
		}
	};
	walk(formUuid);
	return out;
}

/** The forms whose repeat no longer carries its count node. */
function countNodeForms(
	target: BlueprintDoc,
	notice: readonly MigrationNoticeEntry[],
): ReadonlySet<Uuid> {
	const forms = new Set<Uuid>();
	for (const entry of notice) {
		if (
			entry.kind !== "document" ||
			entry.reason !== "repeat-count-node-removed" ||
			entry.entity.uuid === undefined
		)
			continue;
		const formUuid = formOfField(target, entry.entity.uuid as Uuid);
		if (formUuid !== undefined) forms.add(formUuid);
	}
	return forms;
}

/** A unit's cause, where it moves. */
function causeOf(reading: UnitReading | undefined): PathMoveCause {
	if (reading?.never === undefined) return "placement-simplified";
	return unheldCause(reading.never, reading.relationship);
}

/**
 * The causes of one form's moves on a readable baseline: each block the
 * baseline carries that the head writes nowhere at its identity, and each
 * model-iteration row of a query repeat the head now counts.
 */
function readableCauses(
	input: DeploymentLinesInput,
	deployment: PublishedDeployment,
	formUuid: Uuid,
): Set<PathMoveCause> {
	const causes = new Set<PathMoveCause>();
	const published = publishedFormOf(input.target, deployment, formUuid);
	if (published === undefined) return causes;
	const head = headFormsOf(input.target, deployment).get(published.xmlns);
	const headIdentities = new Set(
		(head?.blocks ?? []).map((block) => blockIdentity(block)),
	);
	const rows = targetRowPaths(input.target, formUuid);
	const units = input.units.filter((reading) => reading.formUuid === formUuid);
	const unitAt = new Map<string, UnitReading>();
	for (const reading of units) {
		const identity = placementIdentity(reading, reading.today, rows);
		if (identity !== undefined) unitAt.set(identity, reading);
	}
	for (const block of published.blocks) {
		const identity = blockIdentity(block);
		if (headIdentities.has(identity)) continue;
		const reading = unitAt.get(identity);
		// The inert basic subcase `main` wrote beside an extension's Save to
		// Case block names no unit of its own: it is the extension's.
		if (
			reading === undefined &&
			block.kind === "basic-subcase" &&
			block.relationship === "extension"
		) {
			causes.add("extension-case-moved");
			continue;
		}
		causes.add(causeOf(reading));
	}
	const structure = formStructure(input.target, formUuid);
	if (structure !== undefined)
		for (const fieldUuid of queryRepeatsOf(input.target, formUuid)) {
			const row = rows(fieldUuid);
			if (
				row !== undefined &&
				published.modelIterationRows.includes(row) &&
				effectiveQueryRepeatPlacement(structure, fieldUuid) === "count"
			)
				causes.add("repeat-rows-follow-query");
		}
	return causes;
}

/** The causes of one form's moves on an unknown baseline: the units
 *  section 8 left unheld for a class of §8.5. */
function unknownCauses(
	input: DeploymentLinesInput,
	formUuid: Uuid,
): Set<PathMoveCause> {
	const causes = new Set<PathMoveCause>();
	for (const reading of input.units) {
		if (reading.formUuid !== formUuid) continue;
		// `main` wrote an inert basic subcase beside every extension's Save to
		// Case block, which the head no longer writes, held block or not.
		if (reading.unit.startsWith("extension:") && reading.never === undefined)
			causes.add("extension-case-moved");
		// A renumbered child an unknown baseline cannot show carried moves to
		// the head's index; a unit with nothing in the target leaves its
		// block behind.
		if (reading.never !== undefined) causes.add(causeOf(reading));
	}
	return causes;
}

/** `form-data-paths-move` for one published deployment, or null. */
function pathMove(
	input: DeploymentLinesInput,
	deployment: PublishedDeployment,
): PathMove | null {
	const countNodes = countNodeForms(input.target, input.documentNotice);
	const closesMoved = ownClosesMoved(input.raw);
	let forms = 0;
	const all = new Set<PathMoveCause>();
	for (const formUuid of formsInOrder(input.target)) {
		const readable = deployment.baseline.kind === "readable";
		if (
			readable &&
			publishedFormOf(input.target, deployment, formUuid) === undefined
		)
			continue;
		const causes = readable
			? readableCauses(input, deployment, formUuid)
			: unknownCauses(input, formUuid);
		if (countNodes.has(formUuid)) causes.add("count-node-removed");
		if (closesMoved.has(formUuid)) causes.add("own-close-moved");
		if (causes.size === 0) continue;
		forms++;
		for (const cause of causes) all.add(cause);
	}
	if (forms === 0) return null;
	return {
		deploymentId: deployment.deploymentId,
		forms,
		causes: PATH_MOVE_CAUSES.filter((cause) => all.has(cause)),
	};
}

/** The case properties an attachment-mode capture wrote, by form, as HQ's
 *  update map keys them (`name` for the case's name). */
function attachmentWrites(
	input: DeploymentLinesInput,
): { formUuid: Uuid; fieldUuid: Uuid; key: string; property: string }[] {
	const out: {
		formUuid: Uuid;
		fieldUuid: Uuid;
		key: string;
		property: string;
	}[] = [];
	for (const [formUuid, facts] of input.facts.fieldWrites)
		for (const fact of facts) {
			if (!input.facts.attachmentFields.has(fact.fieldUuid)) continue;
			out.push({
				formUuid,
				fieldUuid: fact.fieldUuid,
				key: fact.property === "case_name" ? "name" : fact.property,
				property: `${fact.caseType}\u0000${fact.property}`,
			});
		}
	return out;
}

/**
 * How many properties `deployment` received as files on the case: every
 * attachment-mode property where its baseline is unknown; where readable,
 * each a block maps to the capture question's own data path, which is how
 * `main` wrote attachment mode (its update named the upload question, and
 * HQ's build turns such an update into an `<attachment>` block,
 * `corehq/apps/app_manager/xform.py::CaseBlock.add_case_updates` through
 * `is_attachment`).
 */
function attachmentProperties(
	input: DeploymentLinesInput,
	deployment: PublishedDeployment,
): number {
	const writes = attachmentWrites(input);
	if (writes.length === 0) return 0;
	if (deployment.baseline.kind === "unknown")
		return new Set(writes.map((write) => write.property)).size;
	if (deployment.baseline.kind !== "readable") return 0;
	const found = new Set<string>();
	for (const write of writes) {
		const formUuid =
			formOfField(input.target, write.fieldUuid) ?? write.formUuid;
		const path = collectFieldLocations(input.target, formUuid)
			.get(write.fieldUuid)
			?.path.toXPath();
		const published = publishedFormOf(input.target, deployment, formUuid);
		if (path === undefined || published === undefined) continue;
		if (
			published.blocks.some(
				(block) =>
					"properties" in block && block.properties.get(write.key) === path,
			)
		)
			found.add(write.property);
	}
	return found.size;
}

/** The plan feature of Save to Case blocks. */
const SAVE_TO_CASE_FEATURE = PLAN_FEATURE_FOR_PRIVILEGE.save_to_case;

/**
 * Step 17 over one app: each live deployment's lines and each published
 * deployment's moves. A deployment whose baseline does not verify gets
 * none: its app meets `baseline-unreadable` and is not written.
 */
export function deploymentLines(input: DeploymentLinesInput): DeploymentLines {
	const { target } = input;
	const notice: MigrationNoticeEntry[] = [];
	const pathMoves: PathMove[] = [];
	const hasEntryPoints = entryPointInventory(target).length > 0;
	const published = new Map(
		input.published.map((deployment) => [deployment.deploymentId, deployment]),
	);

	// What the next publish asks, the same for every published deployment.
	const commtrackOff = commtrackReasons(target, input.lookupNaming).length > 0;
	const sameType = sameTypeBasicChildCases(target);
	const sameTypeChildLinks =
		sameType.length > 0 &&
		!sameType.some(
			(child) =>
				target.forms[child.formUuid]?.caseOperations?.find(
					(operation) => operation.uuid === child.operationUuid,
				)?.placement !== undefined,
		);
	const todayUsedSaveToCase = [...input.facts.todaysPlacements.values()].some(
		(today) =>
			today.placement !== "model-iteration" &&
			today.placement.kind === "save-to-case",
	);
	const planFeatures =
		!todayUsedSaveToCase &&
		requiredPlanFeatures(
			target,
			{ lookupTables: false, places: false },
			null,
		).some((use) => use.id === SAVE_TO_CASE_FEATURE)
			? [SAVE_TO_CASE_FEATURE]
			: [];

	for (const live of input.live) {
		const deployment = published.get(live.deploymentId);
		if (deployment?.baseline.kind === "unreadable") continue;
		if (hasEntryPoints) notice.push(deepLinksNeedRepublish(live));
		if (deployment === undefined) continue;
		if (deployment.baseline.kind === "unknown")
			notice.push(placementsKeptUnread(live));
		if (
			deployment.baseline.kind === "readable" ||
			deployment.baseline.kind === "unknown"
		) {
			const move = pathMove(input, deployment);
			if (move !== null) {
				pathMoves.push(move);
				notice.push(formDataPathsMove(live, move));
			}
			const properties = attachmentProperties(input, deployment);
			if (properties > 0) notice.push(caseAttachmentsStop(live, properties));
		}
		const asks = nextPublishAsksMore(live, {
			commtrackOff,
			sameTypeChildLinks,
			planFeatures,
		});
		if (asks !== null) notice.push(asks);
	}
	return { pathMoves, notice };
}
