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

/**
 * Core's own answers over every pair of the shared instant table, in this
 * run's zone setup. The bare half is the retained control: Core compares a
 * text operand as NaN, two typed operands by the reader's calendar day, and
 * two text spellings of one moment by text. The lowered half evaluates the
 * comparison exactly as Nova emits it and expects the order of the two
 * moments, computed here from java.time and never from the emitter.
 */
public class InstantOrderingRuntimeTest {
    private static final DateTimeFormatter OFFSET_TEXT = new DateTimeFormatterBuilder()
        .append(DateTimeFormatter.ISO_LOCAL_DATE_TIME).appendOffset("+HH:mm", "Z").toFormatter();

    private static final long MICROS_PER_DAY = 86_400_000_000L;

    // The malformed inputs the lowering reads as a number. Nova, HQ and a
    // device never write them; each value is what the parse reads by
    // position, in integer microseconds, and says nothing of the text's
    // validity. Every other malformed input reads as NaN.
    /** A space in place of the T: the parse reads by position. */
    private static final long SPACE_SEPARATED_MICROS = 1_767_328_200_000_000L;
    /** Month 13, day 45 and 99:99:99 carried over by the civil-date
     * arithmetic: 2027-02-18T04:40:39Z. */
    private static final long OUT_OF_RANGE_FIELDS_MICROS = 1_802_925_639_000_000L;
    /** A bare trailing +, - or . reads as no offset and no fraction. */
    private static final long BARE_TRAILING_MARK_MICROS = 1_767_328_200_000_000L;
    /** An hour written -4 reads as minus four hours: 2026-01-01T20:30:00Z. */
    private static final long NEGATIVE_HOUR_MICROS = 1_767_299_400_000_000L;
    /** A tail after the seconds that holds no offset mark is no offset. */
    private static final long UNMARKED_TAIL_MICROS = 1_767_328_200_000_000L;
    /** Nine fraction digits round to the nearest microsecond. */
    private static final long NINE_DIGIT_FRACTION_MICROS = 1_767_328_200_123_457L;
    private static final Map<String, Long> MALFORMED_MICROS = Map.of(
        "2026-01-02 04:30:00Z", SPACE_SEPARATED_MICROS,
        "2026-13-45T99:99:99Z", OUT_OF_RANGE_FIELDS_MICROS,
        "2026-01-02T04:30:00+", BARE_TRAILING_MARK_MICROS,
        "2026-01-02T04:30:00-", BARE_TRAILING_MARK_MICROS,
        "2026-01-02T04:30:00.", BARE_TRAILING_MARK_MICROS,
        "2026-01-02T-4:30:00Z", NEGATIVE_HOUR_MICROS,
        "2026-01-02T04:30:00e5Z", UNMARKED_TAIL_MICROS,
        "2026-01-02T04:30:00.123456789Z", NINE_DIGIT_FRACTION_MICROS);

    private static JSONObject corpus() throws Exception {
        try (InputStream input = InstantOrderingRuntimeTest.class.getResourceAsStream("/expression/orderings.json")) {
            assertNotNull("The expression producer did not supply orderings.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown expression corpus version", 2, result.getInt("schemaVersion"));
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

        /** How the device holds this operand, the producer's key for its
         * lowered text: every text spelling is one class, and a date the
         * comparison coerces to a date and time is its own. */
        String loweredClass() {
            String held = row.getString("held");
            switch (held) {
                case "datetime": case "now": return held;
                case "text": case "core-text": case "malformed": return "text";
                case "date": case "date-text": return row.optBoolean("datetimeCoerce", false) ? "coerced-" + held : held;
                default: throw new AssertionError("Unknown operand storage: " + held);
            }
        }

        boolean isDate() { return loweredClass().equals("date") || loweredClass().equals("date-text"); }

        /** The moment this operand names, in integer microseconds, as a
         * double: a coerced date is its day's UTC midnight in every zone, a
         * malformed text is its retained decode or NaN. */
        double loweredMicros() {
            String held = row.getString("held");
            if (held.equals("malformed")) {
                Long decoded = MALFORMED_MICROS.get(text);
                return decoded == null ? Double.NaN : decoded.doubleValue();
            }
            if (loweredClass().startsWith("coerced-")) return calendar.toEpochDay() * MICROS_PER_DAY;
            assertNotNull("A lowered operand must name a moment: " + row, instant);
            return instant.getEpochSecond() * 1_000_000L + instant.getNano() / 1_000;
        }

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

    /** Core's own answer to the stored comparison: XPathEqExpr compares two
     * unpacked values by text unless one is a number or a Boolean, and
     * XPathCmpExpr compares FunctionUtils.toNumeric of each. */
    private static boolean bareExpected(Operand left, Operand right, String operator) {
        if (operator.equals("=") || operator.equals("!="))
            return operator.equals("=") == left.bareString().equals(right.bareString());
        return numericComparison(left.bareNumber(), right.bareNumber(), operator);
    }

    private static Operand[] operands(JSONObject pair, Setup setup) {
        return new Operand[]{new Operand(pair.getJSONObject("left"), setup), new Operand(pair.getJSONObject("right"), setup)};
    }

    private static FormInstance instance(Operand left, Operand right) {
        TreeElement root = new TreeElement("data", 0);
        root.addChild(left.node); root.addChild(right.node);
        return new FormInstance(root);
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
                Operand[] sides = operands(pair, setup);
                Operand left = sides[0], right = sides[1];
                FormInstance instance = instance(left, right);
                EvaluationContext context = context(instance, setup.clock);
                boolean wall = pair.getString("control").equals("wall-clock");
                assertTrue("Unknown comparison control", wall || pair.getString("control").equals("bare"));
                String a = left.expression(), b = right.expression();
                if (wall) { a = "double(coalesce(" + a + ", ''))"; b = "double(coalesce(" + b + ", ''))"; }
                String xpath = a + " " + operator + " " + b;
                XPathExpression parsed = expressions.get(xpath);
                if (parsed == null) { parsed = XPathParseTool.parseXPath(xpath); expressions.put(xpath, parsed); }
                boolean expected = wall
                    ? numericComparison(left.wallNumber(setup), right.wallNumber(setup), operator)
                    : bareExpected(left, right, operator);
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
    @Test public void loweredComparisonsOrderEveryPairAsItsTwoMoments() throws Exception {
        JSONObject input = corpus();
        try {
            Setup setup = new Setup(Instant.parse(input.getString("fixedClock")));
            JSONObject lowered = input.getJSONObject("lowered");
            JSONArray pairs = input.getJSONArray("pairs");
            Map<String, XPathExpression> expressions = new HashMap<>();
            Set<String> malformedSeen = new HashSet<>();
            int lowerings = 0, bare = 0;
            for (int index = 0; index < pairs.length(); index++) {
                JSONObject pair = pairs.getJSONObject(index);
                String id = pair.getString("id"), operator = pair.getString("operator"), key = pair.getString("key");
                Operand[] sides = operands(pair, setup);
                Operand left = sides[0], right = sides[1];
                assertEquals("The producer keyed this pair by another class: " + id,
                    left.loweredClass() + "|" + operator + "|" + right.loweredClass(), key);
                assertTrue("The producer wrote no comparison for " + key, lowered.has(key));
                String xpath = lowered.getString(key);
                String stored = left.expression() + " " + operator + " " + right.expression();
                boolean dates = left.isDate() && right.isDate();
                if (dates) assertEquals("A date against a date stays the stored comparison: " + key, stored, xpath);
                else assertNotEquals("A comparison of moments must be lowered: " + key, stored, xpath);
                if (dates) bare++; else lowerings++;
                for (Operand side : sides)
                    if (side.row.getString("held").equals("malformed") && MALFORMED_MICROS.containsKey(side.text))
                        malformedSeen.add(side.text);
                XPathExpression parsed = expressions.get(key);
                if (parsed == null) { parsed = XPathParseTool.parseXPath(xpath); expressions.put(key, parsed); }
                boolean expected = dates
                    ? bareExpected(left, right, operator)
                    : numericComparison(left.loweredMicros(), right.loweredMicros(), operator);
                FormInstance instance = instance(left, right);
                Object actual;
                try {
                    actual = FunctionUtils.unpack(parsed.eval(instance, context(instance, setup.clock)));
                } catch (Exception failure) {
                    throw new AssertionError(setup.label + ": " + id + ": the lowering must never throw", failure);
                }
                assertEquals(setup.label + ": " + id + " (" + key + ")", expected, actual);
            }
            assertEquals("Every lowered comparison the producer wrote is read", lowered.length(), expressions.size());
            assertEquals("Every retained malformed decode names an input the table holds",
                MALFORMED_MICROS.keySet(), malformedSeen);
            assertTrue("The table holds dates compared as dates", bare > 0);
            assertTrue("The table holds lowered comparisons", lowerings > 0);
        } finally { DateUtils.resetTimezoneProvider(); }
    }
}
