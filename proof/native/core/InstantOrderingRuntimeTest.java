package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.Vector;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.condition.IFunctionHandler;
import org.javarosa.core.model.data.DateData;
import org.javarosa.core.model.data.DateTimeData;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.FormInstance;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.utils.DateUtils;
import org.javarosa.core.model.utils.TimezoneProvider;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.javarosa.xpath.expr.XPathExpression;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Bare Core controls; the later production lowering must keep these witnesses. */
public class InstantOrderingRuntimeTest {
    private static final DateTimeFormatter OFFSET_TEXT = new DateTimeFormatterBuilder()
        .append(DateTimeFormatter.ISO_LOCAL_DATE_TIME).appendOffset("+HH:mm", "Z").toFormatter();

    private static JSONObject corpus() throws Exception {
        try (InputStream input = InstantOrderingRuntimeTest.class.getResourceAsStream("/expression/orderings.json")) {
            assertNotNull("The expression producer did not supply orderings.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown expression corpus version", 1, result.getInt("schemaVersion"));
            return result;
        }
    }

    /** The browser supplies both its zone and its offset at request time. */
    private static TimezoneProvider provider(String id, Instant clock, boolean offsetOnly) {
        TimeZone zone = TimeZone.getTimeZone(ZoneId.of(id));
        int offset = zone.getOffset(clock.toEpochMilli());
        return new TimezoneProvider() {
            @Override public int getTimezoneOffsetMillis() { return offset; }
            @Override public TimeZone getTimezone() { return offsetOnly ? null : zone; }
        };
    }

    private static final class Setup {
        final String label;
        final ZoneId jvm;
        final ZoneId reader;
        final TimezoneProvider provider;
        final Instant clock;

        Setup(Instant clock) {
            this.clock = clock;
            label = System.getProperty("nova.proof.zone.label");
            assertNotNull("This class must run through a named native zone setup", label);
            String jvmId = System.getProperty("nova.proof.zone.jvm");
            assertNotNull("The native runner did not supply the JVM zone", jvmId);
            assertEquals("The JVM was started in the wrong zone", jvmId, TimeZone.getDefault().getID());
            assertEquals("The native runner must set user.timezone", jvmId, System.getProperty("user.timezone"));
            jvm = ZoneId.of(jvmId);
            String providerId = System.getProperty("nova.proof.zone.provider", "");
            boolean offsetOnly = Boolean.parseBoolean(System.getProperty("nova.proof.zone.offsetOnly", "false"));
            assertFalse("An offset-only run needs a provider", offsetOnly && providerId.isEmpty());
            provider = providerId.isEmpty() ? new TimezoneProvider() : provider(providerId, clock, offsetOnly);
            DateUtils.setTimezoneProvider(provider);
            if (providerId.isEmpty() || offsetOnly) {
                assertNull("This setup must have no named DateUtils zone", DateUtils.timezone());
            } else {
                assertEquals("The provider zone was not installed", providerId, DateUtils.timezone().getID());
            }
            reader = providerId.isEmpty() ? jvm : offsetOnly
                ? ZoneOffset.ofTotalSeconds(provider.getTimezoneOffsetMillis() / 1000) : ZoneId.of(providerId);
            // Verify the provider's actual effect too, including the offset-only
            // setup that intentionally has a null DateUtils.timezone().
            DateUtils.DateFields actual = DateUtils.getFields(Date.from(clock));
            java.time.ZonedDateTime expected = clock.atZone(reader);
            assertEquals(expected.getYear(), actual.year);
            assertEquals(expected.getMonthValue(), actual.month);
            assertEquals(expected.getDayOfMonth(), actual.day);
            assertEquals(expected.getHour(), actual.hour);
            assertEquals(expected.getMinute(), actual.minute);
        }
    }

    private static final class Operand {
        final JSONObject row;
        final TreeElement node;
        final String text;
        final Instant instant;
        final LocalDate calendar;

        Operand(JSONObject row, Setup setup) {
            this.row = row;
            node = new TreeElement(row.getString("node"), 0);
            String held = row.getString("held");
            if (held.equals("datetime") || held.equals("now")) {
                instant = Instant.parse(row.getString("instant"));
                if (held.equals("now")) assertEquals("A now operand must name the controlled clock", setup.clock, instant);
                assertEquals("Typed answers have millisecond precision", 0, instant.getNano() % 1_000_000);
                calendar = instant.atZone(setup.reader).toLocalDate();
                text = null;
                node.setValue(new DateTimeData(Date.from(instant)));
            } else if (held.equals("date")) {
                calendar = LocalDate.parse(row.getString("value"));
                instant = calendar.atStartOfDay(setup.reader).toInstant();
                text = null;
                node.setValue(new DateData(Date.from(instant)));
            } else {
                calendar = held.equals("date-text") ? LocalDate.parse(row.getString("value")) : null;
                instant = row.has("instant") ? Instant.parse(row.getString("instant")) : null;
                if (held.equals("core-text")) {
                    DateUtils.setTimezoneProvider(provider(row.getString("writerZone"), instant, false));
                    try { text = new DateTimeData(Date.from(instant)).uncast().getString(); }
                    finally { DateUtils.setTimezoneProvider(setup.provider); }
                    assertEquals("Core's writer must preserve the input instant", instant, OFFSET_TEXT.parse(text, Instant::from));
                } else {
                    assertTrue("Unknown operand storage: " + held,
                        held.equals("text") || held.equals("date-text") || held.equals("malformed"));
                    text = row.getString("value");
                }
                node.setValue(new StringData(text));
            }
        }

        String expression() { return row.getString("held").equals("now") ? "now()" : "/data/" + row.getString("node"); }

        // XPathEqExpr's non-Boolean/non-Double branch calls toString on each
        // unpacked Date. FunctionUtils.toString prints its reader-local date,
        // so typed equality is calendar-day equality, not Date.equals.
        String bareString() { return text == null ? calendar.toString() : text; }

        double bareNumber() {
            if (text == null) return calendar.toEpochDay();
            if (calendar != null) return calendar.toEpochDay();
            // FunctionUtils.toNumeric permits date-only text but rejects every
            // datetime spelling's T/space/colon. One original "malformed" input
            // is a valid date: retaining its native result avoids a false rule.
            if (text.equals("2026-01-02")) return LocalDate.parse(text).toEpochDay();
            return Double.NaN;
        }

        double wallNumber(Setup setup) {
            // DateUtils.fractionalDaysSinceEpoch uses java.util.Date's JVM
            // offset, even when DateUtils itself has a browser zone provider.
            java.time.LocalDateTime wall = instant.atZone(setup.jvm).toLocalDateTime();
            return wall.toLocalDate().toEpochDay() + wall.toLocalTime().toNanoOfDay() / 86_400_000_000_000.0;
        }
    }

    private static boolean numericComparison(double left, double right, String operator) {
        switch (operator) {
            case "<": return left < right;
            case "<=": return left <= right;
            case ">": return left > right;
            case ">=": return left >= right;
            case "=": return Math.abs(left - right) < 1.0e-12;
            case "!=": return !(Math.abs(left - right) < 1.0e-12);
            default: throw new AssertionError("Unknown comparison: " + operator);
        }
    }

    private static EvaluationContext context(FormInstance instance, Instant clock) {
        EvaluationContext context = new EvaluationContext(instance);
        // XPathFuncExpr.evalRaw checks this handler before XPathNowFunc's
        // built-in evalBody, including for names Core itself dispatches.
        context.addFunctionHandler(new IFunctionHandler() {
            @Override public String getName() { return "now"; }
            @Override public Vector<Class[]> getPrototypes() {
                Vector<Class[]> result = new Vector<>();
                result.add(new Class[0]);
                return result;
            }
            @Override public boolean rawArgs() { return false; }
            @Override public Object eval(Object[] args, EvaluationContext ignored) { return Date.from(clock); }
        });
        return context;
    }

    @Test public void bareComparisonsRetainTheNativeCalendarTextAndWallClockControls() throws Exception {
        JSONObject input = corpus();
        try {
            Setup setup = new Setup(Instant.parse(input.getString("fixedClock")));
            FormInstance clockInstance = new FormInstance(new TreeElement("data", 0));
            assertEquals("The supported now handler must replace the volatile clock", Date.from(setup.clock),
                FunctionUtils.unpack(XPathParseTool.parseXPath("now()").eval(clockInstance, context(clockInstance, setup.clock))));
            JSONArray pairs = input.getJSONArray("pairs");
            Set<String> ids = new HashSet<>();
            Map<String, Integer> groups = new HashMap<>();
            Map<String, XPathExpression> expressions = new HashMap<>();
            int textEqualityCounterexamples = 0;
            for (int index = 0; index < pairs.length(); index++) {
                JSONObject pair = pairs.getJSONObject(index);
                String id = pair.getString("id"), operator = pair.getString("operator");
                assertTrue("Duplicate expression row: " + id, ids.add(id));
                groups.merge(pair.getString("group"), 1, Integer::sum);
                Operand left = new Operand(pair.getJSONObject("left"), setup);
                Operand right = new Operand(pair.getJSONObject("right"), setup);
                TreeElement root = new TreeElement("data", 0);
                root.addChild(left.node); root.addChild(right.node);
                FormInstance instance = new FormInstance(root);
                EvaluationContext context = context(instance, setup.clock);
                boolean wall = pair.getString("control").equals("wall-clock");
                assertTrue("Unknown comparison control", wall || pair.getString("control").equals("bare"));
                String a = left.expression(), b = right.expression();
                if (wall) { a = "double(coalesce(" + a + ", ''))"; b = "double(coalesce(" + b + ", ''))"; }
                String xpath = a + " " + operator + " " + b;
                XPathExpression parsed = expressions.get(xpath);
                if (parsed == null) { parsed = XPathParseTool.parseXPath(xpath); expressions.put(xpath, parsed); }
                boolean expected;
                if (wall) expected = numericComparison(left.wallNumber(setup), right.wallNumber(setup), operator);
                else if (operator.equals("=") || operator.equals("!="))
                    expected = operator.equals("=") == left.bareString().equals(right.bareString());
                else expected = numericComparison(left.bareNumber(), right.bareNumber(), operator);
                try {
                    assertEquals(setup.label + ": " + id + ": " + xpath, expected,
                        FunctionUtils.unpack(parsed.eval(instance, context)));
                } catch (Exception failure) { throw new AssertionError(setup.label + ": " + id + ": " + xpath, failure); }
                if (pair.getString("group").equals("spellings-same") && operator.equals("=") && !expected)
                    textEqualityCounterexamples++;
                if (wall && id.contains("fall-back") && operator.equals("<"))
                    assertEquals("Only the New York JVM collapses the repeated wall hour", !setup.jvm.getId().equals("America/New_York"), expected);
            }
            assertEquals(Integer.valueOf(13 * 13 * 6), groups.get("spellings-same"));
            assertEquals(Integer.valueOf(13 * 13 * 6), groups.get("spellings-hour"));
            assertEquals(Integer.valueOf(1_500 * 6), groups.get("microseconds-same"));
            assertEquals(Integer.valueOf(1_500 * 6), groups.get("microseconds-next"));
            assertEquals(Integer.valueOf(28 * 6), groups.get("malformed-typed"));
            assertEquals(Integer.valueOf(28 * 28 * 6), groups.get("malformed-pairs"));
            assertTrue("Distinct spellings must expose bare text equality", textEqualityCounterexamples > 0);
            for (String group : new String[]{"typed", "typed-text", "typed-text-hour", "writers", "writers-hour",
                "writers-text", "dst-typed", "dst-text", "dst-wall-clock", "dates-same", "dates-next", "date-coerced", "now-text", "now-typed"})
                assertTrue("Missing expression group: " + group, groups.containsKey(group));
        } finally { DateUtils.resetTimezoneProvider(); }
    }
}
