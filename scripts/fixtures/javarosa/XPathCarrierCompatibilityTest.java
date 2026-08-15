package nova.compatibility;

import org.javarosa.core.test.FormParseInit;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xpath.XPathUnhandledException;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

/** Runtime proof for Nova's normalize-space lowering against real Core. */
public class XPathCarrierCompatibilityTest {
    private static String lower(String xpathLiteral) {
        return "replace(replace(" + xpathLiteral
                + ", '[ \\t\\r\\n]+', ' '), '^ | $', '')";
    }

    @Test
    public void rawNormalizeSpaceIsUnhandled() {
        ExprEvalUtils.testEval(
                "normalize-space('  alpha  ')",
                null,
                null,
                new XPathUnhandledException("expected"));
    }

    @Test
    public void loweringCollapsesExactlyXmlWhitespace() {
        ExprEvalUtils.testEval(lower("'  alpha\tbeta\r\ngamma  '"), null, null,
                "alpha beta gamma");
        ExprEvalUtils.testEval(lower("''"), null, null, "");
        ExprEvalUtils.testEval(lower("'   '"), null, null, "");
    }

    @Test
    public void loweringPreservesNonXmlWhitespace() {
        ExprEvalUtils.testEval(lower("'alpha   beta'"), null, null,
                "alpha  beta");
    }

    @Test
    public void emittedCalculateInitializesAndEvaluatesInAnXForm() throws Exception {
        FormParseInit form = new FormParseInit("/nova_normalize_space.xml");

        form.getFormDef().initialize(true, null);

        assertEquals(
                "alpha beta gamma",
                ExprEvalUtils.xpathEval(
                        form.getFormDef().getEvaluationContext(),
                        "/data/normalized"));
    }
}
