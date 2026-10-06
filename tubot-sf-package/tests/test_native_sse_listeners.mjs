import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('========================================================================');
console.log('TEST SUITE: NATIVE SSE onEmbeddedMessageSent EVENT HANDLER & PAYLOAD PARSER');
console.log('========================================================================\n');

// Read and isolate the pure helper logic from headerCustomLogic.js
const headerCustomLogicPath = path.resolve(__dirname, '../force-app/main/default/lwc/headerCustomLogic/headerCustomLogic.js');
const sourceCode = fs.readFileSync(headerCustomLogicPath, 'utf8');

// Mock browser environment for unit test
const mockWindow = {
    __BT_MIAW_SSE_INITIALIZED__: false,
    _listeners: {},
    addEventListener(name, fn) {
        if (!this._listeners[name]) this._listeners[name] = [];
        this._listeners[name].push(fn);
    },
    dispatchEvent(evt) {
        const list = this._listeners[evt.type] || [];
        for (const fn of list) fn(evt);
    },
    localStorage: {
        getItem: () => null,
        key: () => null,
        length: 0
    },
    sessionStorage: {
        getItem: () => null,
        key: () => null,
        length: 0
    }
};

global.window = mockWindow;
global.document = {
    documentElement: {},
    createElement: () => ({ appendChild: () => {}, style: {} }),
    querySelector: () => null,
    querySelectorAll: () => []
};

// Evaluate the module in simulated sandbox
// Extract extractTurnPayload, handleEmbeddedMessageSent, registerNativeSseListener
const extractedModule = {};
const wrappedScript = `
${sourceCode
    .replace(/import\s+[\s\S]*?;/g, '') // remove ESM imports
    .replace(/export\s+default\s+class[\s\S]*?}/g, '') // remove default class if any
    .replace(/export\s+function\s+/g, 'function ') // remove export function
    .replace(/export\s+\{[\s\S]*?\};/g, '') // remove export { ... }
}
extractedModule.extractTurnPayload = extractTurnPayload;
extractedModule.handleEmbeddedMessageSent = handleEmbeddedMessageSent;
extractedModule.registerNativeSseListener = registerNativeSseListener;
extractedModule.isDuplicateTurn = isDuplicateTurn;
extractedModule.sanitizeAgentAnswer = sanitizeAgentAnswer;
`;

const evalFn = new Function('extractedModule', 'window', 'document', 'handleIncomingTurn', wrappedScript);
evalFn(extractedModule, mockWindow, global.document, () => Promise.resolve({}));

const { extractTurnPayload, handleEmbeddedMessageSent, registerNativeSseListener, isDuplicateTurn } = extractedModule;

console.log('✔ Successfully loaded and compiled headerCustomLogic in test sandbox.\n');

// --------------------------------------------------------------------------
// Test 1: Native SSE onEmbeddedMessageSent with stringified entryPayload
// --------------------------------------------------------------------------
console.log('[Test 1] Parsing native SSE onEmbeddedMessageSent with stringified JSON entryPayload...');
const sampleSseEvent = {
    type: 'onEmbeddedMessageSent',
    detail: {
        conversationId: '04t_conv_0012345',
        conversationEntry: {
            entryType: 'Message',
            identifier: 'msg_987654',
            sender: {
                role: 'EndUser',
                appType: 'EmbeddedMessaging'
            },
            entryPayload: JSON.stringify({
                abstractMessage: {
                    messageType: 'StaticContentMessage',
                    staticContent: {
                        text: 'Hello, what are the specs for Radxa Zero?',
                        formatType: 'Text'
                    }
                }
            })
        }
    }
};

const res1 = extractTurnPayload(sampleSseEvent);
assert.strictEqual(res1.sessionId, '04t_conv_0012345', 'Session ID should match conversationId');
assert.strictEqual(res1.role, 'EndUser', 'Role should be EndUser');
assert.strictEqual(res1.messageText, 'Hello, what are the specs for Radxa Zero?', 'Message text should match staticContent.text');
console.log(' ✔ Passed: Extracted payload matches native SSE structure:', res1);

// --------------------------------------------------------------------------
// Test 2: Native SSE onEmbeddedMessageSent with pre-parsed object entryPayload
// --------------------------------------------------------------------------
console.log('\n[Test 2] Parsing native SSE with pre-parsed object entryPayload...');
const sampleParsedEvent = {
    detail: {
        sessionId: '0Mw_session_9999',
        conversationEntry: {
            sender: { role: 'EndUser' },
            entryPayload: {
                abstractMessage: {
                    staticContent: {
                        text: 'I want to talk to an agent'
                    }
                }
            }
        }
    }
};

const res2 = extractTurnPayload(sampleParsedEvent);
assert.strictEqual(res2.sessionId, '0Mw_session_9999');
assert.strictEqual(res2.role, 'EndUser');
assert.strictEqual(res2.messageText, 'I want to talk to an agent');
console.log(' ✔ Passed: Successfully extracted pre-parsed object entryPayload:', res2);

// --------------------------------------------------------------------------
// Test 3: Agent and Bot role detection
// --------------------------------------------------------------------------
console.log('\n[Test 3] Verifying role detection for Agent and Chatbot turns...');
const agentEvent = {
    detail: {
        conversationId: '04t_conv_0012345',
        conversationEntry: {
            sender: { role: 'Agent' },
            entryPayload: JSON.stringify({
                abstractMessage: {
                    staticContent: { text: 'Hello! I am agent John Swanson. How can I help?' }
                }
            })
        }
    }
};

const botEvent = {
    detail: {
        conversationId: '04t_conv_0012345',
        conversationEntry: {
            sender: { role: 'Chatbot' },
            entryPayload: JSON.stringify({
                abstractMessage: {
                    staticContent: { text: 'Bot: Select an option below.' }
                }
            })
        }
    }
};

const resAgent = extractTurnPayload(agentEvent);
assert.strictEqual(resAgent.role, 'Agent');
assert.strictEqual(resAgent.messageText, 'Hello! I am agent John Swanson. How can I help?');

const resBot = extractTurnPayload(botEvent);
assert.strictEqual(resBot.role, 'Chatbot');
console.log(' ✔ Passed: Accurately identified Agent and Chatbot roles.');

// --------------------------------------------------------------------------
// Test 4: Listener registration & duplicate prevention
// --------------------------------------------------------------------------
console.log('\n[Test 4] Verifying window.addEventListener("onEmbeddedMessageSent") registration...');
registerNativeSseListener();
assert.strictEqual(mockWindow.__BT_MIAW_SSE_INITIALIZED__, true, 'Flag should be set to true');
assert.strictEqual(mockWindow._listeners['onEmbeddedMessageSent']?.length, 1, 'Exactly one listener should be attached');

// Calling register again should NOT add duplicate listeners
registerNativeSseListener();
assert.strictEqual(mockWindow._listeners['onEmbeddedMessageSent']?.length, 1, 'Duplicate listener should NOT be attached');
console.log(' ✔ Passed: Native SSE listener registered with duplicate guard.');

// --------------------------------------------------------------------------
// Test 5: Verify DOM message getters are absent
// --------------------------------------------------------------------------
console.log('\n[Test 5] Verifying removal of document.* message scraping and input hooks...');
assert.strictEqual(sourceCode.includes('processUserMessages'), false, 'processUserMessages should be completely removed');
assert.strictEqual(sourceCode.includes('hookChatInputs'), false, 'hookChatInputs should be completely removed');
assert.strictEqual(sourceCode.includes('_lastTypedText'), false, '_lastTypedText tracking should be completely removed');
assert.strictEqual(sourceCode.includes('embeddedmessaging-chat-message['), false, 'DOM user message selector should be removed');
assert.strictEqual(sourceCode.includes('document.addEventListener(\'embeddedmessaging-message-sent\''), false, 'document embeddedmessaging event listener should be removed');
console.log(' ✔ Passed: All DOM message scraping and input hooking code successfully removed!');

// --------------------------------------------------------------------------
// Test 6: Security & LWS Compliance Audit
// Verifies ZERO cross-component snooping (querySelector, postMessage, shadowRoot)
// --------------------------------------------------------------------------
console.log('\n[Test 6] Security & LWS Compliance Audit (No querySelector, postMessage, or shadowRoot)...');
assert.strictEqual(sourceCode.includes('querySelector'), false, 'document.querySelector / querySelectorAll must be completely absent');
assert.strictEqual(sourceCode.includes('postMessage'), false, 'window.postMessage hacks must be completely absent');
assert.strictEqual(sourceCode.includes('addEventListener(\'message\''), false, 'postMessage message event listeners must be completely absent');
assert.strictEqual(sourceCode.includes('shadowRoot'), false, 'shadowRoot tree traversal must be completely absent');
assert.strictEqual(sourceCode.includes('getRootNode'), false, 'getRootNode traversal must be completely absent');
assert.strictEqual(sourceCode.includes('contentDocument'), false, 'iframe contentDocument snooping must be completely absent');
assert.strictEqual(sourceCode.includes('contentWindow'), false, 'iframe contentWindow snooping must be completely absent');
assert.strictEqual(sourceCode.includes('ownerDocument'), false, 'ownerDocument snooping must be completely absent');
assert.strictEqual(sourceCode.includes('document.'), false, 'document.* access must be completely absent');
assert.strictEqual(sourceCode.includes('MutationObserver'), false, 'document MutationObserver must be completely absent');
assert.strictEqual(sourceCode.includes('setInterval'), false, 'DOM polling setInterval must be completely absent');
console.log(' ✔ Passed: 100% LWS compliant - zero document.querySelector, zero postMessage hacks, zero shadow tree traversal!');

console.log('\n========================================================================');
console.log('ALL 6 NATIVE SSE onEmbeddedMessageSent & LWS COMPLIANCE TESTS PASSED!');
console.log('========================================================================\n');

process.exit(0);
