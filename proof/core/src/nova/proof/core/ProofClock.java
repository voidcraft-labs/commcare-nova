package nova.proof.core;

import org.commcare.suite.model.Text;
import org.javarosa.core.model.utils.DateUtils;
import org.javarosa.xpath.expr.XPathNowFunc;
import org.javarosa.xpath.expr.XPathTodayFunc;

import java.net.URISyntaxException;
import java.nio.file.Path;
import java.util.Date;
import java.util.List;

/**
 * The clock every clock read an app's logic reaches in Core reads in this runner.
 *
 * Core reads the wall clock, with new Date(), in three places an app's logic
 * reaches, and offers no clock a host can replace:
 * - XPathNowFunc.evalBody, now() in a form or suite expression;
 * - XPathTodayFunc.evalBody, today() (DateUtils.roundDate(new Date()));
 * - Text.evaluate, whose XPath texts (menu and detail texts, a case list's
 *   calculated column) get a dow() function reading the day of the week.
 * The client therefore compiles those three classes from Core's own source at
 * the pinned checkout with that one expression changed to ProofClock.now(), and
 * puts them ahead of Core's on the classpath (proof/core/client.py). Every other
 * line of each class is Core's. Each run sets the clock to the instant its
 * request names, so a form or a list that shows or stores the time, or checks an
 * answer against today, behaves the same on every run and every day.
 *
 * Core's other wall-clock reads never reach a trace: Case's constructors date a
 * new case, but CaseXmlParser sets its opened and modified dates from the case
 * block; DateUtils.today() has no caller; DateUtils.formatDaysFromToday runs only
 * for FORMAT_HUMAN_READABLE_DAYS_FROM_TODAY, which nothing in Core passes; the
 * rest are logging, network and file-cache timestamps.
 */
public final class ProofClock {
    /** Core's classes whose clock read the runner replaces, as the client recompiles them. */
    static final List<Class<?>> READERS = List.of(XPathNowFunc.class, XPathTodayFunc.class, Text.class);

    private static volatile long frozen = DateUtils.parseDateTime("2026-01-15T10:30:00.000Z").getTime();

    private ProofClock() {
    }

    public static Date now() {
        return new Date(frozen);
    }

    static void set(String instant) {
        Date parsed;
        try {
            parsed = DateUtils.parseDateTime(instant);
        } catch (RuntimeException e) {
            parsed = null;
        }
        if (parsed == null || instant.indexOf('T') < 0) {
            throw new RequestException("The clock must be an ISO 8601 date-time such as"
                    + " 2026-01-15T10:30:00.000Z; it was \"" + instant + "\".");
        }
        frozen = parsed.getTime();
    }

    /**
     * Refuses to run when the JVM loaded one of Core's own clock-reading classes
     * rather than the runner's, since then it would read the wall clock.
     */
    static void requireInstalled() {
        Path runner = location(ProofClock.class);
        for (Class<?> clockReader : READERS) {
            Path loaded = location(clockReader);
            if (!runner.equals(loaded)) {
                throw new IllegalStateException("Core's " + clockReader.getSimpleName() + " was loaded from "
                        + loaded + " rather than from the runner's classes at " + runner + ", so it would read"
                        + " the wall clock. Put the runner's classes first on the classpath.");
            }
        }
    }

    private static Path location(Class<?> type) {
        try {
            return Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI());
        } catch (URISyntaxException | NullPointerException e) {
            throw new IllegalStateException("The runner could not tell where " + type.getName()
                    + " was loaded from: " + e, e);
        }
    }
}
