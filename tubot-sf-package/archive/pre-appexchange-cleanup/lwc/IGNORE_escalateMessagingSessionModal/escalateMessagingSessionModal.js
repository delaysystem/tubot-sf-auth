import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { CloseActionScreenEvent } from 'lightning/actions';
import escalateSessionRecord from '@salesforce/apex/PanelAuthController.escalateSessionRecord';
import getTubotSettings from '@salesforce/apex/PanelAuthController.getTubotSettings';

export default class EscalateMessagingSessionModal extends LightningElement {
    @api recordId;
    @track reason = '';
    @track summary = '';
    @track varTargetQueueName = '';
    @track varRouting = '';
    @track varSkillLevel = '';
    @track varTargetSkillName = '';
    @track varFlowHuman = '';
    @track fallbackQueue = 'Chat_Queue';
    @track isSaving = false;

    async connectedCallback() {
        try {
            const res = await getTubotSettings();
            if (res && res.fallbackQueueApiName && res.fallbackQueueApiName !== 'AI_Bot_Holding_Queue_100') {
                this.fallbackQueue = res.fallbackQueueApiName;
            } else {
                this.fallbackQueue = 'Chat_Queue';
            }
        } catch (err) {
            console.debug('Tubot settings load note:', err);
        }
    }

    get fallbackQueueDisplay() {
        return this.fallbackQueue || 'Chat_Queue';
    }

    get queuePlaceholder() {
        return `Leave blank to use: ${this.fallbackQueueDisplay}`;
    }

    handleReasonChange(event) {
        this.reason = event.target.value;
    }

    handleSummaryChange(event) {
        this.summary = event.target.value;
    }

    handleTargetQueueChange(event) {
        this.varTargetQueueName = event.target.value;
    }

    handleRoutingChange(event) {
        this.varRouting = event.target.value;
    }

    handleSkillLevelChange(event) {
        this.varSkillLevel = event.target.value;
    }

    handleTargetSkillChange(event) {
        this.varTargetSkillName = event.target.value;
    }

    handleFlowHumanChange(event) {
        this.varFlowHuman = event.target.value;
    }

    handleClose() {
        this.dispatchEvent(new CloseActionScreenEvent());
    }

    async handleEscalate() {
        this.isSaving = true;
        try {
            const result = await escalateSessionRecord({ requestJson: JSON.stringify({
                sessionId: this.recordId,
                reason: this.reason ? this.reason.trim() : null,
                summary: this.summary ? this.summary.trim() : null,
                varTargetQueueName: this.varTargetQueueName ? this.varTargetQueueName.trim() : null,
                varRouting: this.varRouting ? this.varRouting.trim() : null,
                varSkillLevel: this.varSkillLevel !== '' && this.varSkillLevel !== null && this.varSkillLevel !== undefined ? parseFloat(this.varSkillLevel) : null,
                varTargetSkillName: this.varTargetSkillName ? this.varTargetSkillName.trim() : null,
                varFlowHuman: this.varFlowHuman ? this.varFlowHuman.trim() : null
            }) });

            if (result && result.success) {
                this.dispatchEvent(new ShowToastEvent({
                    title: 'Escalation Triggered',
                    message: result.message || 'Messaging Session escalated to human successfully.',
                    variant: 'success'
                }));
                this.handleClose();
            } else {
                throw new Error((result && result.error) || 'Failed to escalate session.');
            }
        } catch (error) {
            this.dispatchEvent(new ShowToastEvent({
                title: 'Escalation Error',
                message: error.body ? error.body.message : error.message,
                variant: 'error'
            }));
        } finally {
            this.isSaving = false;
        }
    }
}
