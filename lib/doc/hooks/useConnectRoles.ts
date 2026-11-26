"use client";
import type { Uuid } from "@/lib/domain";
import { connectActivitySites } from "@/lib/domain/connectActivitySites";
import { canAskConnectRecipient } from "@/lib/domain/connectRecipientRule";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useConnectRoles() {
	return useBlueprintDoc((state) => state.connectRoles);
}

export function useFormHasConnectActivity(formUuid: Uuid) {
	return useBlueprintDoc(
		(state) =>
			state.connectRoles.length > 0 &&
			connectActivitySites(state, formUuid).length > 0,
	);
}

export function useCanAskConnectRecipient(parentUuid: Uuid) {
	return useBlueprintDoc((doc) => canAskConnectRecipient(doc, parentUuid));
}
