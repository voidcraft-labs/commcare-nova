import { pow } from "./vendor/javaMathRuntime.generated.js";

/** OpenJDK 17 fdlibm result for JavaRosa's `Math.pow` XPath function.
 * This small generated entry point stays independent of the worker-only
 * Pattern runtime so ordinary synchronous XPath does not load regex tables. */
export const javaRosaPow = pow;
