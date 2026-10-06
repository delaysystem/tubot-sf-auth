import { test, expect } from 'bun:test';
import { describeFlowRecordContract, flowRecordContracts, invokeFlowRecordContract } from './flow-record-contract';
const descriptor = { inputs: [{ name: 'leadRecord', type: 'SOBJECT', sObjectType: 'Lead', maxOccurs: 1, description: 'Stores record details to retrieve or create.' }], outputs: [{ name: 'leadRecordId', type: 'STRING', maxOccurs: 1 }] };
test('typed creation contracts are discovered from complete live descriptors', () => {
  expect(flowRecordContracts(descriptor)).toEqual([{ inputName: 'leadRecord', objectName: 'Lead', outputName: 'leadRecordId' }]);
  expect(flowRecordContracts({ ...descriptor, outputs: [] })).toEqual([]);
  expect(flowRecordContracts({ ...descriptor, inputs: [...descriptor.inputs, { name: 'sendEmail', type: 'BOOLEAN' }] })).toEqual([]);
  expect(flowRecordContracts({ ...descriptor, inputs: [{ ...descriptor.inputs[0], description: 'Update a record.' }] })).toEqual([]);
});
test('read-only compound names are excluded while writable components are accepted', async () => {
  const result = await describeFlowRecordContract({ root: '/services/data/v67.0', descriptor, request: async () => ({ status: 200, ok: true, body: { createable: true, deletable: true, queryable: true, fields: [
    { name: 'Name', type: 'string', length: 255, createable: false, filterable: true, nameField: true },
    { name: 'LastName', type: 'string', length: 80, createable: true, filterable: true, compoundFieldName: 'Name', nillable: false },
  ] } }) });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.targets[0].markerField).toBe('LastName');
});
for (const mode of ['success', 'missing', 'rejection', 'partial']) test('Flow contract verifies and cleans ' + mode, async () => {
  const root = '/services/data/v67.0', identity = '00Q000000000001AAA';
  let stored: any, deleted = false;
  const request = async (path: string, method = 'GET', body?: any) => {
    const result = (body: any, status = 200) => ({ status, ok: status < 400, body });
    if (method === 'POST' && path.includes('/sobjects/')) { stored = { ...body, Id: identity }; return result({ id: identity }, 201); }
    if (method === 'POST') {
      if (mode !== 'missing' && mode !== 'rejection') stored = { ...body.inputs[0].leadRecord, Id: identity };
      return result([{ isSuccess: mode !== 'rejection' && mode !== 'partial', errors: mode === 'partial' ? [{ message: 'Rejected after partial creation.' }] : [], outputValues: { leadRecordId: identity } }]);
    }
    if (path.includes('/query?')) return result({ records: stored ? [{ Id: identity }] : [] });
    if (method === 'DELETE') { stored = undefined; deleted = true; return result(null, 204); }
    return stored ? result(stored) : result([], 404);
  };
  const result = await invokeFlowRecordContract({ root, route: root + '/actions/custom/flow/LiveCreation', plan: { source: 'salesforce_live_flow_record_contract', supportsStoredResolution: true, targets: [{ objectName: 'Lead', inputName: 'leadRecord', outputName: 'leadRecordId', markerField: 'LastName' }] }, request, build: async (_, __, values) => ({ values }) });
  expect(result.contextSchema?.verified).toBe(mode === 'success');
  expect(stored).toBeUndefined();
  expect(deleted).toBe(mode === 'success' || mode === 'partial' || mode === 'rejection');
  if (mode === 'missing') expect(result.body.errorCode).toBe('FLOW_RECORD_CONTRACT_MUTATION_UNVERIFIED');
  if (mode === 'rejection' || mode === 'partial') expect(result.body[0].isSuccess).toBe(false);
});
test('a declared retrieve-or-create contract retries with actual stored record fields and identities', async () => {
  const root = '/services/data/v67.0', identity = '00Q000000000002AAA';
  let stored: any, invoked = 0, fixtureCreated = false;
  const request = async (path: string, method = 'GET', body?: any) => {
    const result = (body: any, status = 200) => ({ status, ok: status < 400, body });
    if (path.includes('/actions/')) {
      invoked++;
      if (!body.inputs[0].leadRecord.Id) return result([{ isSuccess: false, errors: [{ errorCode: 'FLOW_ERROR' }] }], 400);
      expect(body.inputs[0].leadRecord.Id).toBe(identity);
      expect(body.inputs[0].leadRecord.Name).toBe(stored.Name);
      return result([{ isSuccess: true, errors: [], outputValues: { leadRecordId: identity } }]);
    }
    if (path.includes('/query?')) return result({ records: stored ? [{ Id: identity }] : [] });
    if (method === 'POST') { stored = { ...body, Id: identity, Name: body.LastName }; fixtureCreated = true; return result({ id: identity }, 201); }
    if (method === 'DELETE') { stored = undefined; return result(null, 204); }
    return stored ? result(stored) : result([], 404);
  };
  const result = await invokeFlowRecordContract({ root, route: root + '/actions/custom/flow/LiveCreation', plan: { source: 'salesforce_live_flow_record_contract', supportsStoredResolution: true, targets: [{ objectName: 'Lead', inputName: 'leadRecord', outputName: 'leadRecordId', markerField: 'LastName', fields: [] }] }, request, build: async (_, __, values) => ({ values }) });
  expect(invoked).toBe(2);
  expect(fixtureCreated).toBe(true);
  expect(result.contextSchema?.verified).toBe(true);
  expect(result.contextSchema?.resolutionMode).toBe('stored_record_resolution');
  expect(result.contextSchema?.mutationKind).toBe('resolve');
  expect(stored).toBeUndefined();
});
test('typed parent and child output contracts resolve actual reference and scalar fields', async () => {
  const { describeFlowReferenceContract } = await import('./flow-record-contract');
  const descriptor = { inputs: [
    { name: 'caseSubject', type: 'STRING' }, { name: 'caseDescription', type: 'STRING' }, { name: 'contactRecord', type: 'SOBJECT', sObjectType: 'Contact' },
  ], outputs: [{ name: 'caseRecord', type: 'SOBJECT', sobjectType: 'Case' }] };
  const request = async (path: string) => ({ status: 200, ok: true, body: { createable: true, queryable: true, deletable: true, fields: path.includes('/Case/') ? [
    { name: 'ContactId', type: 'reference', referenceTo: ['Contact'], createable: true }, { name: 'Subject', type: 'string', createable: true }, { name: 'Description', type: 'textarea', createable: true },
  ] : [{ name: 'LastName', type: 'string', createable: true, filterable: true, nillable: false, length: 80 }] } });
  const result = await describeFlowReferenceContract({ root: '/services/data/v67.0', route: '/services/data/v67.0/actions/custom/flow/LiveCreateCase', descriptor, request });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.source).toBe('salesforce_live_flow_reference_contract');
  expect(result.contextSchema?.referenceField).toBe('ContactId');
  expect(result.contextSchema?.targets[0].bindings.map(v => v.field)).toEqual(['ContactId', 'Subject', 'Description']);
  const unknown = await describeFlowReferenceContract({ root: '/services/data/v67.0', route: '/services/data/v67.0/actions/custom/flow/LiveCreateCase', descriptor: { ...descriptor, inputs: [...descriptor.inputs, { name: 'sendEmail', type: 'BOOLEAN' }] }, request });
  expect(unknown.status).toBe(422);
});
test('child creation uses live parent relationships and the unique writable body', async () => {
  const { describeFlowChildContract } = await import('./flow-record-contract');
  const descriptor = { inputs: [{ name: 'caseComment', type: 'STRING' }, { name: 'caseRecord', type: 'SOBJECT', sObjectType: 'Case' }] };
  const request = async (path: string) => ({ status: 200, ok: true, body: { createable: true, queryable: true, deletable: true, fields: path.includes('/CaseComment/') ? [
    { name: 'ParentId', type: 'reference', referenceTo: ['Case'], createable: true }, { name: 'CommentBody', type: 'textarea', createable: true }, { name: 'CommentBodyRichtext', type: 'textarea', createable: true },
  ] : [{ name: 'Subject', type: 'string', createable: true, filterable: true, length: 255 }], childRelationships: [{ childSObject: 'CaseComment', field: 'ParentId' }] } });
  const result = await describeFlowChildContract({ root: '/services/data/v67.0', route: '/services/data/v67.0/actions/custom/flow/LiveAddComment', descriptor, request });
  expect(result.status).toBe(200);
  expect(result.contextSchema?.source).toBe('salesforce_live_flow_child_contract');
  expect(result.contextSchema?.targetObject).toBe('CaseComment');
  expect(result.contextSchema?.referenceField).toBe('ParentId');
  expect(result.contextSchema?.targets[0].bindings[1].field).toBe('CommentBody');
  const unknown = await describeFlowChildContract({ root: '/services/data/v67.0', route: '/services/data/v67.0/actions/custom/flow/LiveAddComment', descriptor: { inputs: [{ name: 'unknown', type: 'STRING' }, descriptor.inputs[1]] }, request });
  expect(unknown.status).toBe(422);
});
test('writable Account Name remains a marker when person-name components exist', async () => {
  const result = await describeFlowRecordContract({ root: '/services/data/v67.0', descriptor: { inputs: [{ name: 'accountRecord', type: 'SOBJECT', sObjectType: 'Account', description: 'Retrieve or create a record.' }], outputs: [{ name: 'accountRecordId', type: 'STRING' }] }, request: async () => ({ status: 200, ok: true, body: { createable: true, queryable: true, deletable: true, fields: [
    { name: 'BillingState', type: 'string', length: 80, createable: true, filterable: true, nillable: true },
    { name: 'Name', type: 'string', length: 255, createable: true, filterable: true, nameField: true },
    { name: 'LastName', type: 'string', length: 80, createable: false, compoundFieldName: 'Name' },
  ] } }) });
  expect(result.contextSchema?.targets[0].markerField).toBe('Name');
});
test('retrieve-or-create fixtures populate only live writable email lookup fields', async () => {
  const root='/services/data/v67.0', identity='a01000000000002AAA'; let stored:any;
  const request=async(path:string,method='GET',body?:any)=>{
    const result=(body:any,status=200)=>({status,ok:status<400,body});
    if(path.includes('/actions/')){
      const input=body.inputs[0].record;
      expect(input.MailAddress).toMatch(/^probe-[a-f0-9-]+@example\.invalid$/);
      expect(input.HiddenEmail).toBeUndefined();
      stored={...input,Id:identity};return result([{isSuccess:true,errors:[],outputValues:{recordId:identity}}]);
    }
    if(path.includes('/query?'))return result({records:stored?[{Id:identity}]:[]});
    if(method==='DELETE'){stored=undefined;return result(null,204);}
    return stored?result(stored):result([],404);
  };
  const outcome=await invokeFlowRecordContract({root,route:root+'/actions/custom/flow/LiveCreation',plan:{source:'salesforce_live_flow_record_contract',supportsStoredResolution:true,targets:[{objectName:'Prospect',inputName:'record',outputName:'recordId',markerField:'Label',fields:[{name:'MailAddress',type:'email',createable:true,nillable:true},{name:'HiddenEmail',type:'email',createable:false}]}]},request,build:async(_,__,values)=>({values})});
  expect(outcome.contextSchema?.verified).toBe(true);expect(outcome.cleanupError).toBeUndefined();expect(stored).toBeUndefined();
});
