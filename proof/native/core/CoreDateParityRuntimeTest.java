package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.HashSet;
import java.util.Set;
import java.util.TimeZone;
import java.util.Vector;
import org.commcare.util.DefaultArrayDataSource;
import org.commcare.util.LocaleArrayDataSource;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.condition.IFunctionHandler;
import org.javarosa.core.model.data.DateData;
import org.javarosa.core.model.data.DateTimeData;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.data.UncastData;
import org.javarosa.core.model.instance.FormInstance;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.utils.DateUtils;
import org.javarosa.xform.util.CalendarUtils;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Core's own date behaviour in one device zone, over the table Preview's
 * evaluator is held to in Vitest (lib/preview/xpath/__tests__/fixtures/coreDateParity.ts,
 * written here as /expression/core-date-parity.json). Each zone runs in a test
 * JVM started in it, because DateUtils fixes its 1970 epoch when it loads; the
 * zone has no browser provider, as on a device.
 */
public class CoreDateParityRuntimeTest {
    private static final String NOW_DEFAULT_ROW = "cast-now-default-repeated-hour";

    private static JSONObject table() throws Exception {
        try (InputStream input = CoreDateParityRuntimeTest.class.getResourceAsStream("/expression/core-date-parity.json")) {
            assertNotNull("The expression producer did not supply core-date-parity.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown date parity table version", 2, result.getInt("schemaVersion"));
            return result;
        }
    }

    /** The JVM's own zone is the device's: the named setup, user.timezone, and no DateUtils provider. */
    private static String deviceZone(JSONObject table) {
        String label = System.getProperty("nova.proof.zone.label");
        assertNotNull("This class must run through a named native zone setup", label);
        String jvmId = System.getProperty("nova.proof.zone.jvm");
        assertNotNull("The native runner did not supply the JVM zone", jvmId);
        assertEquals("The JVM was started in the wrong zone", jvmId, TimeZone.getDefault().getID());
        assertEquals("The native runner must set user.timezone", jvmId, System.getProperty("user.timezone"));
        assertEquals("Date parity runs only in device zones, never behind a Formplayer provider",
            "", System.getProperty("nova.proof.zone.provider", ""));
        assertFalse("Date parity runs only in device zones, never with an offset-only provider",
            Boolean.parseBoolean(System.getProperty("nova.proof.zone.offsetOnly", "false")));
        DateUtils.resetTimezoneProvider();
        assertNull("A device zone has no named DateUtils zone", DateUtils.timezone());
        JSONObject zones = table.getJSONObject("zones");
        assertTrue("The table has no column for zone " + label, zones.has(label));
        assertEquals("The table's column names another zone", zones.getString(label), jvmId);
        return label;
    }

    /** XPathFuncExpr.evalRaw consults a handler before the built-in evalBody, so
     * now() and today() read the controlled clock exactly as their bodies would. */
    private static IFunctionHandler clockHandler(String name, Date value) {
        return new IFunctionHandler() {
            @Override public String getName() { return name; }
            @Override public Vector<Class[]> getPrototypes() {
                Vector<Class[]> result = new Vector<>();
                result.add(new Class[0]);
                return result;
            }
            @Override public boolean rawArgs() { return false; }
            @Override public Object eval(Object[] args, EvaluationContext ignored) { return new Date(value.getTime()); }
        };
    }

    /** Each node as the device holds it (the fixture's header names the four storages). */
    private static TreeElement node(JSONObject spec) {
        TreeElement element = new TreeElement(spec.getString("name"), 0);
        String held = spec.getString("held");
        String value = spec.getString("value");
        switch (held) {
            case "datetime": {
                Instant instant = Instant.parse(value);
                assertEquals("Typed answers have millisecond precision", 0, instant.getNano() % 1_000_000);
                element.setValue(new DateTimeData(Date.from(instant)));
                break;
            }
            case "date": {
                Date date = DateUtils.parseDate(value);
                assertNotNull("Core does not read the date " + value, date);
                element.setValue(new DateData(date));
                break;
            }
            case "text":
                // An empty answer is a blank node, which unpacks to "".
                if (!value.isEmpty()) element.setValue(new StringData(value));
                break;
            case "setvalue-datetime":
                // SetValueAction.processAction casts written text through the bind's template.
                element.setValue(new DateTimeData().cast(new UncastData(value)));
                break;
            default:
                throw new AssertionError("Unknown node storage: " + held);
        }
        return element;
    }

    @Test public void dateFunctionsAndCoercionsMatchThePreviewTable() throws Exception {
        JSONObject input = table();
        try {
            String label = deviceZone(input);
            Instant clock = Instant.parse(input.getString("fixedClock"));
            // Core's default month names, without a localization locale.
            CalendarUtils.setArrayDataSource(new DefaultArrayDataSource());
            JSONArray rows = input.getJSONArray("rows");
            Set<String> ids = new HashSet<>();
            for (int index = 0; index < rows.length(); index++) {
                JSONObject row = rows.getJSONObject(index);
                String id = row.getString("id");
                String xpath = row.getString("xpath");
                assertTrue("Duplicate date parity row: " + id, ids.add(id));
                TreeElement root = new TreeElement("data", 0);
                JSONArray nodes = row.optJSONArray("nodes");
                for (int n = 0; nodes != null && n < nodes.length(); n++) {
                    root.addChild(node(nodes.getJSONObject(n)));
                }
                if (id.equals(NOW_DEFAULT_ROW) && label.equals("new-york")) {
                    // The row's text is what Core's uncast writes for now() here.
                    assertEquals("The now() default row must hold Core's own uncast of the clock",
                        new DateTimeData(Date.from(clock)).uncast().getString(),
                        nodes.getJSONObject(0).getString("value"));
                }
                FormInstance instance = new FormInstance(root);
                EvaluationContext context = new EvaluationContext(instance);
                context.addFunctionHandler(clockHandler("now", Date.from(clock)));
                context.addFunctionHandler(clockHandler("today", DateUtils.roundDate(Date.from(clock))));
                String message = label + ": " + id + ": " + xpath;
                if (row.has("throws")) {
                    // A refused row names the exception Core's own evaluation throws.
                    assertFalse("A refused row has no value: " + id, row.has("expect"));
                    String refusal = row.getString("throws");
                    try {
                        Object refused = XPathParseTool.parseXPath(xpath).eval(instance, context);
                        fail(message + ": Core was expected to throw " + refusal + ", and gave "
                            + (refused == null ? "null" : refused.toString()));
                    } catch (Exception failure) {
                        assertEquals(message, refusal, failure.getClass().getSimpleName());
                    }
                    continue;
                }
                String expected = row.getJSONObject("expect").getString(label);
                Object result;
                try {
                    result = FunctionUtils.unpack(XPathParseTool.parseXPath(xpath).eval(instance, context));
                } catch (Exception failure) {
                    throw new AssertionError(message, failure);
                }
                if (result instanceof Double) {
                    assertEquals(message, Double.parseDouble(expected), (Double)result, 1e-9);
                } else if (result instanceof String) {
                    assertEquals(message, expected, result);
                } else {
                    fail(message + ": a row must produce a number or text, not " + (result == null ? "null" : result.getClass().getName()));
                }
            }
            for (String required : new String[]{"core-day-20453", "core-day-20453.7", "core-days-2026-01-01",
                "o2a", "o2b", "o2c", "o2d", "r3", "r4", "r10", "d5", "d7", "d8", "cast-repeated-hour",
                "cast-z-day-late", "cast-skipped-hour", NOW_DEFAULT_ROW, "blank-date", "blank-format-date",
                "julian-days", "julian-text", "julian-weekday", "julian-day-number", "cutover-gap",
                "cutover-next-day", "year-50-text", "far-day-number", "far-day-text", "max-int-day-text",
                "bc-fold-days", "bc-fold-day-number", "bc-text", "bc-direct-weekday", "bc-fold-weekday",
                "bc-far-fold-text", "bc-far-fold-days", "julian-leap-text", "julian-leap-days",
                "julian-leap-format-null", "julian-leap-format-day-number", "julian-leap-coalesce",
                "julian-leap-next-day", "julian-leap-node-text", "julian-leap-node-format", "julian-leap-node-days",
                "cutoff-before-clock", "cutoff-before-days", "cutoff-before-fraction", "cutoff-after-clock",
                "cutoff-after-days", "cutoff-after-fraction", "cutoff-days-1899-12-31", "cutoff-days-1900-01-01",
                "cutoff-day-number-text", "cutoff-cast-kolkata-repeated", "cutoff-cast-kiritimati-repeated"})
                assertTrue("Missing date parity row: " + required, ids.contains(required));
        } finally {
            CalendarUtils.setArrayDataSource(new LocaleArrayDataSource(new DefaultArrayDataSource()));
            DateUtils.resetTimezoneProvider();
        }
    }
}
