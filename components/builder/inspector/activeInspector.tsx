/**
 * The right rail renders the inspector directly from shared selection state:
 * there is no claim, no portal, and no owning surface that injects content.
 * These hooks resolve "what is selected for inspection right now" from the two
 * selection sources and hand the rail a ready-to-render descriptor:
 *
 *   - a selected form FIELD (URL state, `useSelectedField`),
 *   - the case-list workspace's current selection (`useCaseListInspector`, the
 *     narrow, memoized slice of the shared controller carrying just the resolved
 *     `inspector` + its close handler, so these hooks don't re-render on every
 *     unrelated workspace change), or
 *   - the Project data workspace's selected row or column
 *     (`useProjectDataInspector`, the same narrow shape).
 *
 * They are mutually exclusive, and the URL is what makes them so: a field is
 * only selected on a form screen, the case-list `inspector` is non-null only
 * while its workspace is on-screen, and a Project data URL names no module and
 * no field at all.
 * Because the rail is always mounted (it just parks off-screen during a preview
 * flip), whatever these return stays mounted across the flip, scroll survives
 * for free. The mode (edit vs preview) is deliberately NOT consulted: parking
 * hides the panel in preview, so gating mount on edit-mode would needlessly tear
 * it down.
 */
"use client";

import dynamic from "next/dynamic";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { useCaseListInspector } from "@/components/builder/case-list-config/CaseListWorkspaceProvider";
import { operationSentence } from "@/components/builder/case-operations/operationSentence";
import { useOperationSentenceContext } from "@/components/builder/case-operations/useOperationSentenceContext";
import { linkLead } from "@/components/builder/form-links/linkSentence";
import { useLinkSentenceContext } from "@/components/builder/form-links/useLinkSentenceContext";
import {
	getFieldInspectorBodyServerSnapshot,
	getFieldInspectorBodySnapshot,
	loadFieldInspectorBody,
	loadSectionInspectorBody,
	subscribeFieldInspectorBody,
} from "@/components/builder/inspector/lazyInspectorBodies";
import { PeerBadge } from "@/components/builder/PeerBadge";
import { useProjectDataInspector } from "@/components/builder/project-data/projectDataInspector";
import { Button } from "@/components/shadcn/button";
import { useCaseOperation } from "@/lib/doc/hooks/useCaseOperationFacts";
import { useFormLink } from "@/lib/doc/hooks/useFormLinkFacts";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { Uuid } from "@/lib/doc/types";
import type { CaseOperation, Field, FormLink } from "@/lib/domain";
import { fieldRegistry } from "@/lib/domain";
import {
	useNavigate,
	useSelect,
	useSelectedField,
	useSelectedFormLinkUuid,
	useSelectedFormOperationUuid,
	useSelectedFormUuid,
	useSelectedModuleUuid,
} from "@/lib/routing/hooks";

function InspectorBodyLoading() {
	return (
		<div className="py-4 text-sm text-nova-text-muted" role="status">
			Opening properties
		</div>
	);
}
const CaseOperationInspectorBody = dynamic(
	() =>
		import(
			"@/components/builder/case-operations/CaseOperationInspectorBody"
		).then((module) => module.CaseOperationInspectorBody),
	{ loading: InspectorBodyLoading },
);
const FormLinkInspectorBody = dynamic(
	() =>
		import("@/components/builder/form-links/FormLinkInspectorBody").then(
			(module) => module.FormLinkInspectorBody,
		),
	{ loading: InspectorBodyLoading },
);
function FieldInspectorBody({ field }: { field: Field }) {
	const snapshot = useSyncExternalStore(
		subscribeFieldInspectorBody,
		getFieldInspectorBodySnapshot,
		getFieldInspectorBodyServerSnapshot,
	);
	useEffect(() => {
		if (snapshot.status === "idle") {
			void loadFieldInspectorBody().catch(() => undefined);
		}
	}, [snapshot.status]);
	if (snapshot.status === "idle" || snapshot.status === "loading") {
		return <InspectorBodyLoading />;
	}
	if (snapshot.status === "error") {
		return (
			<div className="space-y-2 py-4 text-sm" role="alert">
				<p className="text-nova-text-secondary">
					Properties could not open. Try again.
				</p>
				<Button
					type="button"
					variant="link"
					onClick={() => {
						void loadFieldInspectorBody().catch(() => undefined);
					}}
				>
					Try again
				</Button>
			</div>
		);
	}
	return <snapshot.module.FieldInspectorBody field={field} />;
}
const SectionInspectorBody = dynamic(
	() =>
		loadSectionInspectorBody().then((module) => module.SectionInspectorBody),
	{ loading: InspectorBodyLoading },
);

export interface ActiveInspector {
	readonly kicker: string;
	readonly title: string;
	readonly body: ReactNode;
	readonly onClose: () => void;
}

/** The full inspector descriptor to render in the rail, or `null` for chat. */
export function useActiveInspector(): ActiveInspector | null {
	const field = useSelectedField();
	const select = useSelect();
	const caseList = useCaseListInspector();
	const projectData = useProjectDataInspector();
	const operation = useSelectedCaseOperation();
	const link = useSelectedFormLink();
	const navigate = useNavigate();
	const projectProse = useProseProjection();

	if (field) {
		// Title = the field's prompt, falling back to its id (the `hidden` kind
		// carries no label). The header truncates, so a long markdown label shows
		// raw rather than rendered: short labels are the norm.
		const label =
			"label" in field && field.label
				? projectProse(field.label).trim()
				: undefined;
		if (field.kind === "section") {
			// A page has its own body: its place in the form and its fate, no
			// logic. An untitled page is named as such rather than by its id,
			// which is a wire name nobody chose.
			return {
				kicker: "Section",
				title: label || "Untitled section",
				body: (
					<>
						<PeerBadge uuid={field.uuid} className="mb-1" />
						<SectionInspectorBody field={field} />
					</>
				),
				onClose: () => select(undefined),
			};
		}
		return {
			kicker: fieldRegistry[field.kind].label,
			title: label || field.id,
			body: (
				<>
					{/* A peer editing this same field surfaces its marker at the top of
					 *  the body (renders nothing while solo). */}
					<PeerBadge uuid={field.uuid} className="mb-1" />
					<FieldInspectorBody field={field} />
				</>
			),
			onClose: () => select(undefined),
		};
	}
	if (caseList?.inspector) {
		return { ...caseList.inspector, onClose: caseList.onClose };
	}
	if (projectData?.inspector) {
		return { ...projectData.inspector, onClose: projectData.onClose };
	}
	if (operation !== null) {
		return {
			kicker: "Case change",
			title: operation.title,
			body: (
				/* Keyed by the change for the same reason the detail canvas is
				 * (`PreviewShell`): this body holds per-change confirmation state:
				 * an armed removal, an armed action change, and Previous / Next
				 * changes only `operationUuid`, so an unkeyed instance would be
				 * reconciled in place and one Enter would commit a confirmation the
				 * author armed for the change they just left. */
				<CaseOperationInspectorBody
					key={operation.operationUuid}
					moduleUuid={operation.moduleUuid}
					formUuid={operation.formUuid}
					operationUuid={operation.operationUuid}
				/>
			),
			onClose: () =>
				navigate.openFormOperations(operation.moduleUuid, operation.formUuid),
		};
	}
	if (link !== null) {
		return {
			kicker: "After submit",
			title: link.title,
			body: (
				/* Keyed by the link for the same reason the case-change body is:
				 * an armed removal must not survive Previous / Next. */
				<FormLinkInspectorBody
					key={link.linkUuid}
					moduleUuid={link.moduleUuid}
					formUuid={link.formUuid}
					linkUuid={link.linkUuid}
				/>
			),
			onClose: () => navigate.openFormLinks(link.moduleUuid, link.formUuid),
		};
	}
	return null;
}

interface SelectedCaseOperationTarget {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly operation: CaseOperation;
}

/**
 * The third selection source: one case change, selected in the URL.
 *
 * Unlike the case workspace's row selection this lives in the path, so a
 * change is linkable and survives a preview flip for free, and unlike a
 * field it names an entity inside a form record rather than a top-level
 * one, which is why closing means dropping back to the list URL rather
 * than clearing a selection param.
 *
 * Split from the titled descriptor because presence is asked by layout code
 * on every builder screen: naming the change means resolving repeat and
 * operation uuids to their author-given words, and nothing that only needs
 * to know whether a change is selected should pay for that.
 */
function useSelectedCaseOperationTarget(): SelectedCaseOperationTarget | null {
	const moduleUuid = useSelectedModuleUuid();
	const formUuid = useSelectedFormUuid();
	const operationUuid = useSelectedFormOperationUuid();
	const operation = useCaseOperation(formUuid, operationUuid);
	if (
		moduleUuid === undefined ||
		operationUuid === undefined ||
		formUuid === undefined ||
		operation === undefined
	) {
		return null;
	}
	return { moduleUuid, formUuid, operationUuid, operation };
}

interface SelectedFormLinkTarget {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly linkUuid: Uuid;
	readonly link: FormLink;
}

/**
 * The fourth selection source: one after-submit link, selected in the URL.
 * Split the same way the case-change source is: this one is cheap enough
 * for layout code, the titled one below resolves the destination's name.
 */
function useSelectedFormLinkTarget(): SelectedFormLinkTarget | null {
	const moduleUuid = useSelectedModuleUuid();
	const formUuid = useSelectedFormUuid();
	const linkUuid = useSelectedFormLinkUuid();
	const link = useFormLink(formUuid, linkUuid);
	if (
		moduleUuid === undefined ||
		linkUuid === undefined ||
		formUuid === undefined ||
		link === undefined
	) {
		return null;
	}
	return { moduleUuid, formUuid, linkUuid, link };
}

/** The selected link plus the sentence that names it in the rail header. */
function useSelectedFormLink():
	| (SelectedFormLinkTarget & { readonly title: string })
	| null {
	const target = useSelectedFormLinkTarget();
	const context = useLinkSentenceContext();
	if (target === null) return null;
	return { ...target, title: linkLead(target.link.target, context) };
}

/** The selected change plus the sentence that names it in the rail header. */
function useSelectedCaseOperation():
	| (SelectedCaseOperationTarget & { readonly title: string })
	| null {
	const target = useSelectedCaseOperationTarget();
	const context = useOperationSentenceContext(target?.formUuid);
	if (target === null) return null;
	return {
		...target,
		title: operationSentence(target.operation, context).lead,
	};
}
