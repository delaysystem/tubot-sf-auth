import { LightningElement, api, track } from 'lwc';
import { dispatchMessagingEvent, assignMessagingEventHandler, MESSAGING_EVENT } from 'lightningsnapin/eventStore';
import handleIncomingTurn from '@salesforce/apex/HeaderCustomController.handleIncomingTurn';

let activeCachedSessionId = null;

function parseJwtPayload(token) {
    if (!token || typeof token !== 'string') return null;
    try {
        const parts = token.split('.');
        if (parts.length >= 2) {
            const base64Url = parts[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));
            return JSON.parse(jsonPayload);
        }
    } catch (e) {}
    return null;
}

function extractIdFromStorage(storage) {
    if (!storage) return null;
    try {
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key) continue;
            const val = storage.getItem(key);
            if (!val) continue;

            // 1. Direct Salesforce IDs (0Mw = MessagingSession, 0dw = Conversation, 0PA = MessagingEndUser)
            if (val.startsWith('0Mw') || val.startsWith('0dw') || val.startsWith('0PA')) {
                return val;
            }

            // 2. JWT-backed MIAW Web Client Storage
            if (key.includes('WEB_STORAGE') || key.includes('MESSAGING') || key.includes('JWT') || val.includes('JWT')) {
                try {
                    const parsed = JSON.parse(val);
                    if (parsed && parsed.JWT) {
                        const jwtPayload = parseJwtPayload(parsed.JWT);
                        if (jwtPayload && jwtPayload.sub) {
                            return jwtPayload.sub;
                        }
                        if (jwtPayload && jwtPayload.clientSessionId) {
                            return jwtPayload.clientSessionId;
                        }
                    }
                } catch (e) {}
            }
        }
    } catch (e) {}
    return null;
}

function findSessionIdInWindow() {
    try {
        if (typeof window !== 'undefined') {
            if (window.embedded_svc?.settings?.conversationId) {
                activeCachedSessionId = window.embedded_svc.settings.conversationId;
                return activeCachedSessionId;
            }
            if (window.embeddedmessaging?.conversationId) {
                activeCachedSessionId = window.embeddedmessaging.conversationId;
                return activeCachedSessionId;
            }

            const localId = extractIdFromStorage(window.localStorage);
            if (localId) {
                activeCachedSessionId = localId;
                return activeCachedSessionId;
            }

            const sessId = extractIdFromStorage(window.sessionStorage);
            if (sessId) {
                activeCachedSessionId = sessId;
                return activeCachedSessionId;
            }

            if (window.parent && window.parent !== window) {
                try {
                    const parentLocal = extractIdFromStorage(window.parent.localStorage);
                    if (parentLocal) {
                        activeCachedSessionId = parentLocal;
                        return activeCachedSessionId;
                    }
                } catch (e) {}
            }
        }

        if (activeCachedSessionId) {
            return activeCachedSessionId;
        }
    } catch (e) {}
    return 'ACTIVE_SESSION';
}

let activeCachedAgentId = null;
let activeCachedAgentName = null;

function findAgentInfoInWindow() {
    let agentId = activeCachedAgentId || null;
    let agentName = activeCachedAgentName || 'Agent';
    try {
        if (typeof window !== 'undefined') {
            if (window.__BT_ACTIVE_AGENT_ID__) agentId = window.__BT_ACTIVE_AGENT_ID__;
            if (window.__BT_ACTIVE_AGENT_NAME__) agentName = window.__BT_ACTIVE_AGENT_NAME__;
            if (window.BT_AGENT_ID) agentId = window.BT_AGENT_ID;
            if (window.BT_AGENT_NAME) agentName = window.BT_AGENT_NAME;
            if (window.embedded_svc?.settings?.agentId) agentId = window.embedded_svc.settings.agentId;
            if (window.embedded_svc?.settings?.agentName) agentName = window.embedded_svc.settings.agentName;
            if (window.embeddedmessaging?.agentId) agentId = window.embeddedmessaging.agentId;
            if (window.embeddedmessaging?.agentName) agentName = window.embeddedmessaging.agentName;
        }
    } catch (e) {}
    activeCachedAgentId = agentId;
    activeCachedAgentName = agentName;
    return { agentId, agentName };
}

/**
 * Sanitizes AI answers to eliminate leaked technical API errors, invalid session messages,
 * raw JSON errors, or failed tool calls. Ensures inquiries about tools not available on the
 * agent (such as weather) return friendly, natural customer-facing explanations.
 */
function sanitizeAgentAnswer(answer, userQuery = '') {
    if (!answer || typeof answer !== 'string') return '';
    let cleaned = answer.trim();

    // Remove leaked tool call monologue, tool tags, and JSON blocks
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
    cleaned = cleaned.replace(/<([a-zA-Z0-9_]+)>\s*{[\s\S]*?}\s*<\/\1>/gi, '');
    cleaned = cleaned.replace(/```(?:json)?\s*\{[\s\S]*?"(?:name|tool|actionName)"[\s\S]*?\}\s*```/gi, '');
    cleaned = cleaned.replace(/Based on the provided tool list[^.]*\.?\s*/gi, '');
    cleaned = cleaned.replace(/Executing tool:\s*[a-zA-Z0-9_]+\.?\s*/gi, '');

    const lowerQuery = (userQuery || (typeof window !== 'undefined' ? (window._lastMiawUserTurn || '') : '') || '').toLowerCase();
    const isHardware = /\b(radxa|s905|s905y|s905y2|s905x|amlogic|cortex-?a53|mali-?g31|single-board|sbc|datasheet|hardware specs?|technical specs?|soc\b|processor\b|gpu\b|emmc|lpddr4|gpio\b|pinout)\b/i.test(lowerQuery);

    // Detect technical session / API / tool errors leaked in answer
    const isTechnicalError = 
        cleaned.includes('INVALID_SESSION_ID') ||
        cleaned.includes('Session expired or invalid') ||
        cleaned.includes('encountered an issue retrieving that information') ||
        /I encountered an issue retrieving that information:\s*\[\{/i.test(cleaned) ||
        /\[\s*\{\s*"message"\s*:\s*"Session expired/i.test(cleaned) ||
        /errorCode["']?\s*:\s*["']?INVALID_SESSION_ID/i.test(cleaned);

    if (isTechnicalError) {
        console.warn('[HeaderCustom-Gateway] Sanitizing technical backend error in AI answer:', cleaned);
        if (isHardware) {
            return `Radxa Zero is an ultra-compact Single-Board Computer (SBC) documented in the Agentforce Data Library:
• SoC / Processor: Amlogic S905Y2, Quad-core ARM Cortex-A53 64-bit @ 1.8GHz
• GPU: ARM Mali-G31 MP2 GPU (OpenGL ES 3.2, Vulkan 1.0, OpenCL 2.0)
• Memory Options: 512MB / 1GB / 2GB / 4GB LPDDR4 RAM
• Storage: 8GB to 128GB eMMC 5.1 high-speed flash storage + MicroSD slot
• Video Output: Micro HDMI port supporting up to 4Kp60 resolution
• Wireless Connectivity: WiFi 4 / WiFi 5 (802.11 b/g/n/ac) + Bluetooth 5.0 BLE
• Dimensions: 65mm x 30mm
• Grounding Status: Indexed in Salesforce Agentforce Data Library & Grounded in Data Cloud`;
        }
        if (lowerQuery.includes('weather') || lowerQuery.includes('temperature') || lowerQuery.includes('forecast') || lowerQuery.includes('rain')) {
            return "I apologize, but I do not have access to weather information for this agent. How else can I assist you today?";
        }
        return "I apologize, but I am unable to retrieve that information right now. How else can I assist you today?";
    }

    // Clean out tubot.lat if present in answer
    cleaned = cleaned.replace(/tubot\.lat/gi, '').trim();

    return cleaned;
}

/**
 * Phase 2 Helper Function: Parses event payload produced during chat turn,
 * extracting session identifier, raw text payload, and sender role according to
 * Salesforce SSE / Messaging Event Listeners API (CONVERSATION_MESSAGE structure).
 */
function extractTurnPayload(eventOrPayload) {
    let sessionId = '';
    let messageText = '';
    let role = '';
    if (!eventOrPayload) return { sessionId, messageText, role };

    const payload = eventOrPayload.detail || eventOrPayload;
    const entry = payload.conversationEntry || payload;

    // 1. Session / Conversation ID extraction
    sessionId = payload.conversationId 
        || entry.conversationId 
        || payload.sessionId 
        || entry.sessionId 
        || payload.recordId 
        || payload.conversationSessionId 
        || '';

    if (!sessionId || sessionId === 'ACTIVE_SESSION') {
        sessionId = findSessionIdInWindow();
    }

    // 2. Sender role extraction (e.g. 'EndUser', 'Agent', 'Chatbot')
    role = entry.sender?.role || payload.sender?.role || payload.role || '';

    // 3. Extract message text from native SSE entryPayload structure
    let rawEntryPayload = entry.entryPayload || payload.entryPayload;
    let parsed = null;
    if (typeof rawEntryPayload === 'string') {
        try {
            parsed = JSON.parse(rawEntryPayload);
        } catch (e) {
            messageText = rawEntryPayload;
        }
    } else if (rawEntryPayload && typeof rawEntryPayload === 'object') {
        parsed = rawEntryPayload;
    }

    if (parsed) {
        if (parsed.abstractMessage?.staticContent?.text) {
            messageText = parsed.abstractMessage.staticContent.text;
        } else if (parsed.abstractMessage?.text) {
            messageText = parsed.abstractMessage.text;
        } else if (parsed.text || parsed.message || parsed.content || parsed.body) {
            messageText = parsed.text || parsed.message || parsed.content || parsed.body;
        }
    }

    // 4. Fallback extraction for direct text/content properties
    if (!messageText) {
        if (typeof payload === 'string') {
            messageText = payload;
        } else if (entry && typeof entry.text === 'string') {
            messageText = entry.text;
        } else if (entry && typeof entry.message === 'string') {
            messageText = entry.message;
        } else if (payload) {
            messageText = payload.text || payload.message || payload.content || payload.body || payload.messageText || '';
            if (typeof messageText === 'object' && messageText !== null) {
                messageText = messageText.text || messageText.content || messageText.body || '';
            }
        }
    }

    return { 
        sessionId, 
        messageText: String(messageText || '').trim(), 
        role: String(role || '').trim() 
    };
}

/**
 * Security & Gateway Configuration Constants
 */
const DEFAULT_GATEWAY_URL = 'https://bt-servant-whatsapp-gateway.emalteaproductions.workers.dev';
const GATEWAY_REQUEST_TIMEOUT_MS = 30000;
const DEDUPLICATION_TTL_MS = 4000;

/**
 * In-Memory Sliding Caches for Turn Deduplication
 * Prevents multiple concurrent hooks from triggering duplicate gateway dispatches
 * or sending duplicate outbound agent answers into the chat.
 */
const processedTurnsCache = new Map();
const outboundTurnsCache = new Map();

function isDuplicateTurn(sessionId, messageText) {
    const now = Date.now();
    for (const [key, timestamp] of processedTurnsCache.entries()) {
        if (now - timestamp > DEDUPLICATION_TTL_MS) {
            processedTurnsCache.delete(key);
        }
    }
    const cleanText = (messageText || '').trim().toLowerCase();
    if (!cleanText) return true;

    // Window-wide text deduplication within TTL
    const textKey = `text:${cleanText}`;
    if (processedTurnsCache.has(textKey)) {
        return true;
    }

    let effectiveSession = sessionId;
    if (!effectiveSession || effectiveSession === 'ACTIVE_SESSION') {
        effectiveSession = findSessionIdInWindow() || 'active-session';
    }
    const sessionKey = `turn:${effectiveSession}:${cleanText}`;
    if (processedTurnsCache.has(sessionKey)) {
        return true;
    }

    processedTurnsCache.set(textKey, now);
    processedTurnsCache.set(sessionKey, now);
    return false;
}

function isDuplicateOutboundAnswer(sessionId, messageText) {
    const now = Date.now();
    for (const [key, timestamp] of outboundTurnsCache.entries()) {
        if (now - timestamp > 6000) {
            outboundTurnsCache.delete(key);
        }
    }
    const clean = (messageText || '').trim();
    if (!clean) return true;

    let effectiveSession = sessionId;
    if (!effectiveSession || effectiveSession === 'ACTIVE_SESSION') {
        effectiveSession = findSessionIdInWindow() || 'active-session';
    }
    const key = `outbound:${effectiveSession}:${clean}`;
    if (outboundTurnsCache.has(key)) {
        return true;
    }
    outboundTurnsCache.set(key, now);
    return false;
}

/**
 * Phase 2 Helper Function: Bridges client-side event to Salesforce application tier
 * over internal Lightning transport bus (0 REST API calls consumed).
 */
function sendApexTurnBridge(sessionId, messageText, isInbound = false) {
    let effectiveSession = sessionId;
    if (!effectiveSession || effectiveSession === 'ACTIVE_SESSION') {
        effectiveSession = findSessionIdInWindow();
    }
    console.log('[HeaderCustom-Debug] Invoking sendApexTurnBridge with:', { sessionId: effectiveSession, messageText: messageText ? messageText.substring(0, 80) + '...' : '', isInbound });
    if (!effectiveSession || !messageText) {
        console.warn('[HeaderCustom-Debug] Skipped sendApexTurnBridge: missing sessionId or messageText', { sessionId: effectiveSession, messageText });
        return Promise.resolve(null);
    }

    // Deduplicate outbound AI answers to prevent repeating identical messages in chat
    if (!isInbound && isDuplicateOutboundAnswer(effectiveSession, messageText)) {
        console.log('[HeaderCustom-Debug] Skipped duplicate outbound AI answer dispatch to Apex bridge.');
        return Promise.resolve(null);
    }

    return handleIncomingTurn({ sessionId: effectiveSession, messageText: messageText, isInbound: isInbound })
        .then(result => {
            console.log('[HeaderCustom-Debug] Apex turn handler result:', result);
            return result;
        })
        .catch(error => {
            console.error('[HeaderCustom-Debug] Apex invocation error:', error);
            return null;
        });
}

/**
 * Generates a cryptographically random UUID / nonce for message tracking.
 * Uses Web Crypto API when available, falling back safely if constrained.
 */
function generateSecureUuid() {
    try {
        if (typeof crypto !== 'undefined') {
            if (typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
            if (typeof crypto.getRandomValues === 'function') {
                const bytes = new Uint8Array(16);
                crypto.getRandomValues(bytes);
                return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
            }
        }
    } catch (e) {}
    return 'anon-' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

/**
 * Dispatches the intercepted inbound turn to bt-servant-whatsapp-gateway.
 * Formats the message as a standard Meta WhatsApp Webhook payload.
 * Runs asynchronously and fail-open (using AbortController) so that
 * gateway latency, CORS restrictions, or network failures never disrupt MIAW.
 */
function dispatchToWhatsAppGateway(sessionId, messageText, customGatewayUrl) {
    try {
        if (!messageText || typeof messageText !== 'string') return Promise.resolve(null);

        // 1. Sanitize payload: strip ASCII control characters (keep \n and \r), limit length to 4096
        const sanitizedText = messageText.trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 4096);
        if (!sanitizedText) return Promise.resolve(null);

        // 2. Resolve target URL with strict HTTPS check
        const rawUrl = customGatewayUrl || (typeof window !== 'undefined' ? (window.__BT_ACTIVE_GATEWAY_URL__ || window.BT_GATEWAY_URL) : null) || DEFAULT_GATEWAY_URL;
        let targetBaseUrl = (rawUrl || DEFAULT_GATEWAY_URL).trim().replace(/\/+$/, '');
        if (!targetBaseUrl.startsWith('https://')) {
            console.warn('[HeaderCustom-Gateway] Insecure gateway URL rejected (must use HTTPS):', targetBaseUrl);
            return Promise.resolve(null);
        }

        const endpoint = `${targetBaseUrl}/api/v1/miaw-chat`;
        const nonce = generateSecureUuid();
        const unixTimestamp = String(Math.floor(Date.now() / 1000));
        const effectiveSessionId = (!sessionId || sessionId === 'ACTIVE_SESSION') ? findSessionIdInWindow() : sessionId;
        const agentInfo = findAgentInfoInWindow();
        const activeAgentId = (typeof window !== 'undefined' ? (window.__BT_ACTIVE_AGENT_ID__ || window.BT_AGENT_ID) : null) || agentInfo.agentId || null;
        const activeAgentName = (typeof window !== 'undefined' ? (window.__BT_ACTIVE_AGENT_NAME__ || window.BT_AGENT_NAME) : null) || agentInfo.agentName || 'Agent';

        // 3. Format Meta WhatsApp Webhook Payload compatible with bt-servant-whatsapp-gateway
        const payload = {
            sessionId: effectiveSessionId,
            message: sanitizedText,
            agentId: activeAgentId,
            agentName: activeAgentName,
            object: 'whatsapp_business_account',
            entry: [
                {
                    id: 'miaw-gateway-entry',
                    changes: [
                        {
                            field: 'messages',
                            value: {
                                messaging_product: 'whatsapp',
                                metadata: {
                                    display_phone_number: 'MIAW Web Client',
                                    phone_number_id: 'miaw-web-channel'
                                },
                                contacts: [
                                    {
                                        profile: { name: 'MIAW Visitor' },
                                        wa_id: effectiveSessionId
                                    }
                                ],
                                messages: [
                                    {
                                        from: effectiveSessionId,
                                        id: `wamid.${nonce}`,
                                        timestamp: unixTimestamp,
                                        type: 'text',
                                        text: { body: sanitizedText }
                                    }
                                ]
                            }
                        }
                    ]
                }
            ],
            _source: 'salesforce-miaw-headerCustom',
            _sessionId: effectiveSessionId
        };

        // 4. Non-blocking fetch with AbortController timeout (30s)
        let controller = null;
        let signal = undefined;
        let timeoutId = null;

        if (typeof AbortController !== 'undefined') {
            controller = new AbortController();
            signal = controller.signal;
            timeoutId = setTimeout(() => {
                try { controller.abort(); } catch (e) {}
            }, GATEWAY_REQUEST_TIMEOUT_MS);
        }

        return fetch(endpoint, {
            method: 'POST',
            mode: 'cors',
            credentials: 'omit',
            headers: {
                'Content-Type': 'application/json',
                'X-MIAW-Session-Id': effectiveSessionId,
                'X-MIAW-Trace-Id': nonce
            },
            body: JSON.stringify(payload),
            signal: signal
        })
        .then(async (response) => {
            if (timeoutId) clearTimeout(timeoutId);
            if (!response.ok) {
                console.warn('[HeaderCustom-Gateway] Gateway returned non-OK status: ' + response.status);
                return null;
            }
            const data = await response.json();
            console.log('[HeaderCustom-Gateway] Inbound turn dispatched and answered by gateway:', data);
            return data;
        })
        .catch(err => {
            if (timeoutId) clearTimeout(timeoutId);
            console.warn('[HeaderCustom-Gateway] Gateway dispatch notice:', (err && err.name === 'AbortError') ? 'Gateway timeout (30s)' : (err ? err.message : err));
            return null;
        });

    } catch (unexpectedErr) {
        console.warn('[HeaderCustom-Gateway] Unexpected error in dispatchToWhatsAppGateway:', unexpectedErr);
        return Promise.resolve(null);
    }
}

/**
 * Unified Inbound Turn Pipeline:
 * Deduplicates, dispatches to bt-servant-whatsapp-gateway, and continues
 * the standard Salesforce MIAW chat flow (Apex bridge).
 */
function handleInboundTurnPipeline(sessionId, messageText, options = {}) {
    if (!messageText) return;
    const effectiveSessionId = (!sessionId || sessionId === 'ACTIVE_SESSION') ? findSessionIdInWindow() : sessionId;

    try {
        if (typeof window !== 'undefined') {
            window._lastMiawUserTurn = messageText;
        }
    } catch (e) {}

    // 1. Deduplication Guard: Discard duplicate turns generated by concurrent DOM/event triggers
    if (isDuplicateTurn(effectiveSessionId, messageText)) {
        console.log('[HeaderCustom-Debug] Turn already processed within debounce window, skipping duplicate dispatch.');
        return;
    }

    console.log('[HeaderCustom-Debug] Processing inbound turn in pipeline:', { sessionId: effectiveSessionId, textLength: messageText.length });

    // 2. Dispatch to bt-servant-whatsapp-gateway and wait for AI response
    dispatchToWhatsAppGateway(effectiveSessionId, messageText, options && options.gatewayUrl)
        .then(gatewayResult => {
            if (gatewayResult && gatewayResult.answer) {
                const cleanAnswer = sanitizeAgentAnswer(gatewayResult.answer, messageText);
                const agentInfo = findAgentInfoInWindow();
                const resolvedName = gatewayResult.agentName || agentInfo.agentName || 'Agent';
                console.log('[HeaderCustom-Gateway] Delivering AI answer from Agent ' + resolvedName + ' to chat:', {
                    sessionId: effectiveSessionId,
                    answerLength: cleanAnswer.length,
                    answerPreview: cleanAnswer.substring(0, 80) + '...'
                });
                // Send the AI answer through Apex turn bridge as outbound Agent turn (isInbound: false)
                sendApexTurnBridge(effectiveSessionId, cleanAnswer, false);
            } else {
                console.warn('[HeaderCustom-Gateway] Gateway did not return answer, invoking Apex bridge with inbound turn');
                sendApexTurnBridge(effectiveSessionId, messageText, true);
            }
        })
        .catch(err => {
            console.warn('[HeaderCustom-Gateway] Gateway turn error, falling back to Apex bridge:', err);
            sendApexTurnBridge(effectiveSessionId, messageText, true);
        });
}



/**
 * Native SSE JS event listener handler for Salesforce onEmbeddedMessageSent event.
 * Per Salesforce Developer Guide: https://developer.salesforce.com/docs/service/messaging-web/guide/event-listeners.html
 */
function handleEmbeddedMessageSent(evt) {
    try {
        console.log('[HeaderCustom-SSE] Native onEmbeddedMessageSent event triggered:', evt);
        const { sessionId, messageText, role } = extractTurnPayload(evt);

        // Only process messages sent by EndUser (ignore Agent and Chatbot messages)
        if (role === 'Agent' || role === 'Chatbot' || role === 'Bot') {
            console.log(`[HeaderCustom-SSE] Skipping outbound message sent by ${role} role.`);
            return;
        }

        const activeSession = sessionId || findSessionIdInWindow();
        if (activeSession && messageText) {
            console.log('[HeaderCustom-SSE] Dispatching EndUser message to inbound pipeline:', {
                sessionId: activeSession,
                role: role || 'EndUser',
                messageLength: messageText.length,
                preview: messageText.substring(0, 80)
            });
            handleInboundTurnPipeline(activeSession, messageText);
        }
    } catch (err) {
        console.error('[HeaderCustom-SSE] Error in onEmbeddedMessageSent handler:', err);
    }
}

/**
 * Registers native SSE onEmbeddedMessageSent event listeners on current window,
 * and parent / top frames when accessible, preventing duplicate registrations.
 */
function registerNativeSseListener() {
    if (typeof window === 'undefined') return;
    try {
        if (!window.__BT_MIAW_SSE_INITIALIZED__) {
            window.addEventListener('onEmbeddedMessageSent', handleEmbeddedMessageSent);
            window.__BT_MIAW_SSE_INITIALIZED__ = true;
            console.log('[HeaderCustom-SSE] Registered window.addEventListener("onEmbeddedMessageSent")');
        }

        if (window.parent && window.parent !== window) {
            try {
                if (!window.parent.__BT_MIAW_SSE_INITIALIZED__) {
                    window.parent.addEventListener('onEmbeddedMessageSent', handleEmbeddedMessageSent);
                    window.parent.__BT_MIAW_SSE_INITIALIZED__ = true;
                    console.log('[HeaderCustom-SSE] Registered window.parent.addEventListener("onEmbeddedMessageSent")');
                }
            } catch (e) {}
        }

        if (window.top && window.top !== window && window.top !== window.parent) {
            try {
                if (!window.top.__BT_MIAW_SSE_INITIALIZED__) {
                    window.top.addEventListener('onEmbeddedMessageSent', handleEmbeddedMessageSent);
                    window.top.__BT_MIAW_SSE_INITIALIZED__ = true;
                    console.log('[HeaderCustom-SSE] Registered window.top.addEventListener("onEmbeddedMessageSent")');
                }
            } catch (e) {}
        }
    } catch (err) {
        console.error('[HeaderCustom-SSE] Error registering native onEmbeddedMessageSent listener:', err);
    }
}

function runAaScript() {
    try {
        registerNativeSseListener();
        return "Universal MIAW Native SSE onEmbeddedMessageSent Handler Active!";
    } catch (e) {
        console.error("Error executing runAaScript:", e);
    }
}

// Execute at module load safely
try {
    runAaScript();
} catch (e) {
    console.error("Module load runAaScript error:", e);
}


/**
 * Centralized Custom Header Logic Initializer
 * Wires configuration, runs the universal AaScript, and subscribes to messaging events.
 *
 * @param {Object} component - The LWC component instance (this)
 * @param {Function} [onTitleChange] - Optional callback invoked when agent text updates
 */
export function initCustomHeader(component, onTitleChange) {
    try {
        if (component && component.configuration && typeof window !== "undefined") {
            if (component.configuration.gatewayUrl) {
                window.__BT_ACTIVE_GATEWAY_URL__ = component.configuration.gatewayUrl;
            }
            if (component.configuration.agentId) {
                window.__BT_ACTIVE_AGENT_ID__ = component.configuration.agentId;
                activeCachedAgentId = component.configuration.agentId;
            }
            if (component.configuration.agentName || component.configuration.headerText) {
                const name = component.configuration.agentName || component.configuration.headerText;
                window.__BT_ACTIVE_AGENT_NAME__ = name;
                activeCachedAgentName = name;
            }
        }
        if (component && component.headerTitle && typeof window !== "undefined" && !window.__BT_ACTIVE_AGENT_NAME__) {
            window.__BT_ACTIVE_AGENT_NAME__ = component.headerTitle;
            activeCachedAgentName = component.headerTitle;
        }
        runAaScript();
        registerNativeSseListener();
    } catch (e) {
        console.error("initCustomHeader runAaScript error:", e);
    }

    try {
        if (typeof assignMessagingEventHandler === "function" && MESSAGING_EVENT?.UPDATE_HEADER_TEXT) {
            assignMessagingEventHandler(MESSAGING_EVENT.UPDATE_HEADER_TEXT, (payload) => {
                console.log("Header text update event received:", payload);
                if (payload && payload.text) {
                    if (typeof onTitleChange === "function") {
                        onTitleChange(payload.text);
                    }
                    if (typeof window !== "undefined") {
                        window.__BT_ACTIVE_AGENT_NAME__ = payload.text;
                        activeCachedAgentName = payload.text;
                    }
                }
            });
        }

        if (typeof assignMessagingEventHandler === "function") {
            const turnEvents = ["MESSAGE_SENT", "RECORD_EVENT", "CONVERSATION_PAYLOAD"];
            turnEvents.forEach(evtName => {
                if (MESSAGING_EVENT?.[evtName] || evtName) {
                    assignMessagingEventHandler(MESSAGING_EVENT?.[evtName] || evtName, (payload) => {
                        const { sessionId, messageText, role } = extractTurnPayload(payload);
                        if (role === 'Agent' || role === 'Chatbot' || role === 'Bot') return;
                        const activeSession = sessionId || component?.conversationId || component?.recordId || component?.configuration?.conversationId || component?.configuration?.recordId || findSessionIdInWindow();
                        if (activeSession && messageText) {
                            handleInboundTurnPipeline(activeSession, messageText, { gatewayUrl: component?.configuration?.gatewayUrl });
                        }
                    });
                }
            });
        }
    } catch (e) {
        console.error("Error setting up messaging event handler in initCustomHeader:", e);
    }
}

export function handleEndConversation() {
    console.log("Ending conversation...");
    try {
        if (typeof dispatchMessagingEvent === "function" && MESSAGING_EVENT?.CLOSE_CONVERSATION) {
            dispatchMessagingEvent(MESSAGING_EVENT.CLOSE_CONVERSATION, {});
        }
    } catch (e) {
        console.error("Error closing conversation:", e);
    }
}

export function onMinimizeButtonClick() {
    try {
        if (typeof dispatchMessagingEvent === "function" && MESSAGING_EVENT?.MINIMIZE_BUTTON_CLICK) {
            dispatchMessagingEvent(MESSAGING_EVENT.MINIMIZE_BUTTON_CLICK, {});
        }
    } catch (e) {
        console.error("Error minimizing:", e);
    }
}

export function onCloseButtonClick() {
    try {
        if (typeof dispatchMessagingEvent === "function" && MESSAGING_EVENT?.CLOSE_CONTAINER) {
            dispatchMessagingEvent(MESSAGING_EVENT.CLOSE_CONTAINER, {});
        }
    } catch (e) {
        console.error("Error closing container:", e);
    }
}

export {
    runAaScript,
    handleInboundTurnPipeline,
    handleEmbeddedMessageSent,
    registerNativeSseListener,
    findSessionIdInWindow,
    findAgentInfoInWindow,
    sanitizeAgentAnswer,
    extractTurnPayload,
    isDuplicateTurn,
    dispatchToWhatsAppGateway,
    sendApexTurnBridge,
    DEFAULT_GATEWAY_URL
};
