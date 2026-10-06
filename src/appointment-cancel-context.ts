import { cleanupOwnedContext } from './owned-context-cleanup';
type Value = Record<string, any>;
type Result = { status: number; ok: boolean; body: any };
const identity = (v: any): v is string => typeof v === 'string' && /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(v);
export const APPOINTMENT_CONTEXT_OBJECTS = ['WorkOrder', 'ServiceAppointment'];
export const APPOINTMENT_ATTENDEE_OBJECTS = [...APPOINTMENT_CONTEXT_OBJECTS, 'Contact', 'ServiceAppointmentAttendee'];
export const APPOINTMENT_CONTEXT_FIELDS = ['Subject', 'ParentRecordId', 'Status', 'EarliestStartTime', 'DueDate', 'LastName', 'AttendeeLimit', 'AppointmentMode', 'ServiceAppointmentId', 'AttendeeId'];
/** Native Scheduler cancellation; all fixture fields and relationships are live validated. */
export async function invokeAppointmentCancellation(input: { root: string; route: string; verificationWindowMs?: number; attendeePayloadFields?: string[];
  request: (path: string, method?: string, body?: any) => Promise<Result>;
  build: (name: string, marker: string, values: Value) => Promise<{ values: Value } | { failure: Result }> }) {
  const { root, request } = input;
  const fail = (code: string, message: string): Result => ({ status: 422, ok: false, body: { errorCode: code, message } });
  const attendees = input.route === root + '/actions/standard/saveServiceAppointmentAttendees';
  if (!attendees && input.route !== root + '/actions/standard/cancelAppointment') return fail('APPOINTMENT_ROUTE_INVALID', 'A discovered native cancellation route is required.');
  const schemas: Value = {};
  for (const name of attendees ? APPOINTMENT_ATTENDEE_OBJECTS : APPOINTMENT_CONTEXT_OBJECTS) {
    const r = await request(root + '/sobjects/' + name + '/describe');
    if (!r.ok) return { status: r.status, body: r.body };
    if (!Array.isArray(r.body?.fields) || !r.body.queryable || !r.body.createable || !r.body.deletable)
      return { status: 403, body: { errorCode: 'APPOINTMENT_FIXTURE_PERMISSIONS_REQUIRED', message: `Live ${name} create/read/delete access is required; automatically run setup:context-permissions --auto-appointments during provisioning.` } };
    schemas[name] = r.body;
  }
  const descriptor = await request(input.route);
  if (!descriptor.ok) return descriptor;
  const expected = attendees ? ['serviceAppointmentId','attendeesFields'] : ['recordId','cancelStatus'];
  if (!expected.every(name => descriptor.body?.inputs?.some((f: Value) => f.name === name && f.type === 'STRING')) ||
      descriptor.body.inputs.some((f: Value) => f.required && !expected.includes(f.name)) ||
      !(attendees ? descriptor.body.outputs?.some((f: Value) => f.name === 'createdCount' && f.type === 'INTEGER') :
        descriptor.body.outputs?.some((f: Value) => f.name === 'serviceAppointment' && f.type === 'SOBJECT' && f.sobjectType === 'ServiceAppointment')))
    return fail('APPOINTMENT_CONTRACT_UNAVAILABLE', 'The live native appointment contract differs from the declared record contract.');
  if (attendees && (!schemas.ServiceAppointmentAttendee.fields.some((f: Value) => f.name === 'ServiceAppointmentId' && f.createable && f.filterable && f.referenceTo?.includes('ServiceAppointment')) ||
      !schemas.ServiceAppointmentAttendee.fields.some((f: Value) => f.name === 'AttendeeId' && f.createable && f.filterable && f.referenceTo?.includes('Contact')) ||
      !schemas.ServiceAppointment.fields.some((f: Value) => f.name === 'AttendeeLimit' && f.createable && f.type === 'int')))
    return fail('APPOINTMENT_ATTENDEE_REFERENCE_UNAVAILABLE', 'Live writable Contact attendee relationships and appointment seat limit are required.');
  const fields = schemas.ServiceAppointment.fields;
  if (!fields.some((f: Value) => f.name === 'ParentRecordId' && f.createable && f.referenceTo?.includes('WorkOrder')) ||
      !['EarliestStartTime','DueDate'].every(name => fields.some((f: Value) => f.name === name && f.createable && f.type === 'datetime')))
    return fail('APPOINTMENT_REFERENCE_UNAVAILABLE', 'A live writable WorkOrder parent relationship and appointment times are required.');
  const groupMode = attendees ? fields.find((f: Value) => f.name === 'AppointmentMode' && f.createable && f.type === 'picklist')?.picklistValues?.find((p: Value) => p.active && p.value === 'Group')?.value : undefined;
  if (attendees && !groupMode) return fail('APPOINTMENT_GROUP_MODE_UNAVAILABLE','The live appointment mode schema does not publish a writable Group choice.');
  const status = fields.find((f: Value) => f.name === 'Status' && f.createable && f.updateable && f.type === 'picklist');
  // These are Salesforce standard status semantics, accepted only when the active org publishes them.
  const canceled = status?.picklistValues?.find((p: Value) => p.active && /^cancel(?:ed|led)$/i.test(p.value))?.value;
  const initial = status?.picklistValues?.find((p: Value) => p.active && p.defaultValue && p.value !== canceled)?.value;
  if ((!attendees && !canceled) || !initial) return fail('APPOINTMENT_STATUS_UNAVAILABLE', 'Live cancellation and distinct initial status choices are required; custom status semantics must be configured before testing.');
  const marker = 'AS probe ' + crypto.randomUUID();
  const owned: Array<{ objectName: string; id: string }> = [], attempted: Array<{objectName: string; field: string}> = [];
  const markerFields: Value = {}, fixtures: Value = {};
  let attendeePayloadFields: string[] = [], nativeOutputEvidence: Value | undefined, attendeePredicate: string | undefined, attendeeId: string | undefined;
  let verified = false, cleanupError: string | undefined, before: Value | undefined, after: Value | undefined;
  let outcome = fail('APPOINTMENT_CONTEXT_UNAVAILABLE', 'Owned cancellation context could not be prepared.');
  const capture = (name: string, id: string) => { if (!owned.some(v => v.id === id)) owned.push({objectName:name,id}); };
  const create = async (name: string, values: Value) => {
    const field = schemas[name].fields.find((f: Value) => f.name === (name === 'Contact' ? 'LastName' : 'Subject') && f.createable && f.filterable && f.type === 'string' && f.length >= marker.length);
    if (!field) { outcome = fail('APPOINTMENT_MARKER_UNAVAILABLE', `Live ${name} lacks a writable, queryable ownership marker.`); throw Error('Missing owned marker.'); }
    values = {...values,[field.name]:marker}; markerFields[name] = field.name;
    if (schemas[name].fields.some((f: Value) => f.type === 'reference' && !f.nillable && !f.defaultedOnCreate && !Object.hasOwn(values,f.name))) {
      outcome = fail('APPOINTMENT_REQUIRED_REFERENCE_UNRESOLVED', `The live ${name} fixture has an unresolved required reference.`); throw Error('Unresolved reference.');
    }
    const built = await input.build(name,marker,values);
    if ('failure' in built) {outcome=built.failure;throw Error('Fixture build failed.');}
    attempted.push({objectName:name,field:field.name});
    const created = await request(root+'/sobjects/'+name,'POST',built.values);
    if (!created.ok || !identity(created.body?.id)) {outcome=created;throw Error('Fixture creation failed.');}
    capture(name,created.body.id); fixtures[name]=created.body.id;
    const actual = await request(root+'/sobjects/'+name+'/'+created.body.id);
    // Name the mismatched fields (names only, identifier-validated) so the
    // verdict distinguishes platform rewrites (flows/triggers/defaults)
    // from readback transport faults. Strictness is unchanged: any
    // mismatch still fails the fixture.
    const mismatches = Object.entries(values).filter(([key,value]) => schemas[name].fields.find((f: Value)=>f.name===key)?.type==='datetime'
      ? Date.parse(actual.body?.[key])!==Date.parse(String(value)) : actual.body?.[key]!==value).map(([key])=>key)
      .filter(key=>/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key));
    if (!actual.ok || mismatches.length) {
      outcome=actual.ok ? fail('APPOINTMENT_FIXTURE_UNVERIFIED',`The actual ${name} fixture failed readback of live fields: ${mismatches.join(', ')||'unknown'}.`) : actual;throw Error('Fixture readback failed.');
    }
    return actual.body;
  };
  try {
    outcome = await (async () => {
      const parent = await create('WorkOrder',{});
      // Field Service scheduling fields are minute-precision: the platform
      // truncates sent seconds (live-verified 2026-10-06: sent :29 reads
      // back :00), so second-aligned fixtures fail exact readback. Floor to
      // the minute; truncation only removes precision, so :00 reads back
      // :00 on every org and the strict equality check keeps its meaning.
      const start = Math.floor((Date.now()+3600000)/60000)*60000;
      before = await create('ServiceAppointment',{ParentRecordId:parent.Id,Status:initial,
        EarliestStartTime:new Date(start).toISOString(),DueDate:new Date(start+3600000).toISOString(),...(attendees?{AttendeeLimit:2,AppointmentMode:groupMode}:{})});
      if (attendees) {
        const contact = await create('Contact',{});
        attendeePredicate = `ServiceAppointmentId='${before!.Id}' AND AttendeeId='${contact.Id}'`;
        const args={serviceAppointmentId:before!.Id,attendeesFields:JSON.stringify([{ServiceAppointmentId:before!.Id,AttendeeId:contact.Id}])};
        let native = await request(input.route,'POST',{inputs:[args]});
        const messages: string[] = [];
        const inspectError = (value: any, depth = 0) => {
          if (!value || typeof value !== 'object' || depth > 8) return;
          if (typeof value.message === 'string') messages.push(value.message);
          for (const nested of Object.values(value)) if (nested && typeof nested === 'object') inspectError(nested, depth + 1);
        };
        inspectError(native.body);
        const known = messages.filter((v: any) => typeof v === 'string').map((v: string) => v.match(/known properties:\s*([^)]{1,4096})\)/)?.[1]).find(Boolean);
        if (known) attendeePayloadFields = [...known.matchAll(/"([A-Za-z][A-Za-z0-9_]{0,127})"/g)].map((v: RegExpMatchArray) => v[1]);
        const referenceProperty = attendeePayloadFields.find(name => name.toLowerCase() === 'AttendeeId'.toLowerCase());
        // Searcher first persists this live validator evidence in tenant-scoped D1.
        // A second lifecycle independently reproduces it before using the saved names.
        if (referenceProperty && input.attendeePayloadFields?.length === attendeePayloadFields.length &&
            attendeePayloadFields.every(name => input.attendeePayloadFields!.includes(name))) {
          native = await request(input.route,'POST',{inputs:[{serviceAppointmentId:before!.Id,
            attendeesFields:JSON.stringify([{[referenceProperty]:contact.Id}])}]});
        }
        const found = await request(root+'/query?q='+encodeURIComponent(`SELECT Id,ServiceAppointmentId,AttendeeId FROM ServiceAppointmentAttendee WHERE ${attendeePredicate} LIMIT 3`));
        if (found.ok && Array.isArray(found.body?.records)) {
          for (const item of found.body.records) if (identity(item.Id)) capture('ServiceAppointmentAttendee',item.Id);
          if (found.body.records.length===1) {attendeeId=found.body.records[0].Id;fixtures.ServiceAppointmentAttendee=attendeeId;}
        }
        if (!native.ok || !Array.isArray(native.body) || native.body.length!==1 || native.body[0]?.isSuccess!==true || native.body[0].errors?.length || native.body[0].outputValues?.errorMessage) return native;
        const actual=found.body?.records?.[0];
        verified=!!(found.ok && attendeeId && actual.ServiceAppointmentId===before!.Id && actual.AttendeeId===contact.Id && native.body[0].outputValues?.createdCount===1);
        return verified ? native : fail('APPOINTMENT_ATTENDEE_MUTATION_UNVERIFIED','Salesforce reported success without one actual owned attendee relationship and matching created count.');
      }
      const args: Value = {recordId:before!.Id,cancelStatus:canceled};
      if (descriptor.body.inputs.some((f: Value)=>f.name==='cancellationReason'&&f.type==='STRING')) args.cancellationReason=marker;
      const native = await request(input.route,'POST',{inputs:[args]});
      const actual = await request(root+'/sobjects/ServiceAppointment/'+before!.Id); after=actual.body;
      if (!native.ok || !Array.isArray(native.body) || native.body.length!==1 || native.body[0]?.isSuccess!==true || native.body[0].errors?.length || native.body[0].outputValues?.errorMessage) return native;
      const returned=native.body[0].outputValues?.serviceAppointment;
      nativeOutputEvidence={outputKeys:Object.keys(native.body[0].outputValues??{}).filter(k=>/^[A-Za-z][A-Za-z0-9_]*$/.test(k)),kind:Array.isArray(returned)?"array":typeof returned,fields:returned&&typeof returned==="object"?Object.keys(returned).filter(k=>/^[A-Za-z][A-Za-z0-9_]*$/.test(k)):[],idMatches:returned?.Id===before!.Id,status:returned?.Status};
      verified=!!(actual.ok && after?.Id===before!.Id && after?.Subject===marker && after?.ParentRecordId===parent.Id && after?.Status===canceled && before!.Status!==after?.Status && (returned == null || returned?.Id===before!.Id && (returned.Status == null || returned.Status===canceled)));
      return verified ? native : fail('APPOINTMENT_MUTATION_UNVERIFIED','Salesforce reported success without the expected owned appointment status change and consistent optional typed output.');
    })();
  } catch { if (outcome.ok) outcome=fail('APPOINTMENT_LIFECYCLE_UNVERIFIED','The native appointment lifecycle could not be verified.'); }
  finally {
    if (owned.length && input.verificationWindowMs) await new Promise(resolve=>setTimeout(resolve,input.verificationWindowMs));
    for (const item of attempted) {
      const q=await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM ${item.objectName} WHERE ${item.field}='${marker}' LIMIT 2`));
      if (!q.ok || !Array.isArray(q.body?.records) || q.body.records.length>1) {cleanupError='Owned appointment recovery could not be verified.';continue;}
      for (const r of q.body.records) if (identity(r.Id)) capture(item.objectName,r.Id); else cleanupError='Owned appointment recovery returned an invalid identity.';
    }
    if (attendeePredicate) {
      const found=await request(root+'/query?q='+encodeURIComponent(`SELECT Id FROM ServiceAppointmentAttendee WHERE ServiceAppointmentId='${fixtures.ServiceAppointment}' LIMIT 3`));
      if (!found.ok || !Array.isArray(found.body?.records) || found.body.records.length>2) cleanupError='Owned attendee recovery could not be verified.';
      else for (const r of found.body.records) if(identity(r.Id))capture('ServiceAppointmentAttendee',r.Id);else cleanupError='Owned attendee identity is invalid.';
    }
    const cleaned=await cleanupOwnedContext({root,request,records:owned,order:['ServiceAppointmentAttendee','Contact','ServiceAppointment','WorkOrder'],scopes:[
      ...Object.entries(markerFields).map(([objectName,field])=>({objectName,equals:{[String(field)]:marker}})),
      {objectName:'ServiceAppointmentAttendee',equals:{ServiceAppointmentId:fixtures.ServiceAppointment},ownedParents:[{field:'ServiceAppointmentId',objectName:'ServiceAppointment'}]},
    ]});
    cleanupError ??= cleaned.cleanupError;
    owned.splice(0,owned.length,...cleaned.ownedRecords);
  }
  return {status:outcome.status,body:outcome.body,cleanupError,contextSchema:{source:attendees?'salesforce_live_appointment_attendee_action':'salesforce_live_appointment_cancel_action',objects:Object.values(schemas),
    marker,markerFields,fixtures,ownedRecords:owned,verified,nativeOutputEvidence,attendeePayloadFields,attendeePayloadSchemaSource:attendeePayloadFields.length?'salesforce_live_json_validator':undefined,mutationField:attendees?'ServiceAppointmentId':'Status',beforeValue:before?.Status,afterValue:after?.Status,
    verificationRecordIds:attendees?(attendeeId?[attendeeId]:[]):fixtures.ServiceAppointment?[fixtures.ServiceAppointment]:[],automaticSteps:[
      'Read the live native action and appointment relationship schemas','Automatically run setup:context-permissions --auto-appointments during provisioning',
      ...(attendees?['Discover JSON wrapper properties from live validation and save them in tenant-scoped D1 before retry', 'Revalidate saved property names before mapping the actual owned Contact identity into the accepted wrapper']:[]),
      attendees?'Create an owned Contact, WorkOrder and future Group appointment with two seats':'Create an owned WorkOrder and future appointment with distinct live initial status',attendees?'Invoke native saveServiceAppointmentAttendees with actual owned Contact and appointment identities':'Invoke native cancelAppointment with its actual identity and live canceled status',
      attendees?'Read back and independently CLI verify the actual created attendee relationship':'Read back and independently CLI verify the actual status mutation','Delete only owned context and independently verify absence']}};
}
