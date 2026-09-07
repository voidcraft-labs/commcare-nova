package nova.compatibility;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Hashtable;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.DataInstance;
import org.javarosa.core.model.instance.FormInstance;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.model.xform.XPathReference;
import org.javarosa.test_utils.ExprEvalUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Executes current emitter output on real Core trees. No HQ/app-install claim. */
public class PredicateRuntimeTest {
    private static TreeElement node(String name, String value) {
        TreeElement result = new TreeElement(name, 0);
        if (value != null) result.setValue(new StringData(value));
        return result;
    }
    private static TreeElement record(int index, String id, String type, String parent) {
        TreeElement result = new TreeElement("case", index);
        result.setAttribute(null, "case_id", id);
        result.setAttribute(null, "case_type", type);
        if (parent != null) {
            TreeElement indices = node("index", null);
            indices.addChild(node("parent", parent));
            result.addChild(indices);
        }
        return result;
    }
    private static EvaluationContext context(String location, boolean queryPresent) {
        TreeElement cases = node("casedb", null);
        TreeElement patient = record(0, "patient-1", "patient", "household-1");
        for (String[] property : new String[][]{
            {"case_name", "O'Brien \"quoted\""}, {"age", "18"}, {"empty", ""},
            {"active", "true"}, {"full_name", "Alice Smith"}, {"tags", "vip frequent"},
            {"region", "north"}, {"username", "ada"}, {"location", location}
        }) patient.addChild(node(property[0], property[1]));
        cases.addChild(patient);
        TreeElement household = record(1, "household-1", "household", null);
        household.addChild(node("region", "south"));
        cases.addChild(household);
        for (int index = 0; index < 2; index++) {
            TreeElement visit = record(index + 2, "visit-" + index, "visit", "patient-1");
            visit.addChild(node("outcome", index == 0 ? "open" : "closed"));
            visit.addChild(node("rating", index == 0 ? "1" : "5"));
            cases.addChild(visit);
        }
        TreeElement session = node("session", null);
        TreeElement user = node("user", null), data = node("data", null), details = node("context", null);
        data.addChild(node("region", "north")); user.addChild(data); session.addChild(user);
        details.addChild(node("username", "ada")); session.addChild(details);
        TreeElement input = node("input", null);
        if (queryPresent) {
            TreeElement field = node("field", "north"); field.setAttribute(null, "name", "query"); input.addChild(field);
        }
        FormInstance main = new FormInstance(cases);
        Hashtable<String, DataInstance> instances = new Hashtable<>();
        instances.put("casedb", new FormInstance(cases.deepCopy(true), "casedb"));
        instances.put("commcaresession", new FormInstance(session, "commcaresession"));
        instances.put("search-input:results", new FormInstance(input, "search-input:results"));
        return new EvaluationContext(new EvaluationContext(main, instances), XPathReference.getPathExpr("/casedb/case[1]").getReference());
    }
    private static String decode(String text) { return new String(Base64.getDecoder().decode(text), StandardCharsets.UTF_8); }
    @Test public void executesPredicatesAndRejectsMalformedGpsWithoutThrowing() throws Exception {
        int checked = 0;
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(getClass().getResourceAsStream("/predicate-corpus.tsv"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String[] values = line.split("\t", -1);
                assertEquals(5, values.length);
                try { assertEquals(values[0] + ": " + decode(values[2]), Boolean.valueOf(values[1]),
                    ExprEvalUtils.xpathEval(context(decode(values[3]), Boolean.parseBoolean(values[4])), decode(values[2]))); }
                catch (Exception error) { throw new AssertionError(values[0] + ": " + decode(values[2]), error); }
                checked++;
            }
        }
        int expected = Integer.parseInt(new String(getClass().getResourceAsStream("/predicate-corpus-count.txt").readAllBytes(), StandardCharsets.UTF_8));
        assertTrue("Bounded corpus must cover the operator families", expected >= 45);
        assertEquals(expected, checked);
    }
}
