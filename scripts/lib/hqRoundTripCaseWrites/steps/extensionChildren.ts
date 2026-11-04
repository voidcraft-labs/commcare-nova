/**
 * Step `extension-children` (part 09 §7.6; part 02 §23's M1 to M3), over the
 * document `form-link-semantics` left.
 *
 * A create an after-submit link carries into its target
 * (`lib/commcare/formLinkProjection.ts::linkCarriedCreates`, whatever its
 * relationship) and that a basic form gives no session value needs no
 * stored change where its menu can be advanced: `emittedModuleKind` makes
 * the menu advanced and the create an open action, and the module gets
 * `module-made-advanced` once, its `caseType` the first such create's.
 *
 * Where the gate would refuse the create instead
 * (`FORM_LINK_NEEDS_NEW_CASE_DATUM`: an `advancedKindBlockers` blocker
 * keeps the menu basic, or the advanced form cannot make the create an open
 * action), each link that carries it is retargeted the way an author would
 * retarget it, through `planFormLinkUpdate` (a destination) or
 * `planSetOtherwise` (the otherwise link): to its target form's menu where
 * CommCare HQ offers it from the form's menu (`menuTargetOffered`), else to
 * the nearest menu above it HQ offers (`nearestOfferedMenu`), else the link
 * is removed (`planFormLinkRemove`, or the otherwise cleared) and the form
 * goes to the app home. Its carried values are dropped in every case. Each
 * retarget is a `form-link-goes-to-menu` entry on the form, `to` absent for a
 * removal.
 *
 * Which creates the gate refuses is the gate's own rule
 * (`lib/commcare/validator/rules/advancedModule.ts::
 * formLinkNeedsNewCaseDatum`), read again after every retarget, so a create
 * a second link also carries is found through that link next. A link still
 * found after its retarget (a condition that reads the new case itself) is
 * removed.
 *
 * No module kind and no placement is held here: the next publish records
 * the kind (part 02 §5), and the placement step leaves every unit this step
 * names unheld (part 09 §8.5).
 */

import {
	advancedKindReasons,
	emittedModuleKind,
} from "@/lib/commcare/moduleKind";
import { formLinkNeedsNewCaseDatum } from "@/lib/commcare/validator/rules/advancedModule";
import {
	type FormLinkCommitPlan,
	planFormLinkRemove,
	planFormLinkUpdate,
	planSetOtherwise,
} from "@/lib/doc/formLinkMutations";
import {
	type BlueprintDoc,
	type CaseOperation,
	type FormLink,
	formLinkEntries,
	nearestOfferedMenu,
	resolveFormLinkTarget,
	type Uuid,
} from "@/lib/domain";
import { advancedKindTriggers } from "@/lib/domain/advancedEntryDatums";
import type { MigrationNoticeEntry } from "@/lib/notices/migrationNotice";
import { formLinkGoesToMenu, moduleMadeAdvanced } from "../notice";
import type { BlockerPlace, CutoverBlocker, PlannedChange } from "../types";
import {
	applyStepMutations,
	type StepResult,
	stepBlocker,
	stoppedStep,
} from "./apply";

/** The change kinds this step plans, as the report's `steps` line counts
 *  them; `non-extension-carried-create` is the line part 02's decision 11
 *  asks to be listed apart, so the person reviews it in the dry run. */
export const EXTENSION_CHILDREN_CHANGES = [
	"carried-create",
	"non-extension-carried-create",
	"module-made-advanced",
	"link-goes-to-menu",
	"link-removed",
] as const;
export type ExtensionChildrenChange =
	(typeof EXTENSION_CHILDREN_CHANGES)[number];

export interface ExtensionChildrenResult extends StepResult {
	/** Every create a link carries that a basic form gives no session value,
	 *  by operation uuid: its Save to Case placement is never held. */
	readonly carriedCreates: ReadonlySet<Uuid>;
	/** Every module this step's document emits advanced: no unit of its forms
	 *  is held at a basic placement. */
	readonly advancedModules: ReadonlySet<Uuid>;
}

const STEP = "extension-children";

function change(
	kind: ExtensionChildrenChange,
	entityUuid: Uuid,
	detail: Record<string, number> = {},
): PlannedChange {
	return { step: STEP, kind, entityUuid, detail };
}

function isExtensionCreate(operation: CaseOperation | undefined): boolean {
	return (
		operation?.action === "create" &&
		(operation.links ?? []).some((link) => link.relationship === "extension")
	);
}

/** The mutations that send one carrying link to `menuUuid`, or remove it
 *  where `menuUuid` is undefined; its carried values go either way. */
function retargetPlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
	linkUuid: Uuid,
	menuUuid: Uuid | undefined,
): FormLinkCommitPlan | undefined {
	const form = doc.forms[formUuid];
	const entry = formLinkEntries(form).find(
		({ link }) => link.uuid === linkUuid,
	);
	if (entry === undefined) return undefined;
	if (entry.role === "otherwise")
		return planSetOtherwise(
			doc,
			formUuid,
			menuUuid === undefined
				? null
				: {
						kind: "link",
						uuid: linkUuid,
						target: { type: "module", moduleUuid: menuUuid },
					},
		);
	if (menuUuid === undefined)
		return planFormLinkRemove(doc, formUuid, linkUuid);
	const link: FormLink = entry.link;
	return planFormLinkUpdate(
		doc,
		formUuid,
		{
			uuid: link.uuid,
			...(link.condition !== undefined && { condition: link.condition }),
			target: { type: "module", moduleUuid: menuUuid },
		},
		link,
	);
}

/** Step `extension-children` over the document `form-link-semantics`
 *  left. */
export function extensionChildren(
	input: BlueprintDoc,
): ExtensionChildrenResult {
	const stop = (blocker: CutoverBlocker): ExtensionChildrenResult => ({
		...stoppedStep(input, [blocker]),
		carriedCreates: new Set(),
		advancedModules: new Set(),
	});
	const changes: PlannedChange[] = [];
	const notice: MigrationNoticeEntry[] = [];
	const carriedCreates = new Set<Uuid>();

	/* The creates that need a session value, read before any retarget, so a
	 * create a retarget stops carrying is still listed and still unheld. */
	for (const moduleUuid of input.moduleOrder) {
		for (const reason of advancedKindTriggers(input, moduleUuid)) {
			if (reason.kind !== "carried-create") continue;
			carriedCreates.add(reason.operationUuid);
			const operation = input.forms[reason.formUuid]?.caseOperations?.find(
				(candidate) => candidate.uuid === reason.operationUuid,
			);
			changes.push(
				change(
					isExtensionCreate(operation)
						? "carried-create"
						: "non-extension-carried-create",
					reason.formUuid,
				),
			);
		}
	}

	let doc = input;
	for (const moduleUuid of input.moduleOrder) {
		for (const formUuid of input.formOrder[moduleUuid] ?? []) {
			if (doc.forms[formUuid] === undefined) continue;
			const retargeted = new Set<Uuid>();
			const linkCount = formLinkEntries(doc.forms[formUuid]).length;
			/* Each pass settles one link, and a link is retargeted at most once
			 * and removed if found again, so twice the form's link count bounds
			 * the passes. */
			for (let pass = 0; ; pass++) {
				const finding = formLinkNeedsNewCaseDatum(doc, formUuid, moduleUuid)[0];
				if (finding === undefined) break;
				const form = doc.forms[formUuid];
				const place: BlockerPlace = {
					entity: { kind: "form", uuid: formUuid, name: form.name },
					findingCode: finding.code,
				};
				const linkUuid = finding.details?.linkUuid as Uuid | undefined;
				const entry = formLinkEntries(form).find(
					({ link }) => link.uuid === linkUuid,
				);
				if (
					linkUuid === undefined ||
					entry === undefined ||
					pass > 2 * linkCount
				)
					return stop(
						stepBlocker(
							"transform-admission",
							1,
							["extension-children:unsettled"],
							[place],
						),
					);
				const target = resolveFormLinkTarget(doc, formUuid, entry.link.target);
				const menuUuid =
					target === undefined || retargeted.has(linkUuid)
						? undefined
						: nearestOfferedMenu(doc, moduleUuid, target.moduleUuid);
				const plan = retargetPlan(doc, formUuid, linkUuid, menuUuid);
				if (plan === undefined || !plan.ok)
					return stop(
						stepBlocker(
							"transform-admission",
							1,
							[
								`form-link-plan:${plan === undefined ? "link-not-found" : plan.reason.kind}`,
							],
							[place],
						),
					);
				const applied = applyStepMutations(doc, plan.mutations, place.entity);
				if (!applied.ok) return stop(applied.blocker);
				doc = applied.doc;
				retargeted.add(linkUuid);
				const caseType = finding.details?.caseType ?? "";
				changes.push(
					change(
						menuUuid === undefined ? "link-removed" : "link-goes-to-menu",
						formUuid,
					),
				);
				notice.push(
					formLinkGoesToMenu(
						{ uuid: formUuid, name: form.name },
						{
							...(menuUuid !== undefined && {
								to: doc.modules[menuUuid]?.name ?? "",
							}),
							caseType,
						},
					),
				);
			}
		}
	}

	/* The menus the retargeted document emits advanced because a carried
	 * create needs it: the next publish records each one's kind. */
	const advancedModules = new Set<Uuid>();
	for (const moduleUuid of doc.moduleOrder) {
		if (emittedModuleKind(doc, moduleUuid) !== "advanced") continue;
		advancedModules.add(moduleUuid);
		const creates = advancedKindReasons(doc, moduleUuid).filter(
			(reason) => reason.kind === "carried-create",
		);
		const first = creates[0];
		if (first?.kind !== "carried-create") continue;
		const operation = doc.forms[first.formUuid]?.caseOperations?.find(
			(candidate) => candidate.uuid === first.operationUuid,
		);
		const caseType =
			operation?.action === "create"
				? operation.caseType
				: (doc.modules[moduleUuid]?.caseType ?? "");
		changes.push(
			change("module-made-advanced", moduleUuid, { creates: creates.length }),
		);
		notice.push(
			moduleMadeAdvanced(
				{ uuid: moduleUuid, name: doc.modules[moduleUuid]?.name ?? "" },
				caseType,
			),
		);
	}

	return {
		doc,
		changes,
		notice,
		blockers: [],
		carriedCreates,
		advancedModules,
	};
}
