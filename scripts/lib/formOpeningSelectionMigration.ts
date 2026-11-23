/** The original release admitted only the ordinary parent chain and the
 * worker's own record as advanced opening choices. Recover their recorded
 * identities from the target's verified source at its original revision.
 * These functions are called by the scan and the fenced conversion together.
 * The migration keeps the source release's history in its original dialect. */
import { hqEntryFacts } from "@/lib/commcare/hq/entryFacts";
import type { WireIdentity } from "@/lib/commcare/wireIdentity";
import { sourceFromBaseline } from "@/lib/deployment/hqChanges/baselineSource";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	formCaseSelections,
	menuEmittedAdvanced,
} from "@/lib/domain/advancedEntryDatums";
import { advancedTagSchema } from "@/lib/domain/placements";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export interface SelectionTargetRevision {
	readonly appId: string;
	readonly projectId: string;
	readonly deploymentId: string;
	readonly originalRevision: number;
	readonly snapshotDigest: string;
	readonly sourceDigest: string;
}

interface RecordedSelection {
	readonly form: Uuid;
	readonly selection: Uuid;
	readonly tag: string;
}

export interface SelectionTargetFacts extends SelectionTargetRevision {
	readonly choices: readonly RecordedSelection[];
}

/** Input is an original published comparison (including an adopted app's
 * birth) with that exact target's overrides. Match forms by xmlns and check
 * each load's actual source, parent and type before assigning any UUID. */
export function readOriginalSelectionTags(
	scope: SelectionTargetRevision,
	published: BlueprintDoc,
	normalizedSource: unknown,
	identity: WireIdentity,
): SelectionTargetFacts {
	if (
		published.appId !== scope.appId ||
		canonicalJsonDigest(toPersistableDoc(published)) !== scope.snapshotDigest ||
		canonicalJsonDigest(normalizedSource) !== scope.sourceDigest
	) {
		throw new Error(
			"The original form selection snapshot or its source changed. Scan this deployment again.",
		);
	}
	const source = sourceFromBaseline(normalizedSource);
	const facts = hqEntryFacts(source.raw);
	const choices: RecordedSelection[] = [];
	for (const owner of published.moduleOrder) {
		if (!menuEmittedAdvanced(published, owner)) continue;
		for (const form of published.formOrder[owner] ?? []) {
			const rows = formCaseSelections(published, form);
			const forms = facts.forms.get(identity.formXmlns(published.forms[form]));
			if (
				forms?.moduleKind !== "AdvancedModule" ||
				forms.loads.length !== rows.length
			) {
				throw new Error(
					"An advanced form's original opening choices do not match this deployment. Check the original revision and target.",
				);
			}
			const seen = new Map<Uuid, string>();
			const names = new Set<string>();
			for (const [index, row] of rows.entries()) {
				const load = forms.loads[index];
				const under =
					row.source.kind === "choose" ? row.source.under : undefined;
				const owning = identity.moduleUniqueId(owner);
				const parentTag = under ? seen.get(under.selection) : null;
				const list =
					load.detailsModule ??
					(facts.menus.get(owning)?.caseType === load.caseType
						? owning
						: source.modules.find((menu) => menu.caseType === load.caseType)
								?.uniqueId);
				const sourceAgrees =
					row.source.kind === "worker-record"
						? load.autoSelect === "usercase"
						: row.source.kind === "choose" &&
							load.autoSelect === null &&
							list === identity.moduleUniqueId(row.source.module);
				if (
					!sourceAgrees ||
					load.caseType !== row.caseType ||
					load.indexTag !== parentTag ||
					load.indexName !== (under?.identifier ?? null) ||
					!advancedTagSchema.safeParse(load.tag).success ||
					names.has(load.tag)
				) {
					throw new Error(
						"A saved opening choice has a different source, connection, type or name than this form. Check the original revision and target.",
					);
				}
				seen.set(row.uuid, load.tag);
				names.add(load.tag);
				choices.push({ form, selection: row.uuid, tag: load.tag });
			}
		}
	}
	return { ...scope, choices };
}

/** The fold operator supplies the authorized Project, original horizon and
 * signed, rechecked source facts eligible for this particular comparison.
 * A later form or a new choice never inherits a hold by ordinal. */
export function applyOriginalSelectionTags(
	doc: BlueprintDoc,
	scope: {
		readonly appId: string;
		readonly projectId: string;
		readonly originalRevision: number;
	},
	sources: readonly SelectionTargetFacts[],
): BlueprintDoc {
	if (doc.appId !== scope.appId)
		throw new Error("The form selection snapshot belongs to a different app.");
	const byForm = new Map<Uuid, Map<Uuid, string>>();
	for (const source of sources) {
		if (
			source.appId !== scope.appId ||
			source.projectId !== scope.projectId ||
			source.originalRevision > scope.originalRevision
		) {
			throw new Error(
				"The recorded form selections belong to a different app, Project or revision.",
			);
		}
		for (const choice of source.choices) {
			const tags = byForm.get(choice.form) ?? new Map<Uuid, string>();
			const previous = tags.get(choice.selection);
			if (previous !== undefined && previous !== choice.tag)
				throw new Error(
					"Two deployments hold a different name for the same opening choice. Review both sources before converting the app.",
				);
			tags.set(choice.selection, choice.tag);
			byForm.set(choice.form, tags);
		}
	}
	let forms = doc.forms;
	for (const owner of doc.moduleOrder) {
		if (!menuEmittedAdvanced(doc, owner)) continue;
		for (const form of doc.formOrder[owner] ?? []) {
			const observed = byForm.get(form);
			if (!observed) continue;
			const current = doc.forms[form];
			const changed: [Uuid, string][] = [];
			for (const row of formCaseSelections(doc, form)) {
				const expected = observed.get(row.uuid);
				if (
					expected === undefined ||
					current.heldSelectionTags?.[row.uuid] === expected
				)
					continue;
				if (
					current.heldSelectionTags?.[row.uuid] !== undefined ||
					(current.caseSelections && row.tag !== expected)
				) {
					throw new Error(
						"The saved form and its deployment hold different names for this opening choice. Review its original source.",
					);
				}
				changed.push([row.uuid, expected]);
			}
			if (changed.length) {
				if (forms === doc.forms) forms = { ...forms };
				forms[form] = {
					...current,
					heldSelectionTags: {
						...current.heldSelectionTags,
						...Object.fromEntries(changed),
					},
				};
			}
		}
	}
	return forms === doc.forms ? doc : { ...doc, forms };
}
