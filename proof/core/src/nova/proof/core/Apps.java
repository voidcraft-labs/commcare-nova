package nova.proof.core;

import org.commcare.resources.model.Resource;
import org.commcare.resources.model.installers.LocaleFileInstaller;
import org.commcare.suite.model.PropertySetter;
import org.javarosa.core.reference.ReferenceHandler;
import org.javarosa.core.reference.ReferenceManager;
import org.javarosa.core.services.locale.Localization;
import org.javarosa.core.services.storage.IStorageIterator;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipFile;

/**
 * The apps this runner has admitted, by handle, and which of them owns Core's
 * process-wide state (the reference roots and the localizer) right now.
 */
final class Apps {
    private final Map<String, App> apps = new LinkedHashMap<>();
    private int nextHandle = 1;
    private App active;

    String nextHandle() {
        return "app-" + nextHandle++;
    }

    void add(App app) {
        apps.put(app.handle, app);
        active = app;
    }

    /** Marks that an operation replaced Core's process-wide state (a fresh admission). */
    void clearActive() {
        active = null;
    }

    App require(String handle) {
        App app = apps.get(handle);
        if (app == null) {
            throw new RequestException("This runner has no admitted app with handle \"" + handle + "\". Admit"
                    + " the archive first; a runner that restarted after a deadline holds no earlier apps.");
        }
        return app;
    }

    /**
     * Makes this app's archive the only reference root and its locale files the
     * localizer's, as CommCareConfigEngine.initEnvironment leaves them after an
     * install: the localizer is reset, each locale resource's installer registers
     * its file in table order, "default" is added and made the default locale, and
     * the current locale is the profile's cur_locale ("default" when it has none).
     * Suites and the profile stay registered with the app's own platform, so they
     * are not initialized again.
     */
    void activate(App app) throws Exception {
        if (active == app) {
            return;
        }
        ReferenceHandler.clearInstance();
        ReferenceManager.instance().addReferenceFactory(app.engine.archiveRoot());
        Localization.init(true);
        for (IStorageIterator<Resource> it = app.engine.resourceStorage().iterate(); it.hasMore(); ) {
            Resource resource = it.nextRecord();
            if (resource.getInstaller() instanceof LocaleFileInstaller) {
                resource.getInstaller().initialize(app.engine.getPlatform(), false);
            }
        }
        Localization.getGlobalLocalizerAdvanced().addAvailableLocale("default");
        Localization.setDefaultLocale("default");
        Localization.setLocale(profileLocale(app));
        active = app;
    }

    static String profileLocale(App app) {
        for (PropertySetter property : app.engine.getPlatform().getCurrentProfile().getPropertySetters()) {
            if ("cur_locale".equals(property.getKey())) {
                return property.getValue();
            }
        }
        return "default";
    }

    JSONObject release(String handle) throws IOException {
        App app = require(handle);
        apps.remove(handle);
        app.close();
        if (active == app) {
            ReferenceHandler.clearInstance();
            active = null;
        }
        JSONObject result = new JSONObject();
        result.put("released", handle);
        return result;
    }

    void releaseAll() {
        for (App app : apps.values()) {
            try {
                app.close();
            } catch (IOException ignored) {
                // The process is exiting; the operating system reclaims the file.
            }
        }
        apps.clear();
    }

    /**
     * One admitted archive: its engine, its open zip, the archive guid it is
     * registered under, and what its admission read of the profile.
     */
    static final class App {
        final String handle;
        final ProofEngine engine;
        final String guid;
        final ZipFile zip;
        final Path temporaryArchive;
        JSONObject profile = new JSONObject();
        private Set<String> archiveUuids;

        App(String handle, ProofEngine engine, String guid, ZipFile zip, Path temporaryArchive) {
            this.handle = handle;
            this.engine = engine;
            this.guid = guid;
            this.zip = zip;
            this.temporaryArchive = temporaryArchive;
        }

        /** The id-shaped values the archive's text holds, which a trace never marks as generated. */
        Set<String> archiveUuids() {
            if (archiveUuids == null) {
                try {
                    archiveUuids = Generated.Inputs.archiveUuids(zip);
                } catch (IOException e) {
                    throw new IllegalStateException("The runner could not read app " + handle
                            + "'s archive to tell its authored ids from generated ones: " + e, e);
                }
            }
            return archiveUuids;
        }

        void close() throws IOException {
            engine.archiveRoot().releaseArchive(guid);
            zip.close();
            if (temporaryArchive != null) {
                Files.deleteIfExists(temporaryArchive);
            }
        }
    }
}
