package nova.compatibility;

import java.io.*;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.session.*;
import org.commcare.suite.model.*;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.mocks.*;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xpath.XPathMissingInstanceException;
import org.junit.Test;
import static org.junit.Assert.*;

/** Actual session computed datum evaluation, beyond layout parsing. */
public class TileGroupingRuntimeTest {
 private static final class Parser extends SuiteParser { Parser(InputStream in)throws IOException{super(in,null,"group-proof",null,true,true,false);} }
 private static final class Runtime extends TestInstanceInitializer {
  final CommCareSession session;
  Runtime(CommCareSession session){this(MockDataUtils.getStaticStorage(),session);}
  private Runtime(MockUserDataSandbox sandbox,CommCareSession session){
   super(sandbox);this.session=session;
   Case patient=new Case("Patient","patient");patient.setCaseId("p1");patient.setIndex(new CaseIndex("parent","household","h1"));sandbox.getCaseStorage().write(patient);
  }
  @Override public InstanceRoot generateRoot(ExternalDataInstance instance){
   if(!instance.getInstanceId().equals("commcaresession"))return super.generateRoot(instance);
   TreeElement root=SessionInstanceBuilder.getSessionInstance(session.getFrame(),"device","1",0L,"worker","worker-id",new Hashtable<>(),"400","en");
   InstanceUtils.setUpInstanceRoot(root,instance.getInstanceId(),instance.getBase());return new ConcreteInstanceRoot(root);
  }
 }
 private CommCareSession session(String resource)throws Exception{
  Suite suite;try(InputStream in=getClass().getResourceAsStream(resource)){assertNotNull(resource,in);suite=new Parser(in).parse();}
  CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);CommCareSession session=new CommCareSession(platform);session.setCommand("m0-f0");session.setEntityDatum("case_id","p1");
  assertEquals("case_id_parent_ids",session.getNeededDatum().getDataId());return session;
 }
 @Test public void retainedMissingDeclarationFailsWhenSelectionCompletes()throws Exception{
  CommCareSession session=session("/before-grouped-tile-instances.suite.xml");
  try{session.setComputedDatum(session.getEvaluationContext(new Runtime(session)));fail("Missing session instance must refuse group datum");}
  catch(XPathMissingInstanceException expected){assertTrue(expected.getMessage().contains("commcaresession"));}
 }
 @Test public void currentGroupedFormEntriesResolveTheSelectedParents()throws Exception{
  for(String scenario:new String[]{"grouped-one","grouped-two","grouped-search"}){
   CommCareSession session=session("/"+scenario+".suite.xml");Runtime runtime=new Runtime(session);
   session.setComputedDatum(session.getEvaluationContext(runtime));assertNull(session.getNeededDatum());
   assertEquals("h1",ExprEvalUtils.xpathEval(session.getEvaluationContext(runtime),"string(instance('commcaresession')/session/data/case_id_parent_ids)"));
  }
 }
}
