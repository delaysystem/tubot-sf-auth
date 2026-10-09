import { LightningElement, api, track } from 'lwc';
import {
    initCustomHeader,
    handleEndConversation,
    onMinimizeButtonClick,
    onCloseButtonClick
} from 'c/headerCustomLogic';

export default class HeaderCustom extends LightningElement {
    @api configuration = {};
    @api conversationStatus;
    @api conversationId;
    @api recordId;

    @track dynamicTitle = '';
    @track isMenuOpen = false;
    @track localBubbleText = '';
    @track hasLocalBubble = false;

    connectedCallback() {
        initCustomHeader(this, (newTitle) => {
            this.dynamicTitle = newTitle;
        }, (bubbleText) => {
            this.localBubbleText = bubbleText;
            this.hasLocalBubble = true;
        });
    }

    get headerTitle() {
        return this.dynamicTitle || this.configuration?.headerText || this.configuration?.messagingChannelName || 'Chat Support';
    }

    toggleMenu() {
        this.isMenuOpen = !this.isMenuOpen;
    }

    handleEndConversation() {
        this.isMenuOpen = false;
        handleEndConversation();
    }

    onMinimizeButtonClick() {
        onMinimizeButtonClick();
    }

    onCloseButtonClick() {
        onCloseButtonClick();
    }
}
