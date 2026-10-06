import { test, expect } from 'bun:test';
import { classifyManagedFlowFault } from './managed-flow-faults';

const base = {
  status: 400,
  messages: [],
  codes: [] as string[],
};

test('invitation prefix fault maps to scheduler setup requirement', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['Looks like the invitation URL prefix is missing in your invitation generation flow. Your Salesforce admin can help with that.'],
    codes: ['INVALID_INPUT'],
  });
  expect(fault?.code).toBe('INVITATION_URL_PREFIX_REQUIRED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.requirement).toContain('Invitation URL Prefix');
});

test('quick-action element fault extracts a validated element name only', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    status: 200,
    envelopeSucceeded: true,
    outputErrorMessage: 'We couldn\u2019t execute the \u201cCloseCase\u201d action element of the quickAction type. Review your action name and version and try again.',
    codes: [],
  });
  expect(fault?.code).toBe('FLOW_QUICK_ACTION_UNRESOLVED');
  expect(fault?.actionElement).toBe('CloseCase');
  expect(fault?.requirement).not.toContain('CloseCase');
});

test('quick-action fault requires a success envelope', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    envelopeSucceeded: false,
    messages: ['We couldn\'t execute the "CloseCase" action element of the quickAction type.'],
  });
  expect(fault).toBeNull();
});

test('malicious element names are never reflected', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    status: 200,
    envelopeSucceeded: true,
    outputErrorMessage: 'We couldn\'t execute the "../../etc" action element of the quickAction type.',
  });
  expect(fault?.code).toBe('FLOW_QUICK_ACTION_UNRESOLVED');
  expect(fault?.actionElement).toBeUndefined();
});

test('hidden field from execution user maps to a field-access grant', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['No such column \'Description\' on entity \'Account\'. If you are attempting to use a custom field, be sure to append the \'__c\'.'],
    adminFieldVisible: true,
  });
  expect(fault?.code).toBe('FLOW_LOOKUP_FIELD_ACCESS_REQUIRED');
  expect(fault?.objectName).toBe('Account');
  expect(fault?.fieldName).toBe('Description');
  expect(fault?.retryable).toBe(true);
});

test('person-account-only Account columns map to enablement, not grants', () => {
  for (const field of ['PersonContactId', 'IsPersonAccount']) {
    const fault = classifyManagedFlowFault({
      ...base,
      messages: [`SELECT Id, ${field} ERROR at Row:1 No such column '${field}' on entity 'Account'.`],
      adminFieldVisible: false,
    });
    expect(fault?.code).toBe('PERSON_ACCOUNTS_REQUIRED');
    expect(fault?.fieldName).toBe(field);
  }
});

test('schema-absent columns map to skew, never to a grant', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['No such column \'ProductDescription\' on entity \'Asset\'.'],
    adminFieldVisible: false,
  });
  expect(fault?.code).toBe('FLOW_LOOKUP_SCHEMA_SKEW');
  expect(fault?.retryable).toBe(false);
});

test('missing visibility evidence never classifies a column fault', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['No such column \'Description\' on entity \'Account\'.'],
  });
  expect(fault).toBeNull();
});

test('null segment fault maps to live segment context', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    status: 200,
    envelopeSucceeded: true,
    messages: [],
    outputErrorMessage: 'Cannot invoke "shared.cdp.models.mds.MarketSegment.getMarketSegmentType()" because "segmentWithCriteriaAndType" is null',
  });
  expect(fault?.code).toBe('SEGMENT_CONTEXT_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('summarizer internal error maps upstream only with readable metadata', () => {
  const rejected = classifyManagedFlowFault({
    ...base,
    messages: ['An unexpected error occurred while summarizing the report type. Please try again.'],
    codes: ['INTERNAL_ERROR'],
  });
  expect(rejected).toBeNull();
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An unexpected error occurred while summarizing the report type. Please try again.'],
    codes: ['INTERNAL_ERROR'],
    sourceMetadataReadable: true,
  });
  expect(fault?.code).toBe('SUMMARIZER_BACKEND_UNAVAILABLE');
  expect(fault?.retryable).toBe(false);
});

test('malformed inputs stay unclassified', () => {
  expect(classifyManagedFlowFault({ status: 400, messages: 'nope' } as any)).toBeNull();
  expect(classifyManagedFlowFault({ ...base, messages: ['No such column \'1bad\' on entity \'Account\'.'], adminFieldVisible: true })).toBeNull();
  // Execution-fault opacity was lifted by branch (14): three fieldservice
  // prompt flows with debug-trace + 404 evidence now classify as package skew.
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['An error occurred when executing a flow interview.'],
    codes: ['UNKNOWN_EXCEPTION'],
  })?.code).toBe('MANAGED_FLOW_EXECUTION_FAULT');
});

test('prompt grounding faults map to live session context', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['[UndefinedResolutionError] $.sessionState: is missing but it is required; $.actors: is missing but it is required'],
    codes: ['INVALID_INPUT'],
  });
  expect(fault?.code).toBe('PROMPT_SESSION_CONTEXT_REQUIRED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.requirement).toContain('live recorded session');
});

test('prompt grounding needs both the resolution error and the missing marker', () => {
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['[UndefinedResolutionError] something else happened'],
    codes: ['INVALID_INPUT'],
  })).toBeNull();
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['a value is missing but it is required'],
    codes: ['INVALID_INPUT'],
  })).toBeNull();
});

test('unresolvable prompt data providers map with a validated token only', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['[UndefinedResolutionError] Error occurs resolving a data provider: EinsteinSearch:sfdc_ai__DynamicRetriever. The data provider is either invalid or no longer exists.'],
    codes: ['INVALID_INPUT'],
  });
  expect(fault?.code).toBe('PROMPT_DATA_PROVIDER_UNAVAILABLE');
  expect(fault?.providerName).toBe('EinsteinSearch:sfdc_ai__DynamicRetriever');
  expect(fault?.requirement).not.toContain('EinsteinSearch');
  const hostile = classifyManagedFlowFault({
    ...base,
    messages: ['Error occurs resolving a data provider: ../../etc. The data provider is either invalid or no longer exists.'],
    codes: ['INVALID_INPUT'],
  });
  expect(hostile).toBeNull();
});

test('bare invocable class-name faults map upstream only with the exception code', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['InvocableActionSelectDataSpace'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('MANAGED_INVOCABLE_INTERNAL');
  expect(fault?.retryable).toBe(false);
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['InvocableActionSelectDataSpace'],
    codes: ['INVALID_INPUT'],
  })).toBeNull();
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['InvocableActionSelectDataSpace failed with extra detail'],
    codes: ['UNKNOWN_EXCEPTION'],
  })).toBeNull();
});

test('agentic retrieval backend exceptions map upstream', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['KA: InvocableAnswerQuestionsWithAgenticRetriever: generateResponse: Exception'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('AGENTIC_RETRIEVAL_BACKEND_FAULT');
  expect(fault?.retryable).toBe(false);
});

test('opaque support error-ID faults map upstream only with the exception code', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An error occurred. Try again, or contact Salesforce Customer Support and provide this error ID: 123-456 (789).'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('UPSTREAM_ERROR_ID_FAULT');
  expect(fault?.retryable).toBe(false);
  expect(fault?.requirement).not.toContain('123-456');
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['An error occurred. Try again, or contact Salesforce Customer Support and provide this error ID: 123-456 (789).'],
    codes: ['INVALID_INPUT'],
  })).toBeNull();
});

test('persistence-clause error-ID variant maps to the same upstream fault', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['Something went wrong. Try again. If the problem persists, contact Salesforce Customer Support and provide this error ID: 967239863-364293 (-36570505).'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('UPSTREAM_ERROR_ID_FAULT');
  expect(fault?.retryable).toBe(false);
  expect(fault?.requirement).not.toContain('967239863');
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['Something went wrong. If the problem persists without an error ID there is nothing to report.'],
    codes: ['UNKNOWN_EXCEPTION'],
  })).toBeNull();
});

test('flow-run denials map to an execution-identity grant', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['The running user doesn\u2019t have the required access to run the flow. Check the user\u2019s flow run permissions and try again.'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('FLOW_RUN_PERMISSION_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('deep-research report faults stay on the generic missing-context verdict', () => {
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['Failed to load deep research report metadata: HTTP response code: 404'],
    codes: ['UNKNOWN_EXCEPTION'],
  })).toBeNull();
});

test('non-quickAction element faults classify with element identity and skew requirement', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    envelopeSucceeded: true,
    messages: ['An error occurred while updating the CI: We couldn\u2019t execute the \u201cExecuteCiUpdate\u201d action element of the executeCmdbCiUpdate type. Review your action name and version and try again.'],
    codes: [],
  });
  expect(fault?.code).toBe('FLOW_ACTION_ELEMENT_UNRESOLVED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.actionElement).toBe('ExecuteCiUpdate');
  expect(fault?.requirement).toContain('executeCmdbCiUpdate');
  expect(fault?.requirement).not.toContain('An error occurred while updating');
});

test('spanish unresolved-element faults classify instead of falsely converting', () => {
  const fault = classifyManagedFlowFault({
    envelopeSucceeded: true,
    messages: ['No hemos podido ejecutar el elemento de acción "sfdc_ai__DynamicRetriever" del tipo getEinsteinRetrieverResults. Revise el nombre y la versión de su acción e inténtelo de nuevo.'],
    codes: [],
  });
  expect(fault?.code).toBe('FLOW_ACTION_ELEMENT_UNRESOLVED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.actionElement).toBe('sfdc_ai__DynamicRetriever');
  expect(fault?.requirement).toContain('getEinsteinRetrieverResults');
  expect(fault?.requirement).not.toContain('Revise el nombre');
});

test('interview start gacks classify terminal without retry', () => {
  const fault = classifyManagedFlowFault({
    status: 400,
    messages: ['An error occurred when trying to start a flow interview.'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('MANAGED_FLOW_INTERVIEW_START_GACK');
  expect(fault?.retryable).toBe(false);
  expect(classifyManagedFlowFault({
    status: 400,
    messages: ['An error occurred when executing a flow interview.'],
    codes: ['UNKNOWN_EXCEPTION'],
  })?.code).toBe('MANAGED_FLOW_EXECUTION_FAULT');
});

test('unverified-customer agent outputs map to live agent context', () => {
  for (const message of [
    "You aren't a verified customer. Verify your details and try again.",
    "I couldn't complete your request because the customer isn't verified. Do you want to escalate the conversation?",
    "I couldn\u2019t identify your customer ID. Tell me more about your firstName, lastName or company information so that I can create a lead.",
    'The retrieved contextual intent was empty.',
  ]) {
    const fault = classifyManagedFlowFault({
      ...base,
      status: 200,
      envelopeSucceeded: true,
      outputErrorMessage: message,
      codes: ['ACTION_OUTPUT_ERROR'],
    });
    expect(fault?.code).toBe('FLOW_AGENT_CONTEXT_REQUIRED');
    expect(fault?.retryable).toBe(true);
    expect(fault?.requirement).toContain('verified-customer identity');
  }
  expect(classifyManagedFlowFault({
    ...base,
    status: 200,
    envelopeSucceeded: true,
    outputErrorMessage: 'This operation cannot be completed at this time.',
    codes: ['ACTION_OUTPUT_ERROR'],
  })).toBeNull();
});

test('flow-internal permission gates map to package enablement', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    status: 200,
    envelopeSucceeded: true,
    outputErrorMessage: '<p>The flow cannot be continued because certain permissions need to be enabled</p>',
    codes: ['ACTION_OUTPUT_ERROR'],
  });
  expect(fault?.code).toBe('FLOW_PACKAGE_PERMISSION_REQUIRED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.requirement).toContain('package permissions');
});

test('external callout faults map with a validated dotted invocable only', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    status: 200,
    envelopeSucceeded: true,
    outputErrorMessage: "Callout failed for invocable action Servicenow.GetUsers. java.lang.RuntimeException: com.externalservices.ExternalConnectionException: The callout couldn't access the endpoint.",
    codes: ['ACTION_OUTPUT_ERROR'],
  });
  expect(fault?.code).toBe('FLOW_EXTERNAL_CALLOUT_UNAVAILABLE');
  expect(fault?.retryable).toBe(true);
  expect(fault?.invocableName).toBe('Servicenow.GetUsers');
  expect(fault?.requirement).not.toContain('Servicenow');
  const hostile = classifyManagedFlowFault({
    ...base,
    status: 200,
    envelopeSucceeded: true,
    outputErrorMessage: 'Callout failed for invocable action ../../etc. The callout could not connect.',
    codes: ['ACTION_OUTPUT_ERROR'],
  });
  expect(hostile?.code).toBe('FLOW_EXTERNAL_CALLOUT_UNAVAILABLE');
  expect(hostile?.invocableName).toBeUndefined();
});

test('named null identifiers map to live identifiers, never to platform faults', () => {
  for (const [message, name] of [
    ['ItemSysId is null', 'ItemSysId'],
    ['RequestNumber is Null', 'RequestNumber'],
  ] as const) {
    const fault = classifyManagedFlowFault({
      ...base,
      status: 200,
      envelopeSucceeded: true,
      outputErrorMessage: message,
      codes: ['ACTION_OUTPUT_ERROR'],
    });
    expect(fault?.code).toBe('FLOW_INPUT_IDENTIFIER_REQUIRED');
    expect(fault?.retryable).toBe(true);
    expect(fault?.inputName).toBe(name);
    expect(fault?.requirement).toContain(name);
  }
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['Cannot invoke "shared.Foo.bar()" because "record" is null'],
    codes: ['UNKNOWN_EXCEPTION'],
  })).toBeNull();
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['System.FinalException: Argument 1 cannot be null'],
    codes: ['UNKNOWN_EXCEPTION'],
  })).toBeNull();
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['System.FinalException: Argument sessionId is null'],
    codes: ['UNKNOWN_EXCEPTION'],
  })).toBeNull();
  expect(classifyManagedFlowFault({
    ...base,
    status: 200,
    envelopeSucceeded: true,
    outputErrorMessage: 'The result is null',
    codes: ['ACTION_OUTPUT_ERROR'],
  })).toBeNull();
});

test('managed execution faults classify as package skew, never echoing upstream', () => {
  const fault = classifyManagedFlowFault({
    status: 400,
    messages: ['An error occurred when executing a flow interview.'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('MANAGED_FLOW_EXECUTION_FAULT');
  expect(fault?.retryable).toBe(true);
  expect(fault?.requirement).not.toContain('executing a flow interview');
  expect(classifyManagedFlowFault({
    status: 400,
    messages: ['Some other unknown exception text.'],
    codes: ['UNKNOWN_EXCEPTION'],
  })).toBeNull();
});

test('inline gack-ID sentence classifies as the opaque error-ID fault', () => {
  const fault = classifyManagedFlowFault({
    status: 400,
    messages: ['Something went wrong. Gack ID: 1548225614-46856 (-1056719416)'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('UPSTREAM_ERROR_ID_FAULT');
  expect(fault?.retryable).toBe(false);
  expect(fault?.requirement).not.toContain('1548225614');
});

test('unresolvable customer ID classifies as agent context required', () => {
  const fault = classifyManagedFlowFault({
    status: 200,
    messages: ["I couldn\u2019t find that customer ID. Check your ID and try again. Or is there something else I can help you with?"],
    codes: ['ACTION_OUTPUT_REJECTED'],
  });
  expect(fault?.code).toBe('FLOW_AGENT_CONTEXT_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('execution faults with a missing invocable narrow to the dependency code', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An error occurred when executing a flow interview.'],
    codes: ['UNKNOWN_EXCEPTION'],
    missingInvocable: 'GetCustomerSignalsInsights',
  });
  expect(fault?.code).toBe('FLOW_EXECUTION_INVOCABLE_MISSING');
  expect(fault?.retryable).toBe(true);
  expect(fault?.invocableName).toBe('GetCustomerSignalsInsights');
  expect(fault?.requirement).not.toContain('GetCustomerSignalsInsights');
  expect(fault?.requirement).not.toContain('executing a flow interview');
});

test('execution faults with schema skew terminalize on the skew code', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An error occurred when executing a flow interview.'],
    codes: ['UNKNOWN_EXCEPTION'],
    missingSchemaField: { objectName: 'Asset', fieldName: 'ProductDescription' },
  });
  expect(fault?.code).toBe('FLOW_EXECUTION_SCHEMA_SKEW');
  expect(fault?.retryable).toBe(false);
  expect(fault?.objectName).toBe('Asset');
  expect(fault?.fieldName).toBe('ProductDescription');
});

test('execution-fault evidence without the opaque sentence stays unclassified', () => {
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['Some other unknown exception text.'],
    codes: ['UNKNOWN_EXCEPTION'],
    missingInvocable: 'GetCustomerSignalsInsights',
  })).toBeNull();
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['Some other unknown exception text.'],
    codes: ['UNKNOWN_EXCEPTION'],
    missingSchemaField: { objectName: 'Asset', fieldName: 'ProductDescription' },
  })).toBeNull();
});

test('invalid execution-fault evidence falls back to the generic code', () => {
  for (const evidence of [
    { missingInvocable: '../../etc' },
    { missingInvocable: '' },
    { missingSchemaField: { objectName: 'Asset', fieldName: 'not a field' } },
    { missingSchemaField: { objectName: '', fieldName: '' } },
  ] as const) {
    const fault = classifyManagedFlowFault({
      ...base,
      messages: ['An error occurred when executing a flow interview.'],
      codes: ['UNKNOWN_EXCEPTION'],
      ...evidence,
    });
    expect(fault?.code).toBe('MANAGED_FLOW_EXECUTION_FAULT');
    expect(fault?.retryable).toBe(true);
  }
});

test('the retryable invocable shape wins when both evidences are present', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An error occurred when executing a flow interview.'],
    codes: ['UNKNOWN_EXCEPTION'],
    missingInvocable: 'extractHistoricalData',
    missingSchemaField: { objectName: 'Asset', fieldName: 'ProductDescription' },
  });
  expect(fault?.code).toBe('FLOW_EXECUTION_INVOCABLE_MISSING');
  expect(fault?.retryable).toBe(true);
});

test('action-level permission precondition classifies as package permission required', () => {
  const fault = classifyManagedFlowFault({
    status: 400,
    messages: ["This action can't continue because certain permissions need to be enabled. Contact your Salesforce admin."],
    codes: ['INTERNAL_ERROR'],
  });
  expect(fault?.code).toBe('FLOW_PACKAGE_PERMISSION_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('managed trigger null-deref terminalizes with the validated trigger name', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['FSL.TR001_Service_BeforeInsert: execution of BeforeInsert caused by: System.NullPointerException: Attempt to de-reference a null object (System Code)'],
    codes: ['CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY'],
  });
  expect(fault?.code).toBe('MANAGED_TRIGGER_NULL_FAULT');
  expect(fault?.retryable).toBe(false);
  expect(fault?.requirement).toContain('FSL.TR001_Service_BeforeInsert');
});

test('trigger fault wins over the generic null-deref branch', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['FSL.TR001_Service_BeforeInsert: execution of BeforeInsert caused by: System.NullPointerException: Attempt to de-reference a null object (System Code)'],
    codes: ['CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY'],
  });
  expect(fault?.code).not.toBe('LIVE_INPUT_VALUE_REQUIRED');
});

test('trigger no-rows fault maps to package setup data', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['et4ae5.updateBURecord: execution of BeforeInsert caused by: System.QueryException: List has no rows for assignment to SObject (System Code)'],
    codes: ['CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY'],
  });
  expect(fault?.code).toBe('PACKAGE_TRIGGER_DATA_REQUIRED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.requirement).toContain('et4ae5.updateBURecord');
});

test('unregistered callout endpoint maps to setup without echoing the URL', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An Apex error occurred: System.CalloutException: Unauthorized endpoint, please check Setup->Security->Remote site settings. endpoint = https://inventory-apidemo-2020.herokuapp.com/inventory/product/12345'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('CALLOUT_ENDPOINT_SETUP_REQUIRED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.requirement).not.toContain('herokuapp');
});

test('vendor DML required-field fault echoes only validated field names', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An Apex error occurred: System.DmlException: Insert failed. First exception on row 0; first error: REQUIRED_FIELD_MISSING, Required fields are missing: [Name, CartId, RelatedEntityId]: [Name, CartId, RelatedEntityId]'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('VENDOR_DML_ROW_FAULT');
  expect(fault?.retryable).toBe(false);
  expect(fault?.requirement).toContain('Name, CartId, RelatedEntityId');
});

test('vendor DML wrong-type fault terminalizes', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An Apex error occurred: System.DmlException: Insert failed. First exception on row 0; first error: INVALID_TYPE_ON_FIELD_IN_RECORD, Auto Schedule: value not of required type: : [FSL__Auto_Schedule__c]'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('VENDOR_DML_ROW_FAULT');
  expect(fault?.retryable).toBe(false);
  expect(fault?.requirement).toContain('FSL__Auto_Schedule__c');
});

test('null ApexObject terminalizes as unavailable procedure input', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['Cannot invoke "common.apex.runtime.ApexObject.getRuntimeType()" because "apexObject" is null'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('INTEGRATION_PROCEDURE_INPUT_UNAVAILABLE');
  expect(fault?.retryable).toBe(false);
});

test('null targetEntity terminalizes: live records never resolve it', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['Cannot invoke "common.udd.EntityInfo.getApiElementInfoByApiName(String)" because "targetEntity" is null'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('UDD_TARGET_ENTITY_UNRESOLVABLE');
  expect(fault?.retryable).toBe(false);
  expect(fault?.requirement).toContain('session context');
});

test('unobserved JVM null-var names stay unclassified', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['Cannot invoke "com.example.Widget.run()" because "widget" is null'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault).toBeNull();
});

test('list-index fault with declared inputs asks for structured values', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An Apex error occurred: System.ListException: List index out of bounds: 0'],
    codes: ['UNKNOWN_EXCEPTION'],
    hasInputs: true,
  });
  expect(fault?.code).toBe('STRUCTURED_INPUT_VALUE_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('list-index fault with zero declared inputs terminalizes', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An Apex error occurred: System.ListException: List index out of bounds: 0'],
    codes: ['UNKNOWN_EXCEPTION'],
    hasInputs: false,
  });
  expect(fault?.code).toBe('VENDOR_EMPTY_RESULT_FAULT');
  expect(fault?.retryable).toBe(false);
});

test('list-index fault on cart-id inputs asks for owned cart substrate', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An Apex error occurred: System.ListException: List index out of bounds: 0'],
    codes: ['UNKNOWN_EXCEPTION'],
    hasInputs: true,
    inputNames: ['cartIds'],
  });
  expect(fault?.code).toBe('OWNED_CART_SUBSTRATE_REQUIRED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.requirement).toContain('owned commerce cart');
});

test('list-index fault without cart vocabulary stays on structured values', () => {
  for (const inputNames of [['thisAddressList'], ['verificationCode'], ['cartoon'], undefined]) {
    const fault = classifyManagedFlowFault({
      ...base,
      messages: ['An Apex error occurred: System.ListException: List index out of bounds: 1'],
      codes: ['UNKNOWN_EXCEPTION'],
      hasInputs: true,
      ...(inputNames === undefined ? {} : { inputNames }),
    });
    expect(fault?.code).toBe('STRUCTURED_INPUT_VALUE_REQUIRED');
    expect(fault?.retryable).toBe(true);
  }
});

test('vendor null dereference asks for live bound values', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['An Apex error occurred: System.NullPointerException: Attempt to de-reference a null object'],
    codes: ['UNKNOWN_EXCEPTION'],
    hasInputs: true,
  });
  expect(fault?.code).toBe('LIVE_INPUT_VALUE_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('dynamic SOQL token fault asks for live identifiers', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ["An Apex error occurred: System.QueryException: unexpected token: '-'"],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('DYNAMIC_QUERY_IDENTIFIER_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('bare JSON token fault asks for a JSON document', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ["Unrecognized token 'action': was expecting (JSON String, Number, Array, Object or token 'null', 'true' or 'false')"],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('JSON_DOCUMENT_INPUT_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('model inference failure terminalizes without retry amplification', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['Something went wrong and we’re unable to get your predictions. Try again later. Inference failed for model: sfdc_ai__DefaultSalesforceSentimentAnalysis'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('MODEL_INFERENCE_UNAVAILABLE');
  expect(fault?.retryable).toBe(false);
});

test('session activation without assignment maps to the assignment order', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['The permission set must be pre-assigned to the user before being activated'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('SESSION_ASSIGNMENT_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('context-name validation fault asks for alphanumeric identifiers', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: [' SF-CTX-00001: Enter a name that contains alphanumeric characters, and doesn’t start or end with a space. ; Failed to create context.'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('ALPHANUMERIC_CONTEXT_NAME_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('undeclared attributes wrapper asks for declared-inputs-only shapes', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['The flow doesn\'t have a variable with the name "attributes", or the variable isn\'t available for input.'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('DECLARED_INPUT_SHAPE_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('pardot gate maps to data access', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['You need access to Pardot data to view lists. Contact your admin for help.'],
    codes: ['UNKNOWN_EXCEPTION'],
  });
  expect(fault?.code).toBe('PARDOT_DATA_ACCESS_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('opaque fault with schema-identifier inputs asks for live schema values', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['Something went wrong. Try again later or ask your Salesforce admin for help.'],
    codes: ['UNKNOWN_EXCEPTION'],
    inputNames: ['objectName', 'fieldName'],
  });
  expect(fault?.code).toBe('SCHEMA_IDENTIFIER_VALUE_REQUIRED');
  expect(fault?.retryable).toBe(true);
});

test('opaque fault without schema-identifier inputs stays unclassified', () => {
  const fault = classifyManagedFlowFault({
    ...base,
    messages: ['Something went wrong. Try again later or ask your Salesforce admin for help.'],
    codes: ['UNKNOWN_EXCEPTION'],
    inputNames: ['recordId'],
  });
  expect(fault).toBeNull();
});

test('flow-owned access-denial output maps to upstream access required', () => {
  const fault = classifyManagedFlowFault({
    status: 200,
    messages: [],
    codes: [],
    envelopeSucceeded: true,
    outputErrorMessage: "Looks like you don't have access to get appointment time slots. Is there something else I can help you with?",
  });
  expect(fault?.code).toBe('FLOW_UPSTREAM_ACCESS_REQUIRED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.requirement).toContain('fixture permission set');
  expect(fault?.requirement).not.toContain('appointment time slots');
});

test('flow-owned missing-setup output maps to a discovered live record', () => {
  const fault = classifyManagedFlowFault({
    status: 200,
    messages: ['Error: Work Type not found'],
    codes: [],
    envelopeSucceeded: true,
  });
  expect(fault?.code).toBe('FLOW_SETUP_RECORD_REQUIRED');
  expect(fault?.retryable).toBe(true);
  expect(fault?.setupNoun).toBe('Work Type');
  expect(fault?.requirement).toContain('Work Type');
});

test('bare not-found prose and quoted values stay unclassified', () => {
  expect(classifyManagedFlowFault({ ...base, messages: ['Record not found'] })).toBeNull();
  expect(classifyManagedFlowFault({ ...base, messages: ["ServiceResource with External_ID__c='SRV-1' not found."] })).toBeNull();
  expect(classifyManagedFlowFault({ ...base, messages: ['DataGraph not found with definition ID 123'] })).toBeNull();
  expect(classifyManagedFlowFault({
    ...base,
    messages: ['The operation completed but a referenced Work Type not found warning appeared in the log output trail'],
  })).toBeNull();
});

test('field-security denial maps to field access with a validated field only', () => {
  const fault = classifyManagedFlowFault({
    status: 400,
    messages: ['Unable to create/update fields: WorkOrderId. Please check the security settings of this field and verify that it is read/write for your profile or permission set.'],
    codes: ['INVALID_FIELD_FOR_INSERT_UPDATE'],
  });
  expect(fault?.code).toBe('FIELD_ACCESS_REQUIRED');
  expect(fault?.fieldName).toBe('WorkOrderId');
  expect(fault?.requirement).toContain('WorkOrderId');
  expect(fault?.retryable).toBe(true);
  expect(classifyManagedFlowFault({
    status: 400,
    messages: ['Unable to create/update fields: WorkOrderId.'],
    codes: ['INVALID_FIELD_FOR_INSERT_UPDATE'],
  })).toBeNull();
  expect(classifyManagedFlowFault({
    status: 400,
    messages: ['Please check the security settings of this field and verify that it is read/write for your profile or permission set.'],
    codes: ['REQUIRED_FIELD_MISSING'],
  })).toBeNull();
});
