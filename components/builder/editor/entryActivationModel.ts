/** One pending optional editor per field/section. Changing scope forgets it. */
export interface EntryActivationState {
	readonly scope: string;
	readonly key: string | null;
}
export type EntryActivationEvent =
	| { readonly type: "scope"; readonly scope: string }
	| { readonly type: "activate"; readonly scope: string; readonly key: string }
	| { readonly type: "clear" };
export function reduceEntryActivation(
	state: EntryActivationState,
	event: EntryActivationEvent,
): EntryActivationState {
	switch (event.type) {
		case "scope":
			return state.scope === event.scope
				? state
				: { scope: event.scope, key: null };
		case "activate":
			return { scope: event.scope, key: event.key };
		case "clear":
			return state.key === null ? state : { ...state, key: null };
	}
}
