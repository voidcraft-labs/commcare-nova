package org.commcare.nova.xpath;

import org.commcare.nova.xpath.openjdkmath.FdLibmPow;
import org.teavm.jso.JSExport;

/** The fdlibm-only browser bridge. Keeping this entry point separate from
 * {@link JavaPatternRuntime} prevents ordinary synchronous XPath arithmetic
 * from loading OpenJDK's complete regular-expression engine. */
public final class JavaMathRuntime {
    private JavaMathRuntime() {
    }

    @JSExport
    public static double pow(double base, double exponent) {
        return FdLibmPow.compute(base, exponent);
    }
}
