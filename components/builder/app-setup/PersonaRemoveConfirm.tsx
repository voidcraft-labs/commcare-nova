/**
 * Removing a persona, with the consequence stated before it happens.
 *
 * Cases the persona owns are deliberately left where they are. That is
 * Nova's own rule rather than HQ parity: HQ deactivating a worker leaves
 * their cases alone, but HQ DELETING one soft-deletes every case they own
 * (`users/models.py::CommCareUser.retire`). A persona is a design and test
 * actor rather than a person who left an organization, and the cases it
 * created are the author's own test data, so destroying them here would be
 * a surprise. The confirmation counts every retained row and states exactly
 * what persists.
 *
 * The worker's OWN record is the one thing that does change, and it is stated
 * separately because the count deliberately leaves it out — that count answers
 * "how much of your data stays behind", and the worker's record is Nova's
 * bookkeeping rather than the author's data. Without this line an author sees
 * "no cases owned" and never learns the record closed.
 *
 * The count is fetched when the confirmation opens rather than on every
 * render: it is a real query, and it only matters at the moment of the
 * decision.
 */
"use client";

import { type RefObject, useEffect, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Spinner } from "@/components/shadcn/spinner";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import type { Persona } from "@/lib/domain";
import { countCasesOwnedByAction } from "@/lib/preview/engine/caseDataBinding";
import { useAppId } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";

type OwnedCount =
	| { state: "counting" }
	| { state: "known"; count: number }
	| { state: "failed" };

export function PersonaRemoveConfirm({
	persona,
	returnFocusRef,
}: {
	persona: Persona;
	returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
	const [confirming, setConfirming] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);

	if (!confirming) {
		return (
			<Button
				ref={triggerRef}
				type="button"
				variant="ghost-destructive"
				onClick={() => setConfirming(true)}
				className="self-start"
			>
				Remove persona
			</Button>
		);
	}

	return (
		<ConfirmPanel
			persona={persona}
			panelRef={panelRef}
			returnFocusRef={returnFocusRef}
			onCancel={() => setConfirming(false)}
		/>
	);
}

function ConfirmPanel({
	persona,
	panelRef,
	returnFocusRef,
	onCancel,
}: {
	persona: Persona;
	panelRef: RefObject<HTMLDivElement | null>;
	returnFocusRef: RefObject<HTMLButtonElement | null>;
	onCancel: () => void;
}) {
	const appId = useAppId();
	const mutations = useBlueprintMutations();
	const sessionApi = useBuilderSessionApi();
	const [owned, setOwned] = useState<OwnedCount>({ state: "counting" });
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		void attempt;
		setOwned({ state: "counting" });
		if (appId === undefined) {
			setOwned({ state: "failed" });
			return;
		}
		let live = true;
		const loadOwnedCount = async (): Promise<void> => {
			try {
				const result = await countCasesOwnedByAction({
					appId,
					personaUuid: persona.uuid,
				});
				if (!live) return;
				setOwned(
					result.kind === "count"
						? { state: "known", count: result.count }
						: { state: "failed" },
				);
			} catch {
				if (live) setOwned({ state: "failed" });
			}
		};
		void loadOwnedCount();
		return () => {
			live = false;
		};
	}, [appId, persona.uuid, attempt]);

	return (
		<div
			ref={panelRef}
			tabIndex={-1}
			className="flex flex-col gap-2 rounded-lg border border-nova-rose/40 bg-nova-rose/[0.06] p-3 outline-none"
		>
			<p className="text-[13px] leading-relaxed text-nova-text">
				Remove {persona.name}?
			</p>
			<p
				aria-live="polite"
				className="text-[13px] leading-relaxed text-nova-text-secondary"
			>
				{owned.state === "counting" ? (
					<span className="inline-flex items-center gap-2">
						<Spinner className="size-3.5" />
						Checking which cases they own…
					</span>
				) : owned.state === "failed" ? (
					"Nova couldn't verify every case this persona owns. Try again before removing them."
				) : owned.count === 0 ? (
					`Nova found no cases owned by ${persona.name}, including in retired case types.`
				) : (
					`${persona.name} owns ${owned.count} ${owned.count === 1 ? "case" : "cases"}, including any in retired case types. Removing this persona will not delete or reassign them. They stay stored under this persona and may still appear in unfiltered data views.`
				)}
			</p>
			{owned.state === "known" && (
				<p className="text-[13px] leading-relaxed text-nova-text-secondary">
					Their own worker record closes with them, and everything saved to it
					stays.
				</p>
			)}
			{owned.state === "failed" && (
				<Button
					type="button"
					variant="outline"
					className="self-start"
					onClick={() => setAttempt((value) => value + 1)}
				>
					Try again
				</Button>
			)}
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="destructive"
					disabled={owned.state !== "known"}
					onClick={() => {
						if (owned.state !== "known") return;
						if (!sessionApi.getState().canEdit) return;
						returnFocusRef.current?.focus();
						mutations.removePersona(persona.uuid);
					}}
				>
					Remove
				</Button>
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
