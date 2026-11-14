package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Hashtable;
import org.commcare.cases.model.Case;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.DataInstance;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.FormInstance;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Run E1: the reader's equivalence table (lib/commcare/reader/syntaxCompare.ts)
 * read by Core. Each vector of
 * lib/commcare/reader/expressions/__tests__/spellingVectors.ts, written by the
 * expression producer as /expression/reader-spelling.json, holds two spellings;
 * Core parses each with its own XPathParseTool.parseXPath and evaluates both
 * over one instance, and the two must answer alike. A negative control's two
 * spellings must answer apart, each as the vector says: Core's casedb holds a
 * case's name as case_name and answers a name step with a blank node
 * (CaseChildElement.getChildrenWithName), so the table holds no row for them.
 *
 * Plausible failures: a lexical spelling Core reads as another token (a form
 * feed, a trailing decimal point), an axis Core resolves to another node, a
 * cond Core evaluates eagerly where if is lazy, and a casedb that aliases name.
 */
public class ReaderSpellingRuntimeTest {
    private static JSONObject vectors() throws Exception {
        try (InputStream input = ReaderSpellingRuntimeTest.class.getResourceAsStream("/expression/reader-spelling.json")) {
            assertNotNull("The expression producer did not supply reader-spelling.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown reader spelling vectors version", 1, result.getInt("schemaVersion"));
            return result;
        }
    }

    private static TreeElement node(String name, int mult, String value) {
        TreeElement element = new TreeElement(name, mult);
        if (value != null) element.setValue(new StringData(value));
        return element;
    }

    /** /data with a, b, c and three x rows, the first carrying @id. */
    private static FormInstance main() {
        TreeElement data = new TreeElement("data", 0);
        data.addChild(node("a", 0, "1"));
        data.addChild(node("b", 0, "2"));
        data.addChild(node("c", 0, "x y"));
        String[] values = {"a", "b", "c"};
        for (int i = 0; i < values.length; i++) {
            TreeElement row = node("x", i, values[i]);
            if (i == 0) row.setAttribute(null, "id", "r1");
            data.addChild(row);
        }
        return new FormInstance(data);
    }

    /** A case database holding the one case c1, named Asha. */
    private static Hashtable<String, DataInstance> casedb() {
        MockUserDataSandbox sandbox = MockDataUtils.getStaticStorage();
        Case record = new Case("Asha", "patient");
        record.setCaseId("c1");
        record.setUserId("owner");
        sandbox.getCaseStorage().write(record);
        TestInstanceInitializer initializer = new TestInstanceInitializer(sandbox);
        ExternalDataInstance declared = initializer.getSpecializedExternalDataInstance(
            new ExternalDataInstance("jr://instance/casedb", "casedb"));
        Hashtable<String, DataInstance> instances = new Hashtable<>();
        instances.put("casedb", declared.initialize(initializer, "casedb"));
        return instances;
    }

    private static String answer(String xpath, EvaluationContext context, String message) {
        Object value;
        try {
            value = FunctionUtils.unpack(XPathParseTool.parseXPath(xpath).eval(context.getMainInstance(), context));
        } catch (Exception failure) {
            throw new AssertionError(message + ": Core could not evaluate " + xpath, failure);
        }
        return FunctionUtils.toString(value);
    }

    @Test public void everyRowsTwoSpellingsAnswerAlikeAndEachControlApart() throws Exception {
        JSONArray rows = vectors().getJSONArray("vectors");
        assertTrue("The spelling vectors are empty", rows.length() > 0);
        boolean sawControl = false;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.getJSONObject(i);
            String message = row.getString("row") + ": " + row.getString("name");
            FormInstance instance = main();
            EvaluationContext context = row.optBoolean("casedb")
                ? new EvaluationContext(instance, casedb())
                : new EvaluationContext(instance);
            String a = answer(row.getString("a"), context, message);
            String b = answer(row.getString("b"), context, message);
            JSONObject apart = row.optJSONObject("apart");
            if (apart == null) {
                assertEquals(message, a, b);
                continue;
            }
            sawControl = true;
            assertEquals(message + " (first spelling)", apart.getString("a"), a);
            assertEquals(message + " (second spelling)", apart.getString("b"), b);
        }
        assertTrue("The spelling vectors hold no negative control", sawControl);
    }
}
