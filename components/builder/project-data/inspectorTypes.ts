import type { ReactNode } from "react";

/**
 * What a selection source hands the rail.
 *
 * Declared here rather than imported from `activeInspector.tsx` so this
 * package does not depend on the module that consumes it: the rail composes
 * the sources, not the other way round.
 */
export interface ActiveInspectorDescriptor {
	readonly kicker: string;
	readonly title: string;
	readonly body: ReactNode;
}
