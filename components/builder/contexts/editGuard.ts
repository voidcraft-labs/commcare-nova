/** One current edit guard, shared by registration and navigation consultation. */
export type EditGuardPredicate = () => boolean;
export interface EditGuardApi {
	register(predicate: EditGuardPredicate): () => void;
	consult(): boolean;
}
export function createEditGuard(): EditGuardApi {
	let predicate: EditGuardPredicate | null = null;
	return {
		register(next) {
			predicate = next;
			return () => {
				if (predicate === next) predicate = null;
			};
		},
		consult() {
			return predicate?.() ?? true;
		},
	};
}
