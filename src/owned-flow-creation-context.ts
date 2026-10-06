import { planOwnedContext, type ContextSchema } from './owned-context-plan';
import { cleanupOwnedContext, type OwnedRecord, type OwnershipScope } from './owned-context-cleanup';
import { nativeActionSucceeded } from './action-outcome';
type Value=Record<string,any>;
type Result={status:number;ok?:boolean;body:any};
const record=(value:any):value is Value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const identity=(value:any):value is string=>typeof value==='string'&&/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(value);
const identifier=(value:any):value is string=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value);
/** Queryable setup/config objects no identity can owned-mint, safe to retain
 * as read-only references. Observed evidence only: BusinessHours backs the
 * Case schedule reference the planner refuses to owned-plan. */
const SETUP_REFERENCE_OBJECTS=new Set(['BusinessHours']);
const planRefusalMessage=(issue:{code:string;objectName:string})=>'The live owned fixture dependency graph could not be safely planned.'+
  (/^[A-Z][A-Z0-9_]{0,63}$/.test(issue.code)&&identifier(issue.objectName)&&issue.objectName.length?` (${issue.code} for ${issue.objectName}).`:'');

/** One tenant-scoped planned graph covers fixture preparation, native execution,
 * readback and recovery. Existing customer records never supply dependencies. */
export async function invokeOwnedFlowCreation(input:{root:string;route:string;plan:Value;verificationWindowMs?:number;
  request:(path:string,method?:string,body?:any)=>Promise<{status:number;ok:boolean;body:any}>;
  build:(name:string,marker:string,values:Value)=>Promise<{values:Value}|{failure:Result}>}) {
  const {root,request,plan}=input,marker='AS probe '+crypto.randomUUID();
  const fixtures=(Array.isArray(plan.fixtures)?plan.fixtures:[]).filter(record),targets=(Array.isArray(plan.targets)?plan.targets:[]).filter(record);
  const fail=(code:string,message:string):Result=>({status:422,ok:false,body:{errorCode:code,message}});
  if(!fixtures.length||!targets.length||new Set(fixtures.map(fixture=>fixture.objectName)).size!==fixtures.length||fixtures.some(fixture=>!identifier(fixture.objectName)||!identifier(fixture.inputName))||targets.some(target=>!identifier(target.objectName)))return fail('FLOW_CREATION_PLAN_INVALID','A live typed fixture and target plan with distinct owned input roles is required.');
  const describe=async(name:string)=>{const result=await request(`${root}/sobjects/${name}/describe`);return result.ok&&record(result.body)?result.body as ContextSchema:undefined;};
  let graph=await planOwnedContext({roots:fixtures.map(fixture=>fixture.objectName),maxNodes:12,markerLength:marker.length,describe});
  // Retained-anchor rescue: a non-root reference target that no identity can
  // owned-mint (queryable setup/config data such as BusinessHours, which the
  // platform never exposes as createable) cannot fail planning forever: one
  // live row is retained to satisfy the reference without any write to it.
  // Roots never retain (the probe must own what it mutates), customer objects
  // never retain (missing CRUD there is a grant gap, never a borrow), and the
  // allowlist below grows only with observed evidence, never guesses.
  if(!graph.ok&&graph.issue.code==='OWNED_CONTEXT_LIFECYCLE_ACCESS_REQUIRED'&&graph.issue.dependencyPath.length>1&&
    SETUP_REFERENCE_OBJECTS.has(graph.issue.objectName)){
    const rescued=await planWithRetainedSetupRow(graph.issue.objectName);
    if(rescued)graph=rescued;
  }
  if(!graph.ok)return {status:422,body:{errorCode:graph.issue.code,message:planRefusalMessage(graph.issue),dependency:graph.issue},contextSchema:{...plan,verified:false,dependencyIssue:graph.issue}};
  async function planWithRetainedSetupRow(objectName:string){
    if(!identifier(objectName))return undefined;
    const schema=await describe(objectName).catch(()=>undefined);
    if(!schema||schema.createable===true||schema.queryable!==true)return undefined;
    const found=await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM ${objectName} LIMIT 1`)).catch(()=>undefined);
    const rows=Array.isArray(found?.body?.records)?found.body.records:[];
    if(!found?.ok||rows.length!==1||!identity(rows[0]?.Id))return undefined;
    const retry=await planOwnedContext({roots:fixtures.map(fixture=>fixture.objectName),maxNodes:12,markerLength:marker.length,
      describe,retained:{[objectName]:rows[0].Id}});
    return retry.ok?retry:undefined;
  }
  const owned:OwnedRecord[]=[],attempted=new Set<string>(),scopes:OwnershipScope[]=[],ids:Record<string,string>={},actuals:Record<string,Value>={},fixtureIds:Record<string,string>={},args:Value={};
  const verificationRecordIds:string[]=[],expectedChanges:Value={};
  let cleanupError:string|undefined,verified=false,nativeAttempted=false;
  let outcome:Result=fail('FLOW_CREATION_CONTEXT_UNAVAILABLE','Disposable Flow creation context could not be prepared.');
  for(const variable of (Array.isArray(plan.inputVariables)?plan.inputVariables:[]).filter(record)) {
    if(!identifier(variable.name))continue;
    if(['Number','Currency'].includes(variable.dataType))args[variable.name]=1;
    else if(variable.dataType==='Boolean')args[variable.name]=false;
    else if(variable.dataType==='String')args[variable.name]=marker;
  }
  const capture=(name:string,id:string)=>{if(!owned.some(item=>item.objectName===name&&item.id===id))owned.push({objectName:name,id});};
  const children:Array<{objectName:string;field:string;parentObject:string;parentId:string;expected:Value}>=[];
  const recover=async(name:string,field:string,value:string)=>{
    const found=await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM ${name} WHERE ${field}='${value}' LIMIT 3`));
    if(!found.ok||!Array.isArray(found.body?.records)||found.body.records.length>=3||found.body.records.some((row:Value)=>!identity(row.Id)))throw Error('Bounded owned Flow recovery could not be verified.');
    for(const row of found.body.records)capture(name,row.Id);
    return found.body.records as Value[];
  };
  try {
    outcome=await(async()=>{
      for(const node of graph.nodes) {
        const values:Value={...node.values,[node.markerField]:marker};
        for(const reference of node.references){const id=reference.source==='owned'?ids[reference.objectName]:reference.id;if(!identity(id))return fail('FLOW_CREATION_REFERENCE_UNVERIFIED','A planned dependency identity was not established.');values[reference.field]=id;}
        const built=await input.build(node.objectName,marker,values);if('failure'in built)return built.failure;
        // Reject a builder that silently substitutes a different ownership field.
        if(Object.entries(values).some(([field,value])=>built.values[field]!==value))return fail('FLOW_CREATION_BUILD_UNSCOPED','The fixture builder changed a planned ownership or dependency field.');
        attempted.add(node.objectName);scopes.push({objectName:node.objectName,equals:{[node.markerField]:marker}});
        const created=await request(root+'/sobjects/'+node.objectName,'POST',built.values);
        if(!created.ok||!identity(created.body?.id))return created;
        capture(node.objectName,created.body.id);
        const actual=await request(root+'/sobjects/'+node.objectName+'/'+created.body.id);
        if(!actual.ok||actual.body?.Id!==created.body.id||Object.entries(values).some(([field,value])=>actual.body?.[field]!==value))return fail('FLOW_CREATION_CONTEXT_UNVERIFIED','A planned owned fixture failed actual marker or relationship readback.');
        ids[node.objectName]=created.body.id;actuals[node.objectName]=actual.body;
      }
      for(const fixture of fixtures) {
        fixtureIds[fixture.inputName]=ids[fixture.objectName];
        const binding=targets.flatMap(target=>Array.isArray(target.bindings)?target.bindings.filter(record):[]).find(binding=>binding.inputName===fixture.inputName);
        const value=binding?.inputField==='Id'?{...actuals[fixture.objectName],attributes:{type:fixture.objectName}}:ids[fixture.objectName];
        args[fixture.inputName]=fixture.collection===true?[value]:value;
      }
      for(const target of targets) {
        const bindings=(Array.isArray(target.bindings)?target.bindings:[]).filter(record);
        const anchor=bindings.find(binding=>binding.type==='reference'&&identifier(binding.field)&&fixtureIds[binding.inputName]);
        const fixture=fixtures.find(fixture=>fixture.inputName===anchor?.inputName);
        if(!anchor||!fixture)return fail('FLOW_CREATION_ANCHOR_UNRESOLVED','Every Flow-created target requires an owned fixture relationship.');
        const expected:Value={};
        for(const binding of bindings){let value=Object.hasOwn(binding,'literal')?binding.literal:args[binding.inputName];if(binding.collection===true&&Array.isArray(value))value=value[0];if(typeof binding.inputField==='string'&&record(value))value=value[binding.inputField];expected[String(binding.field)]=value;}
        children.push({objectName:target.objectName,field:anchor.field,parentObject:fixture.objectName,parentId:fixtureIds[anchor.inputName],expected});
        scopes.push({objectName:target.objectName,equals:{[anchor.field]:fixtureIds[anchor.inputName]},ownedParents:[{field:anchor.field,objectName:fixture.objectName}]});
      }
      nativeAttempted=true;
      const invoked=await request(input.route,'POST',{inputs:[args]});
      verified=invoked.ok&&Array.isArray(invoked.body)&&invoked.body.length===1&&nativeActionSucceeded(invoked.status,invoked.body);
      for(const child of children) {
        const found=await recover(child.objectName,child.field,child.parentId);
        if(found.length!==1)verified=false;
        for(const row of found){const actual=await request(root+'/sobjects/'+child.objectName+'/'+row.Id);if(!actual.ok||Object.entries(child.expected).some(([field,value])=>actual.body?.[field]!==value))verified=false;
          if(child.objectName===plan.targetObject){verificationRecordIds.push(row.Id);Object.assign(expectedChanges,child.expected);}}
      }
      if(input.verificationWindowMs)await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
      return invoked;
    })();
  }catch{outcome=fail('FLOW_CREATION_LIFECYCLE_UNVERIFIED','Owned Flow execution or readback failed; ownership-scoped recovery still runs.');verified=false;}
  finally {
    for(const node of graph.nodes)if(attempted.has(node.objectName))try{await recover(node.objectName,node.markerField,marker);}catch{cleanupError='Owned Flow fixture recovery could not be verified.';}
    if(nativeAttempted)for(const child of children)try{await recover(child.objectName,child.field,child.parentId);}catch{cleanupError='Owned Flow child recovery could not be verified.';}
    const order=[...new Set([...children.map(child=>child.objectName),...graph.cleanupOrder])];
    const cleaned=await cleanupOwnedContext({root,request,records:owned,scopes,order});
    cleanupError ??= cleaned.cleanupError;owned.splice(0,owned.length,...cleaned.ownedRecords);
  }
  const contextSchema={...plan,verified,verificationRecordIds,expectedChanges,fixtureRecordIds:fixtureIds,ownedRecords:owned,dependencyGraph:graph.nodes.map(node=>({objectName:node.objectName,markerField:node.markerField,references:node.references}))};
  if(outcome.status>=200&&outcome.status<300&&!verified)return {status:422,body:{errorCode:'FLOW_CREATION_MUTATION_UNVERIFIED',message:'No complete owned Flow creation mutation was verified.',upstreamOutcome:outcome.body},contextSchema,...(cleanupError?{cleanupError}:{})};
  return {...outcome,contextSchema,...(cleanupError?{cleanupError}:{})};
}
