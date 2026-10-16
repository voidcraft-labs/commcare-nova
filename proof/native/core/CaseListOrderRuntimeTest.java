package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.commcare.cases.entity.Entity;
import org.commcare.cases.entity.EntitySorter;
import org.commcare.cases.entity.NodeEntityFactory;
import org.commcare.suite.model.Detail;
import org.commcare.suite.model.Suite;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.FormInstance;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.model.xform.XPathReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * The order Core's case list gives a list's rows under each comparator, direction and blanks placement.
 *
 * The checked-in control (resources/case-list-order/orders.json) holds rows of text values, number forms, a blank
 * and a missing property, and for each comparator a sort can name ({@code string}, {@code int}, {@code double}),
 * each direction and each blanks placement, the order of the rows' case ids, with the rows Core holds equal as one
 * group. Each order is read here from a one-field detail Core's own suite parser makes with that {@code <sort>},
 * over one node per row, sorted by Core's {@code EntitySorter} as a device sorts its list. Preview's case store is
 * held to the same file (lib/preview/engine/__tests__/caseListOrder.postgres.test.ts), so a control that drifted from
 * Core fails here before it can mislead Preview. The rows are sorted once in the file's order and once reversed, so a
 * group holds rows Core compares equal rather than rows a stable sort left in place.
 */
public class CaseListOrderRuntimeTest {
    private static final Map<String, String> SORT_TYPES = Map.of("text", "string", "integer", "int", "decimal", "double");

    private static final class Parser extends SuiteParser {
        Parser(InputStream input) throws IOException { super(input, null, "nova-case-list-order", null, true, true, false); }
    }

    private static JSONObject control() throws Exception {
        try (InputStream input = CaseListOrderRuntimeTest.class.getResourceAsStream("/case-list-order/orders.json")) {
            assertNotNull("The case-list-order control is missing from the classpath", input);
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    /** A detail of one field that shows and sorts by the row's {@code value}, as the comparator, direction and blanks say. */
    private static Detail detail(String comparator, String direction, String blanks) throws Exception {
        String type = SORT_TYPES.get(comparator);
        assertNotNull("The control names a comparator no sort type spells: " + comparator, type);
        String suite = "<suite version=\"1\"><detail id=\"rows\"><title><text/></title><field>"
            + "<header><text/></header><template><text><xpath function=\"value\"/></text></template>"
            + "<sort type=\"" + type + "\" order=\"1\" direction=\"" + direction + "\" blanks=\"" + blanks + "\">"
            + "<text><xpath function=\"value\"/></text></sort></field></detail></suite>";
        Suite parsed = new Parser(new ByteArrayInputStream(suite.getBytes(StandardCharsets.UTF_8))).parse();
        Detail detail = parsed.getDetail("rows");
        assertNotNull(detail);
        return detail;
    }

    /** One {@code row} node per control row, in {@code order}: its case id an attribute, its value a child where it has one. */
    private static FormInstance instance(List<JSONObject> order) {
        TreeElement root = new TreeElement("rows");
        for (int i = 0; i < order.size(); i++) {
            JSONObject row = order.get(i);
            TreeElement node = new TreeElement("row", i);
            node.setAttribute(null, "case_id", row.getString("case"));
            if (row.has("value")) {
                TreeElement value = new TreeElement("value", 0);
                value.setValue(new StringData(row.getString("value")));
                node.addChild(value);
            }
            root.addChild(node);
        }
        return new FormInstance(root);
    }

    /** The rows' case ids in the order Core's sorter gives them, over the rows laid out in {@code order}. */
    private static List<String> sorted(Detail detail, List<JSONObject> order) {
        FormInstance instance = instance(order);
        EvaluationContext context = new EvaluationContext(instance);
        NodeEntityFactory factory = new NodeEntityFactory(detail, context);
        List<Entity<TreeReference>> entities = new ArrayList<>();
        for (TreeReference reference : context.expandReference(XPathReference.getPathExpr("/rows/row").getReference())) {
            entities.add(factory.getEntity(reference));
        }
        assertEquals(order.size(), entities.size());
        entities.sort(new EntitySorter(detail.getFields(), false, new int[]{0}, args -> { }));
        List<String> ids = new ArrayList<>();
        for (Entity<TreeReference> entity : entities) {
            ids.add(instance.resolveReference(entity.getElement()).getAttributeValue(null, "case_id"));
        }
        return ids;
    }

    /** The case ids cut into the control's groups, each group as a set, so rows Core holds equal compare in any order. */
    private static List<Set<String>> grouped(List<String> ids, JSONArray groups) {
        List<Set<String>> found = new ArrayList<>();
        int at = 0;
        for (int i = 0; i < groups.length(); i++) {
            int size = groups.getJSONArray(i).length();
            assertTrue("The control's groups hold more rows than Core sorted", at + size <= ids.size());
            found.add(new HashSet<>(ids.subList(at, at + size)));
            at += size;
        }
        assertEquals("The control's groups hold fewer rows than Core sorted", ids.size(), at);
        return found;
    }

    private static List<Set<String>> expected(JSONArray groups) {
        List<Set<String>> found = new ArrayList<>();
        for (int i = 0; i < groups.length(); i++) {
            Set<String> group = new HashSet<>();
            for (Object id : groups.getJSONArray(i)) group.add((String)id);
            found.add(group);
        }
        return found;
    }

    @Test public void coreOrdersTheControlsRowsAsTheControlStates() throws Exception {
        JSONArray sets = control().getJSONArray("sets");
        assertTrue(sets.length() > 0);
        int checked = 0;
        for (int s = 0; s < sets.length(); s++) {
            JSONObject set = sets.getJSONObject(s);
            List<JSONObject> rows = new ArrayList<>();
            for (int i = 0; i < set.getJSONArray("rows").length(); i++) rows.add(set.getJSONArray("rows").getJSONObject(i));
            List<JSONObject> reversed = new ArrayList<>(rows);
            Collections.reverse(reversed);
            JSONArray orders = set.getJSONArray("orders");
            for (int o = 0; o < orders.length(); o++) {
                JSONObject order = orders.getJSONObject(o);
                String name = set.getString("name") + " " + order.getString("comparator") + " " + order.getString("direction")
                    + " blanks " + order.getString("blanks");
                Detail detail = detail(order.getString("comparator"), order.getString("direction"), order.getString("blanks"));
                List<Set<String>> want = expected(order.getJSONArray("groups"));
                assertEquals(name, want, grouped(sorted(detail, rows), order.getJSONArray("groups")));
                assertEquals(name + ", the rows laid out in reverse", want, grouped(sorted(detail, reversed), order.getJSONArray("groups")));
                checked++;
            }
        }
        // Every comparator in both directions and both blanks placements.
        assertEquals(12, checked);
    }
}
