/** Ordered rows on one worker's device. A place and a classic group can
 * contribute separate rows, including repeated ids in a supplied restore. */
export interface WorkerGroupRow {
	readonly id: string;
	readonly name: string;
	readonly details: readonly { key: string; value: string }[];
}
