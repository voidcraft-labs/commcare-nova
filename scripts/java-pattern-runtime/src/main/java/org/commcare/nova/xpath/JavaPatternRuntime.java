package org.commcare.nova.xpath;

import org.commcare.nova.xpath.openjdkmath.FdLibmPow;
import org.commcare.nova.xpath.openjdkregex.Matcher;
import org.commcare.nova.xpath.openjdkregex.Pattern;
import org.teavm.jso.JSExport;

/** The only Java-to-browser bridge. Compatibility operations remain inside
 * their pinned OpenJDK 17 implementations. */
public final class JavaPatternRuntime {
    private JavaPatternRuntime() {
    }

    @JSExport
    public static boolean find(String input, String pattern) {
        return Pattern.compile(pattern).matcher(input).find();
    }

    @JSExport
    public static String replaceAllLiteral(String input, String pattern, String replacement) {
        return Pattern.compile(pattern).matcher(input)
                .replaceAll(Matcher.quoteReplacement(replacement));
    }

    @JSExport
    public static double pow(double base, double exponent) {
        return FdLibmPow.compute(base, exponent);
    }
}
