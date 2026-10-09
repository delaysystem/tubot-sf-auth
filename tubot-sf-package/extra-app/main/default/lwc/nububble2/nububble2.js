import { LightningElement, api } from "lwc";

const MESSAGE_CONTENT_CLASS = "embedded-messaging-message-content";
const PARTICIPANT_TYPES = ["EndUser", "Agent", "Chatbot"];

export default class Nububble2 extends LightningElement {
    @api configuration;
    @api conversationEntry;
    @api message;

    get sender() {
        if (this.conversationEntry?.sender?.role) {
            return this.conversationEntry.sender.role;
        }
        if (this.message?.sender?.role) {
            return this.message.sender.role;
        }
        if (this.message?.role) {
            return this.message.role;
        }
        return "";
    }

    get textContent() {
        // 1. Try parsing entryPayload from conversationEntry or message
        try {
            const rawPayload = this.conversationEntry?.entryPayload || this.message?.entryPayload;
            if (rawPayload) {
                const payloadObj = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
                const text = payloadObj?.abstractMessage?.staticContent?.text || payloadObj?.staticContent?.text;
                if (text) return text;
            }
        } catch (e) {
            return "";
        }

        // 2. Try direct message or conversationEntry properties
        const msg = this.message || this.conversationEntry;
        if (!msg) return "";
        if (typeof msg === "string") return msg;
        if (typeof msg.value === "string") return msg.value;
        if (typeof msg.content === "string") return msg.content;
        if (typeof msg.text === "string") return msg.text;

        if (msg.value && typeof msg.value === "object") {
            if (typeof msg.value.text === "string") return msg.value.text;
            if (typeof msg.value.payload === "string") return msg.value.payload;
            if (typeof msg.value.content === "string") return msg.value.content;
        }
        if (msg.content && typeof msg.content === "object") {
            if (typeof msg.content.text === "string") return msg.content.text;
            if (typeof msg.content.value === "string") return msg.content.value;
        }

        return "";
    }

    get generateMessageBubbleClassname() {
        if (PARTICIPANT_TYPES.includes(this.sender)) {
            return `${MESSAGE_CONTENT_CLASS} ${this.sender}`;
        }
        return MESSAGE_CONTENT_CLASS;
    }
}
