package nova.proof.android;

import org.commcare.suite.model.Text;
import org.javarosa.xpath.expr.XPathNowFunc;
import org.javarosa.xpath.expr.XPathTodayFunc;

import java.util.Date;

/**
 * The clock an app's logic reads on the reader's device.
 *
 * Core reads the wall clock, with new Date(), in three places an app's logic reaches, and offers no clock a host
 * can replace: now() (XPathNowFunc.evalBody), today() (XPathTodayFunc.evalBody) and the dow() that suite XPath
 * texts get (Text.evaluate). A record must not hold the day it was made, so the client compiles those three
 * classes from Core's own source at the pinned checkout with that one expression changed to ProofClock.now(),
 * and puts them ahead of Core's on the classpath (proof/android/client.py), as the Core runner and the
 * Formplayer runner do (proof/core ProofClock). Every other line of each class is Core's. The instant is the one
 * the lane's Core sessions run at, so a form on a device reads the day it reads there.
 *
 * What Android itself stamps with the wall clock (a form record's last change, a log line) is in no record.
 */
public final class ProofClock {
    static final long INSTANT = 1768473000000L; // 2026-01-15T10:30:00.000Z
    static final String TODAY = "2026-01-15";
    static final String NOW = "2026-01-15T10:30:00.000Z";

    private ProofClock() {
    }

    public static Date now() {
        return new Date(INSTANT);
    }

    /** Refuses to read where the JVM loaded Core's own clock readers rather than the reader's. */
    static void requireInstalled() {
        String own = root(ProofClock.class);
        for (Class<?> reader : new Class<?>[]{XPathNowFunc.class, XPathTodayFunc.class, Text.class}) {
            String loaded = root(reader);
            if (!own.equals(loaded)) {
                throw new IllegalStateException("Core's " + reader.getSimpleName() + " was loaded from " + loaded
                        + " rather than from the reader's classes at " + own + ", so it would read the wall"
                        + " clock. Put the reader's classes first on the classpath.");
            }
        }
    }

    /** Where the class's file was read from: its address without the class's own path. */
    private static String root(Class<?> type) {
        String path = type.getName().replace('.', '/') + ".class";
        String address = String.valueOf(type.getClassLoader().getResource(path));
        return address.endsWith(path) ? address.substring(0, address.length() - path.length()) : address;
    }
}
