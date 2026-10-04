package nova.proof.core;

import org.commcare.modern.reference.ArchiveFileRoot;
import org.commcare.resources.model.InstallerFactory;
import org.commcare.resources.model.Resource;
import org.commcare.resources.model.ResourceLocation;
import org.commcare.util.engine.CommCareConfigEngine;
import org.javarosa.core.reference.InvalidReferenceException;
import org.javarosa.core.reference.Reference;
import org.javarosa.core.reference.ReferenceManager;
import org.javarosa.core.services.storage.IStorageIndexedFactory;
import org.javarosa.core.services.storage.IStorageIterator;
import org.javarosa.core.services.storage.IStorageUtilityIndexed;
import org.javarosa.core.services.storage.util.DummyIndexedStorageUtility;
import org.javarosa.core.util.externalizable.LivePrototypeFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipFile;

/**
 * Core's own archive installer (CommCareConfigEngine) with one change: the only
 * reference root it registers is its archive. Core's engine also registers
 * JavaHttpRoot and ResourceReferenceFactory, and HQ's profile lists a remote
 * absolute location after each local one, so a resource that fails locally
 * would otherwise be fetched from the network or the classpath. Here that
 * remote location cannot be derived and the local failure is what surfaces.
 *
 * The storage factory records every storage the engine creates, so the harness
 * can read the resource table CommCareConfigEngine keeps private.
 */
final class ProofEngine extends CommCareConfigEngine {
    private final Storages storages;

    private ProofEngine(Storages storages, PrintStream print) {
        super(storages, new InstallerFactory(), print);
        this.storages = storages;
    }

    static ProofEngine create() {
        return new ProofEngine(new Storages(), System.out);
    }

    @Override
    protected void setRoots() {
        this.mArchiveRoot = new ProofArchiveRoot();
        ReferenceManager.instance().addReferenceFactory(mArchiveRoot);
    }

    ProofArchiveRoot archiveRoot() {
        return (ProofArchiveRoot)mArchiveRoot;
    }

    LivePrototypeFactory prototypes() {
        return storages.prototypes;
    }

    @SuppressWarnings("unchecked")
    IStorageUtilityIndexed<Resource> resourceStorage() {
        return (IStorageUtilityIndexed<Resource>)storages.made.get("GLOBAL_RESOURCE_TABLE");
    }

    /**
     * The runner's one prototype factory. A LivePrototypeFactory registers each
     * class as it is serialized, through a hasher it installs process-wide
     * (PrototypeFactory.setStaticHasher), so a second factory would take over
     * that registration and the first could no longer read its own storage.
     * Every engine, scratch table and user sandbox shares this one.
     */
    static final LivePrototypeFactory PROTOTYPES = new LivePrototypeFactory();

    /** Records each storage CommCareConfigEngine asks for, keyed by its name. */
    static final class Storages implements IStorageIndexedFactory {
        final Map<String, IStorageUtilityIndexed> made = new HashMap<>();
        final LivePrototypeFactory prototypes = PROTOTYPES;

        @Override
        @SuppressWarnings({"unchecked", "rawtypes"})
        public IStorageUtilityIndexed newStorage(String name, Class type) {
            IStorageUtilityIndexed storage = new DummyIndexedStorageUtility(type, prototypes);
            made.put(name, storage);
            return storage;
        }
    }

    /**
     * Core's archive root, with the release its static archive map lacks, and a
     * record of the last archive entry an installer opened. Core's installers let a
     * RuntimeException escape without naming their resource (an archive entry
     * that is missing, an XPathException while parsing a form), and the entry
     * being read is what names it. References are Core's own ArchiveFileReference;
     * the record only observes getStream.
     */
    static final class ProofArchiveRoot extends ArchiveFileRoot {
        private String lastOpened;

        void registerArchive(String guid, ZipFile zip) {
            addArchiveFile(zip, guid);
        }

        void releaseArchive(String guid) throws IOException {
            ZipFile zip = guidToFolderMap.remove(guid);
            if (zip != null) {
                zip.close();
            }
        }

        @Override
        public Reference derive(String guidPath) throws InvalidReferenceException {
            Reference archived = super.derive(guidPath);
            String path = getPath(guidPath);
            return new Reference() {
                @Override
                public boolean doesBinaryExist() throws IOException {
                    return archived.doesBinaryExist();
                }

                @Override
                public InputStream getStream() throws IOException {
                    lastOpened = path;
                    return archived.getStream();
                }

                @Override
                public String getURI() {
                    return archived.getURI();
                }

                @Override
                public String getLocalURI() {
                    return archived.getLocalURI();
                }

                @Override
                public boolean isReadOnly() {
                    return archived.isReadOnly();
                }

                @Override
                public OutputStream getOutputStream() throws IOException {
                    return archived.getOutputStream();
                }

                @Override
                public void remove() throws IOException {
                    archived.remove();
                }
            };
        }

        /**
         * The table resource with a local location naming the archive entry an
         * installer opened last, or null when none does.
         */
        Resource resourceLastRead(IStorageUtilityIndexed<Resource> storage) {
            if (lastOpened == null) {
                return null;
            }
            for (IStorageIterator<Resource> it = storage.iterate(); it.hasMore(); ) {
                Resource resource = it.nextRecord();
                for (ResourceLocation location : resource.getLocations()) {
                    String named = location.getLocation();
                    if (location.isRelative()) {
                        named = named.substring(2);
                    }
                    if (location.getAuthority() == Resource.RESOURCE_AUTHORITY_LOCAL
                            && (named.equals(lastOpened) || named.endsWith("/" + lastOpened))) {
                        return resource;
                    }
                }
            }
            return null;
        }
    }
}
