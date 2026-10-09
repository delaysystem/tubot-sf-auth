import { assignMessagingEventHandler, dispatchMessagingEvent, MESSAGING_EVENT } from 'lightningsnapin/eventStore';

const INBOUND_ROLES = new Set(['enduser', 'customer', 'visitor', 'user']);
const seenMessages = new Set();

function parseEntryPayload(value) {
    if (typeof value !== 'string') {
        return value && typeof value === 'object' ? value : null;
    }
    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return '';
}

export function extractTurnPayload(eventOrPayload) {
    const payload = eventOrPayload?.detail || eventOrPayload || {};
    const entry = payload.conversationEntry || payload;
    const decodedPayload = parseEntryPayload(entry.entryPayload || payload.entryPayload);
    const content = decodedPayload?.abstractMessage?.staticContent?.text
        || decodedPayload?.abstractMessage?.text
        || decodedPayload?.staticContent?.text
        || decodedPayload?.text
        || decodedPayload?.message
        || decodedPayload?.content
        || decodedPayload?.body;
    const directContent = entry.text || entry.message || entry.messageText
        || payload.text || payload.message || payload.messageText || payload.content || payload.body;

    return {
        sessionId: firstString(
            payload.conversationId,
            entry.conversationId,
            payload.sessionId,
            entry.sessionId,
            payload.recordId,
            payload.conversationSessionId
        ),
        messageText: firstString(content, directContent),
        role: firstString(
            entry.sender?.role,
            payload.sender?.role,
            entry.role,
            payload.role,
            entry.actorType,
            payload.actorType
        ),
        messageIdentifier: firstString(entry.messageIdentifier, payload.messageIdentifier, entry.id, payload.id)
    };
}

export function isInboundTurn(role) {
    return INBOUND_ROLES.has(String(role || '').trim().toLowerCase());
}

export function localBubbleForMessage(messageText) {
    const exactMessage = String(messageText || '');
    return exactMessage.toLowerCase().includes('echo199') ? exactMessage : 'not implemented';
}

/** Handles only inbound events, and renders a local bubble without any Apex or network request. */
export function handleLocalInboundTurn(eventOrPayload, onBubble) {
    const turn = extractTurnPayload(eventOrPayload);
    if (!isInboundTurn(turn.role) || !turn.messageText.trim() || typeof onBubble !== 'function') {
        return { handled: false, reason: 'not-inbound-or-empty' };
    }

    const dedupeKey = turn.messageIdentifier || `${turn.sessionId}:${turn.role}:${turn.messageText}`;
    if (seenMessages.has(dedupeKey)) {
        return { handled: false, reason: 'duplicate' };
    }
    seenMessages.add(dedupeKey);
    if (seenMessages.size > 200) {
        const oldestKey = seenMessages.values().next().value;
        seenMessages.delete(oldestKey);
    }

    const bubbleText = localBubbleForMessage(turn.messageText);
    onBubble(bubbleText, turn);
    return { handled: true, bubbleText, turn };
}

export function initCustomHeader(component, onTitleChange, onLocalBubble) {
    try {
        if (typeof assignMessagingEventHandler !== 'function') {
            return;
        }

        if (MESSAGING_EVENT?.UPDATE_HEADER_TEXT) {
            assignMessagingEventHandler(MESSAGING_EVENT.UPDATE_HEADER_TEXT, (payload) => {
                const title = firstString(payload?.detail?.text, payload?.text);
                if (title && typeof onTitleChange === 'function') {
                    onTitleChange(title);
                }
            });
        }

        ['MESSAGE_SENT', 'RECORD_EVENT', 'CONVERSATION_PAYLOAD'].forEach((eventName) => {
            const eventType = MESSAGING_EVENT?.[eventName] || eventName;
            assignMessagingEventHandler(eventType, (payload) => {
                handleLocalInboundTurn(payload, onLocalBubble);
            });
        });
    } catch (error) {
        // The header should remain usable when an optional messaging event is unavailable.
        console.warn('Unable to register TuBot Extra messaging handlers.', error);
    }
}

export function handleEndConversation() {
    if (MESSAGING_EVENT?.CLOSE_CONVERSATION) {
        dispatchMessagingEvent(MESSAGING_EVENT.CLOSE_CONVERSATION, {});
    }
}

export function onMinimizeButtonClick() {
    if (MESSAGING_EVENT?.MINIMIZE_BUTTON_CLICK) {
        dispatchMessagingEvent(MESSAGING_EVENT.MINIMIZE_BUTTON_CLICK, {});
    }
}

export function onCloseButtonClick() {
    if (MESSAGING_EVENT?.CLOSE_CONTAINER) {
        dispatchMessagingEvent(MESSAGING_EVENT.CLOSE_CONTAINER, {});
    }
}
