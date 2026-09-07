package nova.compatibility;

import java.io.*;
import java.util.*;
import org.commcare.core.interfaces.VirtualDataInstanceStorage;
import org.commcare.data.xml.VirtualInstances;
import org.commcare.session.CommCareSession;
import org.commcare.suite.model.*;
import org.commcare.util.CommCarePlatform;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.instance.*;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Native endpoint parsing, arguments, virtual selections and evaluated stack
 * state. This executes Core, not Formplayer's HTTP claim/replay lifecycle. */
public class EndpointRuntimeTest {
 private static final class Parser extends SuiteParser {
  Parser(InputStream in)throws IOException{super(in,null,"endpoint-proof",null,true,true,false);}
 }
 private Suite suite(String scenario,boolean hq)throws Exception{
  try(InputStream in=getClass().getResourceAsStream("/endpoint-"+scenario+(hq?".hq-suite.xml":".suite.xml"))){assertNotNull(in);return new Parser(in).parse();}
 }
 private static final class Storage implements VirtualDataInstanceStorage {
  final Map<String,ExternalDataInstance> values=new HashMap<>();
  public String write(ExternalDataInstance instance){return write("native-selected-"+values.size(),instance);}
  public String write(String key,ExternalDataInstance instance){values.put(key,instance);return key;}
  public ExternalDataInstance read(String key,String instanceId,String refId){throw new AssertionError("No restoration requested by this proof");}
  public boolean contains(String key){return values.containsKey(key);}
 }
 @Test public void argumentsBuildNativeSelectionsAndNavigationFrames()throws Exception{
  for(boolean hq:new boolean[]{false,true})for(String scenario:new String[]{"single","multiple","inline","registration","child","module","case-list"}){
   Suite suite=suite(scenario,hq);Endpoint endpoint=suite.getEndpoint("visit");assertNotNull(endpoint);
   assertEquals(!scenario.equals("registration"),endpoint.isRespectRelevancy());
   CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);CommCareSession session=new CommCareSession(platform);
   HashMap<String,String> args=new HashMap<>();Hashtable<String,DataInstance> instances=new Hashtable<>();Storage storage=new Storage();
   for(EndpointArgument arg:endpoint.getArguments()){
    if(arg.isInstanceArgument()){
     assertEquals("jr://instance/selected-entities",arg.getInstanceSrc());
     var selected=VirtualInstances.storeSelectedValuesInInstance(storage,new String[]{"case-one","case-two"},arg.getInstanceId());
     assertTrue(storage.contains(selected.first));args.put(arg.getId(),selected.first);instances.put(arg.getInstanceId(),selected.second);
    }else args.put(arg.getId(),arg.getId().equals("parent_id")?"parent-one":"case-one");
   }
   EvaluationContext context=new EvaluationContext(null,instances);Endpoint.populateEndpointArgumentsToEvaluationContext(endpoint,args,context);
   if(scenario.equals("multiple")){
    assertEquals("case-one",FunctionUtils.toString(XPathParseTool.parseXPath("instance('selected_cases')/results/value[1]").eval(context)));
    assertEquals("case-two",FunctionUtils.toString(XPathParseTool.parseXPath("instance('selected_cases')/results/value[2]").eval(context)));
   }
   int index=0;
   for(StackOperation operation:endpoint.getStackOperations()){
    session.executeStackOperations(new Vector<>(List.of(operation)),context);
    if(++index<endpoint.getStackOperations().size())assertTrue(session.getCommand().startsWith("claim_command.visit."));
   }
   String command=scenario.equals("child")?"m1-f0":scenario.equals("module")||scenario.equals("case-list")?"m0":"m0-f0";
   assertEquals(scenario+" hq="+hq,command,session.getCommand());
   if(scenario.equals("case-list"))assertEquals("case_id",session.getNeededDatum().getDataId());
   else {
    // Registration and this child's registration-root menu contribute computed
    // UUID datums. Native runtime fills them; endpoints only bind selections.
    int computed=0;
    while(session.getNeededDatum() instanceof ComputedDatum){
     String id=session.getNeededDatum().getDataId();session.setComputedDatum(context);computed++;
     assertTrue(session.getData().get(id).matches("[0-9a-f-]{36}"));
     if(computed>2)throw new AssertionError("Unexpected computed-datum cycle");
    }
    assertEquals(scenario+" hq="+hq,scenario.equals("registration")||scenario.equals("child")?1:0,computed);
    assertNull(scenario+" hq="+hq,session.getNeededDatum());
    for(var arg:args.entrySet())assertEquals(arg.getValue(),session.getData().get(arg.getKey()));
   }
  }
 }
 @Test public void nativeArgumentBindingRejectsMissingAndUnexpectedKeys()throws Exception{
  for(boolean hq:new boolean[]{false,true}){
   Endpoint endpoint=suite("single",hq).getEndpoint("visit");EvaluationContext context=new EvaluationContext(null,new Hashtable<String,DataInstance>());
   var missing=assertThrows(Endpoint.InvalidEndpointArgumentsException.class,()->Endpoint.populateEndpointArgumentsToEvaluationContext(endpoint,new HashMap<String,String>(),context));
   assertEquals(List.of("case_id"),missing.getMissingArguments());assertFalse(missing.hasUnexpectedArguments());
   HashMap<String,String> extra=new HashMap<>();extra.put("case_id","case-one");extra.put("surprise","x");
   var unexpected=assertThrows(Endpoint.InvalidEndpointArgumentsException.class,()->Endpoint.populateEndpointArgumentsToEvaluationContext(endpoint,extra,context));
   assertEquals(List.of("surprise"),unexpected.getUnexpectedArguments());assertFalse(unexpected.hasMissingArguments());
  }
 }
}
