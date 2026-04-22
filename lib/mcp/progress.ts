/**
 * MCP progress emitter — interface only.
 *
 * The factory (`createProgressEmitter`) and the `ProgressStage` union
 * land with Task C4. Exposing the interface here lets `McpContext` and
 * adapters import a stable type today without circular dependencies or
 * forward-referenced locals.
 */

export interface ProgressEmitter {
	notify(stage: string, message: string, extra?: Record<string, unknown>): void;
}
