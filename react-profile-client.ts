/**
 * Development-only React DevTools entrypoint.
 *
 * Next's generated instrumentation registry loads configured entries through
 * `require()`, while agent-react-devtools exposes its connector only under an
 * ESM `import` condition. Making the registry entry app-owned lets Turbopack
 * compile this static import under the correct condition, still before React
 * hydration. `next.config.ts` omits this module unless the guarded local
 * profiling environment is enabled.
 */
import "agent-react-devtools/connect";
