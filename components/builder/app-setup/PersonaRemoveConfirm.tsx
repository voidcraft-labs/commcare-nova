/**
 * Removing a persona, with the consequence stated before it happens.
 *
 * Cases the persona owns are deliberately left where they are. That is
 * Nova's own rule rather than HQ parity — HQ deactivating a worker leaves
 * their cases alone, but HQ DELETING one soft-deletes every case they own
 * (`users/models.py::CommCareUser.retire`). A persona is a design and test
 * actor rather than a person who left an organization, and the cases it
 * created are the author's own test data, so destroying them here would be
 * a surprise. The confirmation counts them and says plainly that nobody
 * will see them until they are given a new owner.
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
import { useMaterializableCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import type { Uuid } from "@/lib/doc/types";
import type { Persona } from "@/lib/domain";
import { countCasesOwnedByAction } from "@/lib/preview/engine/caseDataBinding";
import { useAppId } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";

type OwnedCount =
	| { state: "counting" }
	| { state: "known"; count: number }
	| { state: "unknown" };

export function PersonaRemoveConfirm({ persona }: { persona: Persona }) {
	const [confirming, setConfirming] = useState(false);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirming);

	if (!confirming) {
		return (
			<Button
				ref={triggerRef}
				type="button"
				variant="ghost"
				size="lg"
				onClick={() => setConfirming(true)}
				className="h-11 self-start px-2.5 text-[13px] text-nova-rose hover:bg-nova-rose/[0.1] hover:text-nova-rose"
			>
				Remove persona
			</Button>
		);
	}

	return (
		<ConfirmPanel
			persona={persona}
			panelRef={panelRef}
			onCancel={() => setConfirming(false)}
		/>
	);
}

function ConfirmPanel({
	persona,
	panelRef,
	onCancel,
}: {
	persona: Persona;
	panelRef: RefObject<HTMLDivElement | null>;
	onCancel: () => void;
}) {
	const appId = useAppId();
	const caseTypes = useMaterializableCaseTypes();
	const mutations = useBlueprintMutations();
	const sessionApi = useBuilderSessionApi();
	const [owned, setOwned] = useState<OwnedCount>({ state: "counting" });

	useEffect(() => {
		if (appId === undefined) {
			setOwned({ state: "unknown" });
			return;
		}
		let live = true;
		void countCasesOwnedByAction({
			appId,
			ownerId: persona.uuid,
			caseTypes: caseTypes.map((t) => t.name),
		}).then((result) => {
			if (!live) return;
			setOwned(
				result.kind === "count"
					? { state: "known", count: result.count }
					: { state: "unknown" },
			);
		});
		return () => {
			live = false;
		};
	}, [appId, persona.uuid, caseTypes]);

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
				) : owned.state === "unknown" ? (
					"Their cases stay where they are. Nova could not reach the case store to count them just now."
				) : owned.count === 0 ? (
					"They own no cases."
				) : (
					`They own ${owned.count} ${owned.count === 1 ? "case" : "cases"}. Those cases stay where they are, still owned by ${persona.name}, and nobody will see them in Preview until you give them a new owner.`
				)}
			</p>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="destructive"
					size="lg"
					className="h-11"
					onClick={() => {
						if (!sessionApi.getState().canEdit) return;
						mutations.removePersona(persona.uuid as Uuid);
					}}
				>
					Remove
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="lg"
					className="h-11"
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}
