import { expect, test } from 'bun:test';
import { invokeContactRequestContext } from './contact-request-context';
import { invokeLeadAssignmentContext } from './lead-assignment-context';
import { invokePricebookContext } from './pricebook-action-context';
const root='/services/data/v67.0',actor='005000000000001AAA',own='a00000000000001AAA',existing='a00000000000002AAA',book='01s000000000001AAA';
for(const family of ['contact','lead','pricebook'] as const)for(const mode of ['wrong-id','lost-response'])test(`${family} ${mode} recovers actual writes and preserves existing tenant records`,async()=>{
  const objectName=family==='contact'?'ContactRequest':family==='lead'?'Lead':'Opportunity';
  const markerField=family==='contact'?'RequestDescription':family==='lead'?'LastName':'Name';
  const action=family==='contact'?'contactRequestAction':family==='lead'?'invocableApplyLeadAssignmentRules':'choosePricebook';
  const route=root+'/actions/standard/'+action,rows=new Map<string,any>([[existing,{Id:existing,[markerField]:'Existing customer record',OwnerId:actor,Status:'Abandoned',Pricebook2Id:book}]]);
  const deletes:string[]=[],reply=(status:number,body:any)=>({status,ok:status>=200&&status<300,body});
  const request=async(path:string,method='GET',body?:any):Promise<any>=>{
    if(path.endsWith('/composite/batch')){const results=[];for(const operation of body.batchRequests){const result=await request('/services/data/'+operation.url,operation.method);results.push({statusCode:result.status,result:result.body});}return reply(200,{results});}
    if(path.endsWith('/describe'))return reply(200,{createable:true,queryable:true,deletable:true,fields:[
      {name:markerField,nameField:true,type:family==='contact'?'textarea':'string',length:255,createable:true,filterable:family!=='contact',nillable:false},
      {name:'OwnerId',createable:true,updateable:true},
      {name:'Status',type:'picklist',createable:true,picklistValues:[{value:'Abandoned',active:true}]},
      {name:'Pricebook2Id',type:'reference',referenceTo:['Pricebook2'],createable:true,updateable:true},
    ]});
    if(path.includes('/query?')){const query=decodeURIComponent(path);if(query.includes('FROM Pricebook2'))return reply(200,{records:[{Id:book}]});if(query.includes('FROM AssignmentRule'))return reply(200,{records:[{Id:'01Q000000000001AAA'}]});
      const marker=query.match(new RegExp(markerField+"='([^']+)'"))?.[1];return reply(200,{records:[...rows.values()].filter(row=>!marker||row[markerField]===marker)});}
    if(path===route&&method==='GET')return reply(200,{inputs:family==='contact'?[{name:markerField},{name:'OwnerId',required:true},{name:'Status',required:true}]:family==='lead'?[{name:'leadId',type:'ID',required:true}]:[{name:'parentEntityId'},{name:'pricebook2Id'}]});
    if(path===route&&family==='contact'){
      rows.set(own,{...body.inputs[0],Id:own});return mode==='lost-response'?reply(502,{errorCode:'LOST'}):reply(200,[{isSuccess:true,outputValues:{Id:existing}}]);
    }
    if(path.endsWith('/sobjects/'+objectName)&&method==='POST'){
      rows.set(own,{...body,Id:own,OwnerId:actor});return mode==='lost-response'?reply(502,{errorCode:'LOST'}):reply(201,{id:existing});
    }
    const identity=path.split('/').at(-1)!;
    if(method==='DELETE'){deletes.push(identity);rows.delete(identity);return reply(204,null);}
    return rows.has(identity)?reply(200,rows.get(identity)):reply(404,null);
  };
  const build=async(_name:string,_marker:string,values:Record<string,unknown>)=>({values});
  const result=family==='contact'?await invokeContactRequestContext({root,route,userId:actor,request}):family==='lead'?await invokeLeadAssignmentContext({root,route,request,build}):await invokePricebookContext({root,route,target:objectName,request,build});
  expect(result.contextSchema?.verified).toBe(false);expect(rows.has(own)).toBe(false);expect(rows.get(existing)[markerField]).toBe('Existing customer record');
  expect(deletes).toEqual([own]);
  if(mode==='wrong-id')expect(result.cleanupError).toContain('deletion was withheld');else expect(result.cleanupError).toBeUndefined();
});
