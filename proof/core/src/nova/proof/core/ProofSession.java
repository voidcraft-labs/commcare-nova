package nova.proof.core;

import org.commcare.cases.instance.CaseInstanceTreeElement;
import org.commcare.core.interfaces.UserSandbox;
import org.commcare.core.process.CommCareInstanceInitializer;
import org.commcare.modern.session.SessionWrapper;
import org.commcare.util.CommCarePlatform;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceRoot;

/**
 * A session whose casedb instance reads cases' indices through a case index table, as every runtime's
 * does (CaseIndexes): Core's own SessionWrapper hands out a CommCareInstanceInitializer whose
 * CaseInstanceTreeElement holds none. Everything else is Core's CommCareInstanceInitializer.
 */
final class ProofSession extends SessionWrapper {
    ProofSession(CommCarePlatform platform, UserSandbox sandbox) {
        super(platform, sandbox);
    }

    @Override
    public CommCareInstanceInitializer getIIF() {
        if (initializer == null) {
            initializer = new Initializer(this, mSandbox, mPlatform);
        }
        return initializer;
    }

    /** Core's CommCareInstanceInitializer, its casedb given a case index table. */
    private static final class Initializer extends CommCareInstanceInitializer {
        Initializer(SessionWrapper session, UserSandbox sandbox, CommCarePlatform platform) {
            super(session, sandbox, platform);
        }

        @Override
        protected InstanceRoot setupCaseData(ExternalDataInstance instance) {
            if (casebase == null) {
                casebase = new CaseInstanceTreeElement(instance.getBase(), mSandbox.getCaseStorage(),
                        new CaseIndexes(mSandbox.getCaseStorage()));
            } else {
                casebase.rebase(instance.getBase());
            }
            return new ConcreteInstanceRoot(casebase);
        }
    }
}
