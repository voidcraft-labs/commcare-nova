/** The CSQL position model the emitter, the fold and Preview read. Its core
 * lives in the domain so the type checker reads the same assignment
 * (`lib/domain/expression/csqlPositions.ts`). */
export {
	type CsqlPosition,
	type CsqlPositionMap,
	type CsqlRuntimeRoot,
	csqlPositionAt,
	csqlPositionKey,
	csqlPositions,
	csqlRuntimeRoots,
	isCsqlQueryAnchor,
	isCsqlServerValueFunction,
	isRuntimeSubtreeRoot,
	readsSearchRow,
} from "@/lib/domain/expression/csqlPositions";
