import { LightningElement, api } from "lwc";

const MESSAGE_CONTENT_CLASS = "embedded-messaging-message-content";
const PARTICIPANT_TYPES = ["EndUser", "Agent", "Chatbot"];

export default class NewBubble extends LightningElement {
    @api configuration;
    @api conversationEntry;

    get sender() {
        return this.conversationEntry?.sender?.role;
    }

    get textContent() {
        try {
            const entryPayload = JSON.parse(this.conversationEntry.entryPayload);
            return entryPayload.abstractMessage?.staticContent?.text || "";
        } catch (e) {
            return "";
        }
    }

    get generateMessageBubbleClassname() {
        if (PARTICIPANT_TYPES.includes(this.sender)) {
            return `${MESSAGE_CONTENT_CLASS} ${this.sender}`;
        }
        return MESSAGE_CONTENT_CLASS;
    }
}
