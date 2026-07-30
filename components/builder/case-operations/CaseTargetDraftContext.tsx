"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import type { Uuid } from "@/lib/doc/types";
import { literal, term, type ValueExpression } from "@/lib/domain/predicate";

interface CaseTargetDraft {
	readonly formUuid: Uuid;
	readonly operationUuid: Uuid;
	readonly expression: ValueExpression;
}

interface CaseTargetDraftStore {
	readonly draft: CaseTargetDraft | null;
	readonly begin: (formUuid: Uuid, operationUuid: Uuid) => void;
	readonly update: (
		formUuid: Uuid,
		operationUuid: Uuid,
		expression: ValueExpression,
	) => void;
	readonly clear: (formUuid: Uuid, operationUuid: Uuid) => void;
}

const CaseTargetDraftContext = createContext<CaseTargetDraftStore | null>(null);

/**
 * Owns the one incomplete operation-target calculation that may span the
 * inspector rail and centre canvas.
 *
 * A runtime target is a discrete choice in the rail but its recursive
 * expression belongs in the canvas. The persisted document cannot carry the
 * empty literal needed to open that editor, so the two surfaces share this
 * local draft until a complete expression passes the ordinary commit gate.
 */
export function CaseTargetDraftProvider({
	children,
}: {
	readonly children: ReactNode;
}) {
	const [draft, setDraft] = useState<CaseTargetDraft | null>(null);

	const begin = useCallback((formUuid: Uuid, operationUuid: Uuid) => {
		setDraft((current) =>
			current?.formUuid === formUuid && current.operationUuid === operationUuid
				? current
				: {
						formUuid,
						operationUuid,
						expression: term(literal("")),
					},
		);
	}, []);

	const update = useCallback(
		(formUuid: Uuid, operationUuid: Uuid, expression: ValueExpression) => {
			setDraft((current) =>
				current?.formUuid === formUuid &&
				current.operationUuid === operationUuid
					? { formUuid, operationUuid, expression }
					: current,
			);
		},
		[],
	);

	const clear = useCallback((formUuid: Uuid, operationUuid: Uuid) => {
		setDraft((current) =>
			current?.formUuid === formUuid && current.operationUuid === operationUuid
				? null
				: current,
		);
	}, []);

	const value = useMemo(
		() => ({ draft, begin, update, clear }),
		[draft, begin, update, clear],
	);

	return (
		<CaseTargetDraftContext.Provider value={value}>
			{children}
		</CaseTargetDraftContext.Provider>
	);
}

export function useCaseTargetDraft(
	formUuid: Uuid,
	operationUuid: Uuid,
): {
	readonly expression: ValueExpression | undefined;
	readonly begin: () => void;
	readonly update: (expression: ValueExpression) => void;
	readonly clear: () => void;
} {
	const store = useContext(CaseTargetDraftContext);
	if (store === null) {
		throw new Error(
			"useCaseTargetDraft must be used inside CaseTargetDraftProvider",
		);
	}
	const expression =
		store.draft?.formUuid === formUuid &&
		store.draft.operationUuid === operationUuid
			? store.draft.expression
			: undefined;
	return useMemo(
		() => ({
			expression,
			begin: () => store.begin(formUuid, operationUuid),
			update: (next: ValueExpression) =>
				store.update(formUuid, operationUuid, next),
			clear: () => store.clear(formUuid, operationUuid),
		}),
		[expression, formUuid, operationUuid, store],
	);
}
