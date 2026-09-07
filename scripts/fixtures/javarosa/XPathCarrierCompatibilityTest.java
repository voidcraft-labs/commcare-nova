package nova.compatibility;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.xpath.parser.XPathSyntaxException;
import org.javarosa.xpath.expr.XPathPathExpr;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.XPathUnhandledException;
import org.javarosa.xpath.expr.XPathCustomRuntimeFunc;
import org.junit.Test;
import static org.junit.Assert.*;

/** Reads current Nova-produced programs. Never reconstruct a lowerer in Java. */
public class XPathCarrierCompatibilityTest {
    private static String decode(String value) { return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8); }
    private FormDef form() throws Exception {
        FormDef form = new FormParseInit("/xpath-context.xml").getFormDef();
        form.initialize(true, new InstanceInitializationFactory() {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                assertEquals("commcaresession", instance.getInstanceId());
                TreeElement session = new TreeElement("session", 0);
                TreeElement context = new TreeElement("context", 0);
                for (String key : new String[]{"deviceid", "username", "userid", "appversion", "drift"}) {
                    TreeElement node = new TreeElement(key, 0);
                    node.setValue(new StringData("drift".equals(key) ? "0" : "fixture-" + key));
                    context.addChild(node);
                }
                session.addChild(context);
                InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), instance.getBase());
                return new ConcreteInstanceRoot(session);
            }
        });
        return form;
    }
    @Test public void rawNormalizeSpaceIsUnhandled() {
        ExprEvalUtils.testEval("normalize-space('  alpha  ')", null, null, new XPathUnhandledException("expected"));
    }
    @Test public void executesCurrentProductionLoweringsAndClassifiesActualNativePaths() throws Exception {
        FormDef form = form();
        EvaluationContext context = new EvaluationContext(form.getEvaluationContext(), ((XPathPathExpr)XPathParseTool.parseXPath("/data")).getReference());
        int accepted = 0;
        int rejected = 0;
        try (InputStream input = getClass().getResourceAsStream("/xpath-corpus.tsv")) {
            assertNotNull("Run the Nova XPath producer first", input);
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                String row;
                while ((row = reader.readLine()) != null) {
                    String[] values = row.split("\\t", -1);
                    assertEquals(4, values.length);
                    String expression = decode(values[2]);
                    if ("reject".equals(values[1])) {
                        Exception failure = null;
                        try { ExprEvalUtils.xpathEval(context, expression); }
                        catch (Exception error) { failure = error; }
                        assertNotNull("Native runtime accepted: " + expression, failure);
                        rejected++;
                    } else {
                        Object expected = "number".equals(values[1]) ? Double.valueOf(decode(values[3])) : "boolean".equals(values[1]) ? Boolean.valueOf(decode(values[3])) : decode(values[3]);
                        assertEquals(values[0] + ": " + expression, expected, ExprEvalUtils.xpathEval(context, expression));
                        accepted++;
                    }
                }
            }
        }
        assertEquals(22, accepted);
        assertEquals(14, rejected);
        assertEquals("alpha beta gamma", ExprEvalUtils.xpathEval(form.getEvaluationContext(), "string(/data/normalized)"));
    }
    @Test public void everyClaimedNativeFunctionUsesCoresBuiltInDispatch() throws Exception {
        int checked = 0;
        try (InputStream input = getClass().getResourceAsStream("/native-functions.txt")) {
            assertNotNull("Missing current Nova function table", input);
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                String name;
                while ((name = reader.readLine()) != null) {
                    assertTrue(name, name.matches("[a-z][a-z0-9-]*"));
                    try { assertFalse(name, XPathParseTool.parseXPath(name + "()") instanceof XPathCustomRuntimeFunc); }
                    catch (XPathSyntaxException expected) {
                        // A built-in constructor rejected the arity before eval;
                        // unknown functions parse into the custom-handler fallback.
                    }
                    checked++;
                }
            }
        }
        assertTrue("Function table must not be empty", checked > 0);
        assertTrue(XPathParseTool.parseXPath("unknown_function()") instanceof XPathCustomRuntimeFunc);
    }
    @Test public void authoredArityAdmissionMatchesTheNativeParser() throws Exception {
        int checked = 0;
        try (InputStream input = getClass().getResourceAsStream("/native-signatures.tsv")) {
            assertNotNull("Missing current Nova signatures", input);
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                String row;
                while ((row = reader.readLine()) != null) {
                    String[] fields = row.split("\\t", -1);
                    String source = decode(fields[0]);
                    boolean accepted = true;
                    try { XPathParseTool.parseXPath(source); }
                    catch (XPathSyntaxException expected) { accepted = false; }
                    assertEquals(source, Boolean.parseBoolean(fields[1]), accepted);
                    checked++;
                }
            }
        }
        assertTrue("No arities checked", checked > 0);
    }

}
