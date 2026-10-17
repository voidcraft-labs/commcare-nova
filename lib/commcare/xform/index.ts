/**
 * Barrel for the XForm emitter sub-package.
 *
 * Keeps the XForm module private from the rest of the codebase —
 * callers import `buildXForm` / `buildXFormSource` from
 * `@/lib/commcare/xform`; the file layout under `./builder.ts` stays an
 * implementation detail.
 */

export {
	type BuildXFormOptions,
	buildXForm,
	buildXFormSource,
	type XFormSource,
} from "./builder";
