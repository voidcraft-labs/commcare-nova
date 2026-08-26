package org.commcare.nova.xpath;

import org.teavm.jso.JSBody;

/** Browser-owned NFC boundary used by Java Pattern's inline CANON_EQ flag. */
public final class BrowserNormalizer {
    private BrowserNormalizer() {
    }

    @JSBody(params = "value", script = "return value.normalize('NFC');")
    public static native String normalizeNfc(String value);
}
