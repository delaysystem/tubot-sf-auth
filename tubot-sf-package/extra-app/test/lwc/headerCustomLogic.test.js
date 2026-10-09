jest.mock('lightningsnapin/eventStore', () => ({
    MESSAGING_EVENT: {
        UPDATE_HEADER_TEXT: 'UPDATE_HEADER_TEXT',
        MESSAGE_SENT: 'MESSAGE_SENT',
        RECORD_EVENT: 'RECORD_EVENT',
        CONVERSATION_PAYLOAD: 'CONVERSATION_PAYLOAD',
        CLOSE_CONVERSATION: 'CLOSE_CONVERSATION',
        MINIMIZE_BUTTON_CLICK: 'MINIMIZE_BUTTON_CLICK',
        CLOSE_CONTAINER: 'CLOSE_CONTAINER'
    },
    assignMessagingEventHandler: jest.fn(),
    dispatchMessagingEvent: jest.fn()
}), { virtual: true });

import { assignMessagingEventHandler } from 'lightningsnapin/eventStore';
import {
    handleLocalInboundTurn,
    initCustomHeader,
    localBubbleForMessage
} from '../../main/default/lwc/headerCustomLogic/headerCustomLogic';

describe('headerCustomLogic local inbound handling', () => {
    let handlers;

    beforeEach(() => {
        handlers = {};
        assignMessagingEventHandler.mockReset();
        assignMessagingEventHandler.mockImplementation((eventName, callback) => {
            handlers[eventName] = callback;
        });
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    it('copies an inbound message containing echo199 into a local bubble', () => {
        const onBubble = jest.fn();
        const result = handleLocalInboundTurn({
            conversationEntry: {
                messageIdentifier: 'echo-199-test',
                sender: { role: 'EndUser' },
                entryPayload: JSON.stringify({
                    abstractMessage: { staticContent: { text: 'Please echo199 this exact message.' } }
                })
            }
        }, onBubble);

        expect(result.handled).toBe(true);
        expect(onBubble).toHaveBeenCalledWith('Please echo199 this exact message.', expect.any(Object));
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('shows a not implemented bubble for other inbound text', () => {
        const onBubble = jest.fn();
        const result = handleLocalInboundTurn({
            conversationEntry: {
                messageIdentifier: 'no-marker-test',
                sender: { role: 'EndUser' },
                entryPayload: JSON.stringify({ abstractMessage: { staticContent: { text: 'Hello there' } } })
            }
        }, onBubble);

        expect(result.handled).toBe(true);
        expect(onBubble).toHaveBeenCalledWith('not implemented', expect.any(Object));
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('ignores an agent message instead of treating it as inbound', () => {
        const onBubble = jest.fn();
        const result = handleLocalInboundTurn({
            conversationEntry: {
                messageIdentifier: 'agent-message-test',
                sender: { role: 'Agent' },
                entryPayload: JSON.stringify({ abstractMessage: { staticContent: { text: 'Agent reply' } } })
            }
        }, onBubble);

        expect(result.handled).toBe(false);
        expect(onBubble).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('registers Salesforce conversation events and renders the local result', () => {
        const onBubble = jest.fn();
        initCustomHeader({}, jest.fn(), onBubble);

        expect(typeof handlers.MESSAGE_SENT).toBe('function');
        handlers.MESSAGE_SENT({
            conversationEntry: {
                messageIdentifier: 'event-handler-test',
                sender: { role: 'EndUser' },
                entryPayload: JSON.stringify({ abstractMessage: { staticContent: { text: 'echo199 from event' } } })
            }
        });

        expect(onBubble).toHaveBeenCalledWith('echo199 from event', expect.any(Object));
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('uses the marker check without changing the copied text', () => {
        expect(localBubbleForMessage('Echo199 CASE is preserved')).toBe('Echo199 CASE is preserved');
        expect(localBubbleForMessage('ordinary message')).toBe('not implemented');
    });
});
