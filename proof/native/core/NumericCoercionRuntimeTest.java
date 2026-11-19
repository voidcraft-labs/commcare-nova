package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.FormInstance;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Core's own `=` and `!=` over the comparisons Nova's record rules admit across two types, read from the checked-in
 * control (resources/numeric-coercion/comparisons.json): a node of text against a number, which
 * XPathEqExpr.testEquality compares through FunctionUtils.toNumeric (trimmed, digits with a minus and a point, else
 * a year-month-day date's day number, else NaN), and a node holding a whole number's text as CommCare writes it
 * against that text, which it compares as text. Each node is one value of a case property as a device holds it, a
 * text node, and a row with no value is a property the case lacks. Nova's case store is held to the same file
 * (lib/case-store/sql/__tests__/recordCoercions.postgres.test.ts), so a control that drifted from Core fails here
 * before it can mislead the store.
 */
public class NumericCoercionRuntimeTest {
    private static JSONObject control() throws Exception {
        try (InputStream input = NumericCoercionRuntimeTest.class.getResourceAsStream("/numeric-coercion/comparisons.json")) {
            assertNotNull("The numeric-coercion control is missing from the classpath", input);
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    /** Core's answer to {@code expression} over a {@code data} root holding {@code value} as its one {@code value} node, or no such node. */
    private static boolean holds(String value, String expression) throws Exception {
        TreeElement root = new TreeElement("data", 0);
        if (value != null) {
            TreeElement node = new TreeElement("value", 0);
            node.setValue(new StringData(value));
            root.addChild(node);
        }
        FormInstance instance = new FormInstance(root);
        Object result = XPathParseTool.parseXPath(expression).eval(instance, new EvaluationContext(instance));
        return FunctionUtils.toBoolean(result);
    }

    private static Set<String> named(JSONArray cases) {
        Set<String> result = new HashSet<>();
        for (int i = 0; i < cases.length(); i++) result.add(cases.getString(i));
        return result;
    }

    /** The number as an XPath literal: a whole number without a point, as Nova's emitter prints one. */
    private static String numberLiteral(double number) {
        return number == Math.rint(number) ? Long.toString((long) number) : Double.toString(number);
    }

    @Test
    public void textAgainstANumberIsReadAsTheNumberCoreReadsIt() throws Exception {
        JSONObject control = control();
        JSONArray texts = control.getJSONArray("texts");
        JSONArray numbers = control.getJSONArray("numbers");
        assertTrue("The control holds no number to compare with", numbers.length() > 0);
        for (int n = 0; n < numbers.length(); n++) {
            JSONObject row = numbers.getJSONObject(n);
            String literal = numberLiteral(row.getDouble("number"));
            Set<String> equal = named(row.getJSONArray("equal"));
            for (int t = 0; t < texts.length(); t++) {
                JSONObject text = texts.getJSONObject(t);
                String value = text.has("value") ? text.getString("value") : null;
                String name = text.getString("case");
                assertEquals(name + " = " + literal, equal.contains(name), holds(value, "/data/value = " + literal));
                assertEquals(name + " != " + literal, !equal.contains(name), holds(value, "/data/value != " + literal));
            }
        }
    }

    @Test
    public void aWholeNumberAgainstItsTextIsComparedAsText() throws Exception {
        JSONObject control = control();
        JSONArray wholeNumbers = control.getJSONArray("wholeNumbers");
        JSONArray texts = control.getJSONArray("wholeNumberTexts");
        for (int n = 0; n < texts.length(); n++) {
            JSONObject row = texts.getJSONObject(n);
            String literal = "'" + row.getString("text") + "'";
            Set<String> equal = named(row.getJSONArray("equal"));
            for (int w = 0; w < wholeNumbers.length(); w++) {
                JSONObject whole = wholeNumbers.getJSONObject(w);
                // A device holds the text IntegerData writes for a whole number, Integer.toString.
                String value = whole.has("value") ? Integer.toString(whole.getInt("value")) : null;
                String name = whole.getString("case");
                assertEquals(name + " = " + literal, equal.contains(name), holds(value, "/data/value = " + literal));
                assertEquals(name + " != " + literal, !equal.contains(name), holds(value, "/data/value != " + literal));
            }
        }
    }
}
