import { test, expect } from 'bun:test';
import { describeFlowUpdateContract, invokeFlowUpdateContract } from './flow-update-contract';
const descriptor = { inputs: [{ name: 'contactRecord', type: 'SOBJECT', sObjectType: 'Contact' }, { name: 'newPhoneNumber', type: 'STRING' }, { name: 'newCity', type: 'STRING', description: 'If no change is desired, this variable is empty.' }], outputs: [] };
const fields = [{ name: 'LastName', createable: true, filterable: true, type: 'string', length: 80, nillable: false }, { name: 'Phone', createable: true, updateable: true, type: 'phone' }];
const request = async () => ({ status: 200, ok: true, body: { fields, createable: true, updateable: true, queryable: true, deletable: true } });
test('update contracts match live fields and reject unresolved required inputs', async () => {
 const plan = await describeFlowUpdateContract({ root: '/services/data/v67.0', route: '/actions/custom/flow/UpdateRecord', descriptor, request });
 expect(plan.contextSchema?.bindings).toEqual([{ inputName: 'newPhoneNumber', field: 'Phone', type: 'phone' }]);
 expect(plan.contextSchema?.omittedInputs).toEqual(['newCity']);
 const unresolved = await describeFlowUpdateContract({ root: '/services/data/v67.0', route: '/actions/custom/flow/UpdateRecord', descriptor: { ...descriptor, inputs: [...descriptor.inputs, { name: 'externalRecipient', type: 'STRING', required: true }] }, request });
 expect(unresolved.status).toBe(422);
});
test('reported success requires actual changed fields and owned cleanup', async () => {
 const root='/services/data/v67.0', route=root+'/actions/custom/flow/UpdateRecord';
 const described=await describeFlowUpdateContract({root,route,descriptor,request});
 for(const mutate of [true,false]) {
  let stored:any; let deleted=false;
  const execute=async(path:string,method='GET',body?:any)=>{
   if(path.includes('/query?'))return {status:200,ok:true,body:{records:stored?[{Id:stored.Id}]:[]}};
   if(path===route){if(mutate)stored.Phone=body.inputs[0].newPhoneNumber;return {status:200,ok:true,body:[{isSuccess:true,errors:[],outputValues:{}}]};}
   if(method==='POST'){stored={...body,Id:'003000000000001AAA'};return {status:201,ok:true,body:{id:stored.Id}};}
   if(method==='DELETE'){stored=undefined;deleted=true;return {status:204,ok:true,body:null};}
   return {status:stored?200:404,ok:!!stored,body:stored?{...stored}:null};
  };
  const result=await invokeFlowUpdateContract({root,route,plan:described.contextSchema!,request:execute,build:async(_name,_marker,values)=>({values})});
  expect(result.contextSchema.verified).toBe(mutate);
  expect(result.status).toBe(mutate?200:422);
  expect(deleted).toBe(true);
  expect(result.cleanupError).toBeUndefined();
 }
});
test('lost creation responses still discover and delete the actual owned target', async () => {
 const root='/services/data/v67.0', route=root+'/actions/custom/flow/UpdateRecord';
 const described=await describeFlowUpdateContract({root,route,descriptor,request});
 let stored:any, deleted=false;
 const execute=async(path:string,method='GET',body?:any)=>{
  if(method==='POST'){stored={...body,Id:'003000000000001AAA'};return {status:502,ok:false,body:{errorCode:'UPSTREAM_UNAVAILABLE'}};}
  if(path.includes('/query?'))return {status:200,ok:true,body:{records:stored?[{Id:stored.Id}]:[]}};
  if(method==='DELETE'){stored=undefined;deleted=true;return {status:204,ok:true,body:null};}
  return {status:stored?200:404,ok:!!stored,body:stored};
 };
 const result=await invokeFlowUpdateContract({root,route,plan:described.contextSchema!,request:execute,build:async(_name,_marker,values)=>({values})});
 expect(result.status).toBe(502);
 expect(result.contextSchema.verified).toBe(false);
 expect(result.contextSchema.ownedRecords).toHaveLength(1);
 expect(deleted).toBe(true);
 expect(result.cleanupError).toBeUndefined();
});
