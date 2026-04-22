/**
 * MCP progress emitter — interface only.
 *
 * Exposes the emitter contract so tool adapters can type their progress
 * dependency without pulling in a concrete implementation. A factory
 * (`createProgressEmitter`) and a stage-taxonomy union will live in this
 * same module once a runtime sender ships; consumers that only need the
 * type are decoupled from that evolution.
 */

export interface ProgressEmitter {
	notify(stage: string, message: string, extra?: Record<string, unknown>): void;
}
