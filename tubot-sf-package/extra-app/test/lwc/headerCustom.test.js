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

import { createElement } from 'lwc';
import { assignMessagingEventHandler } from 'lightningsnapin/eventStore';
import HeaderCustom from 'c/headerCustom';

describe('c-header-custom local inbound bubble', () => {
    let handlers;

    beforeEach(() => {
        handlers = {};
        assignMessagingEventHandler.mockReset();
        assignMessagingEventHandler.mockImplementation((eventName, callback) => {
            handlers[eventName] = callback;
        });
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('renders the local copy bubble after an inbound event', async () => {
        const element = createElement('c-header-custom', { is: HeaderCustom });
        document.body.appendChild(element);

        handlers.CONVERSATION_PAYLOAD({
            conversationEntry: {
                messageIdentifier: 'header-render-test',
                sender: { role: 'EndUser' },
                entryPayload: JSON.stringify({
                    abstractMessage: { staticContent: { text: 'copy this echo199 message' } }
                })
            }
        });
        await Promise.resolve();

        expect(element.shadowRoot.querySelector('.local-echo-bubble p').textContent)
            .toBe('copy this echo199 message');
    });
});
