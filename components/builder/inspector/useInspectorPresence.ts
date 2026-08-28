/** Layout-only inspector projection.
 *
 * This intentionally owns no inspector body or title work. BuilderContentArea
 * needs only one boolean and a close action to size responsive rails; the chat
 * chunk resolves the full descriptor when it renders the actual panel.
 */
"use client";

import { useCallback } from "react";
import { useCaseListInspector } from "@/components/builder/case-list-config/CaseListWorkspaceProvider";
import { useProjectDataInspectorPresence } from "@/components/builder/project-data/ProjectDataWorkspaceLazyProvider";
import {
	useHasSelectedField,
	useNavigate,
	useSelect,
	useSelectedFormLinkUuid,
	useSelectedFormOperationUuid,
	useSelectedFormUuid,
	useSelectedModuleUuid,
} from "@/lib/routing/hooks";

export function useInspectorPresence(): {
	docked: boolean;
	requestClose: () => void;
} {
	const fieldDocked = useHasSelectedField();
	const select = useSelect();
	const caseList = useCaseListInspector();
	const projectData = useProjectDataInspectorPresence();
	const moduleUuid = useSelectedModuleUuid();
	const formUuid = useSelectedFormUuid();
	const operationUuid = useSelectedFormOperationUuid();
	const linkUuid = useSelectedFormLinkUuid();
	const operationDocked =
		moduleUuid !== undefined &&
		formUuid !== undefined &&
		operationUuid !== undefined;
	const linkDocked =
		moduleUuid !== undefined &&
		formUuid !== undefined &&
		linkUuid !== undefined;
	const navigate = useNavigate();
	const caseListClose = caseList?.onClose;
	const projectDataClose = projectData?.onClose;
	const docked =
		fieldDocked ||
		(caseList?.inspector ?? null) !== null ||
		(projectData?.docked ?? false) ||
		operationDocked ||
		linkDocked;
	const requestClose = useCallback(() => {
		if (fieldDocked) select(undefined);
		else if (operationDocked) {
			navigate.openFormOperations(moduleUuid, formUuid);
		} else if (linkDocked) {
			navigate.openFormLinks(moduleUuid, formUuid);
		} else {
			caseListClose?.();
			projectDataClose?.();
		}
	}, [
		fieldDocked,
		select,
		operationDocked,
		linkDocked,
		navigate,
		moduleUuid,
		formUuid,
		caseListClose,
		projectDataClose,
	]);
	return { docked, requestClose };
}
