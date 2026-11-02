package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import static org.junit.Assert.*;

/**
 * The advanced forms of targeted-advanced-module, on Nova's local archive and on HQ's build of the HQ import body
 * (the case family's {@code advanced-module.*}: {@code proof/native/producers/emit-case-evidence.ts} writes Nova's
 * forms and suite, {@code proof/native/steps/case_emission.py} HQ's, by {@code XForm.add_case_and_meta_advanced} and
 * HQ's own suite contributors).
 *
 * Each advanced form is opened from its entry in that path's suite, with the loads' cases chosen from their lists
 * and the new cases' ids worked out by Core's session ({@link SuiteFormRun}), filled in, submitted and applied by
 * Core's case transaction parser. What each case must then hold is read from the form's own advanced actions in
 * the HQ import body, HQ's vocabulary for what the form does (part 02 section 7.3 of the step 5 plan): each load
 * updates the case its datum names with the value the form holds at each property's question and closes it where
 * its close condition holds (the household, on "Visit patient"); the worker's load updates the worker's own case;
 * each open action creates its case where its open condition holds, named and written from its questions, with
 * each index naming the case of the tag it names under the relationship it states, once per row in a repeat; and a
 * case an open action creates as an extension is owned by the worker (part 02's G6, outcome A: Nova writes the
 * owner HQ's build would leave unowned).
 *
 * The plausible failure it catches: a datum id or a block path Nova's local suite and form write differently from
 * HQ's build, which per-document proof 3 shows only for a document that holds the shape; and an extension case
 * left unowned. The document must hold each shape, or the run proves nothing of it, so the run first holds that it
 * does.
 */
@RunWith(Parameterized.class)
public class AdvancedFormRuntimeTest {
    private static final String FAMILY = "case";
    private static final String NAME = "advanced-module";

    @Parameterized.Parameters(name = "HQ={0}")
    public static Collection<Object[]> paths() { return Arrays.asList(new Object[][]{{false}, {true}}); }
    private final boolean hq;
    public AdvancedFormRuntimeTest(boolean hq) { this.hq = hq; }

    static JSONObject app(String name) throws Exception {
        try (InputStream input = AdvancedFormRuntimeTest.class.getResourceAsStream("/" + FAMILY + "/" + name + ".json")) {
            assertNotNull("The case family holds no " + name + ".json", input);
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static List<JSONObject> list(JSONObject object, String key) {
        List<JSONObject> found = new ArrayList<>();
        JSONArray array = object.optJSONArray(key);
        if (array != null) for (int i = 0; i < array.length(); i++) found.add(array.getJSONObject(i));
        return found;
    }

    private static boolean autoSelected(JSONObject load) { return load.optJSONObject("auto_select") != null; }

    /** {@code path} read in the row {@code row} of {@code repeat} (1-based), or as it is outside any repeat. */
    private static String inRow(String path, String repeat, int row) {
        if (repeat == null || repeat.isEmpty() || !path.startsWith(repeat + "/")) return path;
        return repeat + "[" + row + "]" + path.substring(repeat.length());
    }

    /** Whether an action's condition holds over the filled form (HQ's {@code FormActionCondition}). */
    private static boolean holds(SuiteFormRun run, JSONObject condition, String repeat, int row) throws Exception {
        String type = condition == null ? "never" : condition.optString("type", "never");
        if ("always".equals(type)) return true;
        if ("never".equals(type)) return false;
        assertEquals("A condition HQ states is always, never or if", "if", type);
        String answer = run.value(inRow(condition.getString("question"), repeat, row));
        String operator = condition.optString("operator", "=");
        if ("=".equals(operator)) return answer.equals(condition.optString("answer"));
        if ("selected".equals(operator)) return Arrays.asList(answer.split(" ")).contains(condition.optString("answer"));
        throw new AssertionError("A condition with the operator " + operator + ", which no Nova form writes");
    }

    /** What one case is expected to hold once the form is applied. */
    private static final class Expected {
        final String id;
        final String action;
        final Map<String, String> properties = new HashMap<>();
        final List<String[]> indices = new ArrayList<>();
        String type;
        String name;
        boolean exists = true;
        boolean closed;
        boolean extension;
        Expected(String id, String action) { this.id = id; this.action = action; }
    }

    private static void properties(SuiteFormRun run, JSONObject action, Expected expected, String repeat, int row) throws Exception {
        JSONObject properties = action.optJSONObject("case_properties");
        if (properties == null) return;
        for (String key : properties.keySet()) {
            // A write through an index reaches another case, which the action's own case does not hold.
            if (key.contains("/")) continue;
            expected.properties.put(key, run.value(inRow(properties.getJSONObject(key).getString("question_path"), repeat, row)));
        }
    }

    private static void holdsCase(SuiteFormRun run, Expected expected) {
        Case record = run.record(expected.id);
        String what = expected.action + " (" + expected.id + ")";
        if (!expected.exists) {
            assertNull(what + " must create no case where its open condition does not hold", record);
            return;
        }
        assertNotNull(what + " left no case in storage", record);
        if (expected.type != null) assertEquals(what, expected.type, record.getTypeId());
        if (expected.name != null) assertEquals(what, expected.name, record.getName());
        for (Map.Entry<String, String> property : expected.properties.entrySet()) {
            String key = property.getKey();
            String held = "name".equals(key) || "case_name".equals(key) ? record.getName()
                : "owner_id".equals(key) ? record.getUserId()
                : record.getPropertyString(key);
            assertEquals(what + " property " + key, property.getValue(), held);
        }
        for (String[] index : expected.indices) {
            CaseIndex found = null;
            for (CaseIndex each : record.getIndices()) if (each.getName().equals(index[0])) found = each;
            assertNotNull(what + " has no index " + index[0], found);
            assertEquals(what + " index " + index[0] + " target", index[1], found.getTarget());
            assertEquals(what + " index " + index[0] + " relationship", index[2], found.getRelationship());
        }
        assertEquals(what + " closed", expected.closed, record.isClosed());
        if (expected.extension) {
            assertEquals(what + " is an extension case, owned by the worker who made it", SuiteFormRun.WORKER, record.getUserId());
        }
    }

    /** Each case one advanced form's actions change, what each must hold, and the shapes the form holds. */
    private static List<Expected> expectations(SuiteFormRun run, JSONObject form, Map<String, Integer> shapes) throws Exception {
        JSONObject actions = form.getJSONObject("actions");
        List<JSONObject> loads = list(actions, "load_update_cases");
        List<JSONObject> opens = list(actions, "open_cases");
        List<Expected> expected = new ArrayList<>();
        Map<String, String> fixed = new HashMap<>();
        for (JSONObject load : loads) {
            String tag = load.getString("case_tag");
            String id = run.datum("case_id_" + tag);
            assertNotNull("The entry sets no datum case_id_" + tag + " for the load " + tag, id);
            fixed.put(tag, id);
            Expected change = new Expected(id, "the load " + tag);
            properties(run, load, change, null, 0);
            change.closed = holds(run, load.optJSONObject("close_condition"), null, 0);
            if (change.closed) shapes.merge("closing load", 1, Integer::sum);
            if (autoSelected(load)) {
                assertEquals("The only load Nova selects automatically is the worker's", "usercase", load.getJSONObject("auto_select").getString("mode"));
                shapes.merge("worker load", 1, Integer::sum);
            }
            expected.add(change);
        }
        Map<String, Integer> indexedInRepeat = new HashMap<>();
        for (int position = 0; position < opens.size(); position++) {
            JSONObject open = opens.get(position);
            String repeat = open.optString("repeat_context", "");
            if (!repeat.isEmpty() && open.optJSONArray("case_indices") != null && open.getJSONArray("case_indices").length() > 0) {
                indexedInRepeat.merge(repeat, 1, Integer::sum);
            }
            if (repeat.isEmpty()) {
                String id = run.datum("case_id_new_" + open.getString("case_type") + "_" + position);
                assertNotNull("The entry sets no datum for the open action " + open.getString("case_tag"), id);
                fixed.put(open.getString("case_tag"), id);
            }
        }
        for (Integer count : indexedInRepeat.values()) if (count > 1) shapes.merge("two indexed opens in a repeat", 1, Integer::sum);
        for (JSONObject open : opens) {
            String tag = open.getString("case_tag");
            String repeat = open.optString("repeat_context", "");
            int rows = repeat.isEmpty() ? 1 : (int)run.count(repeat);
            if (!repeat.isEmpty()) assertTrue("The repeat " + repeat + " was given no row", rows > 0);
            for (int row = 1; row <= rows; row++) {
                String id = repeat.isEmpty() ? fixed.get(tag) : rowCaseId(run, repeat, row, tag);
                Expected change = new Expected(id, "the open action " + tag + (repeat.isEmpty() ? "" : " row " + row));
                change.exists = holds(run, open.optJSONObject("open_condition"), repeat, row);
                change.type = open.getString("case_type");
                change.name = run.value(inRow(open.getJSONObject("name_update").getString("question_path"), repeat, row));
                properties(run, open, change, repeat, row);
                for (JSONObject index : list(open, "case_indices")) {
                    String parentTag = index.getString("tag");
                    String target = fixed.containsKey(parentTag) ? fixed.get(parentTag) : rowCaseId(run, repeat, row, parentTag);
                    String relationship = index.optString("relationship", "child");
                    change.indices.add(new String[]{index.optString("reference_id", "parent"), target, relationship});
                    if ("extension".equals(relationship)) {
                        change.extension = true;
                        shapes.merge("extension index", 1, Integer::sum);
                    }
                }
                change.closed = change.exists && holds(run, open.optJSONObject("close_condition"), repeat, row);
                expected.add(change);
            }
        }
        return expected;
    }

    /** The id the block of the open action {@code tag} holds in one row: its own element where HQ nests it under
     * {@code case_<tag>}, else the row's one block. */
    private static String rowCaseId(SuiteFormRun run, String repeat, int row, String tag) throws Exception {
        String item = repeat + "[" + row + "]";
        String nested = item + "/case_" + tag + "/case/@case_id";
        String id = run.count(nested) == 1 ? run.value(nested) : run.value(item + "/case/@case_id");
        assertFalse("The row " + row + " of " + repeat + " holds no id for " + tag, id.isEmpty());
        return id;
    }

    @Test public void eachAdvancedFormUpdatesItsLoadsAndCreatesItsCasesFromItsSuiteSession() throws Exception {
        JSONObject app = app(NAME);
        Map<String, Integer> shapes = new HashMap<>();
        int forms = 0;
        List<JSONObject> modules = list(app, "modules");
        for (int m = 0; m < modules.size(); m++) {
            List<JSONObject> moduleForms = list(modules.get(m), "forms");
            for (int f = 0; f < moduleForms.size(); f++) {
                JSONObject form = moduleForms.get(f);
                if (!"AdvancedForm".equals(form.getString("doc_type"))) continue;
                forms++;
                String file = NAME + ".m" + m + "f" + f + (hq ? ".hq.xml" : ".xml");
                SuiteFormRun run = new SuiteFormRun(FAMILY, NAME, hq, file, form.getString("xmlns")).fill();
                List<Expected> expected = expectations(run, form, shapes);
                run.apply();
                for (Expected change : expected) holdsCase(run, change);
            }
        }
        assertTrue("targeted-advanced-module holds no advanced form", forms > 0);
        for (String shape : new String[]{"closing load", "worker load", "extension index", "two indexed opens in a repeat"}) {
            assertTrue("targeted-advanced-module's run holds no " + shape + ", which it witnesses: " + shapes, shapes.getOrDefault(shape, 0) > 0);
        }
    }
}
