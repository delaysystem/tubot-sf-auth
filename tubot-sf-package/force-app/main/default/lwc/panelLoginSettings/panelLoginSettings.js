import { LightningElement, track } from 'lwc';
import getPanelAuthStatus from '@salesforce/apex/PanelAuthController.getPanelAuthStatus';
import setPanelEnvironmentApex from '@salesforce/apex/PanelAuthController.setPanelEnvironment';
import exchangeOAuthCode from '@salesforce/apex/PanelAuthController.exchangeOAuthCode';
import pollOAuthCode from '@salesforce/apex/PanelAuthController.pollOAuthCode';
import logoutPanelApex from '@salesforce/apex/PanelAuthController.logoutPanel';
import getMessagingChannelsApex from '@salesforce/apex/MessagingConfigurationController.getMessagingChannels';
import getMessagingBackupsApex from '@salesforce/apex/MessagingBackupController.getMessagingBackups';
import createManualBackupApex from '@salesforce/apex/MessagingBackupController.createManualBackup';
import restoreMessagingBackupApex from '@salesforce/apex/MessagingBackupController.restoreMessagingBackup';
import getMessagingBackupDetailsApex from '@salesforce/apex/MessagingBackupController.getMessagingBackupDetails';
import deleteMessagingBackupApex from '@salesforce/apex/MessagingBackupController.deleteMessagingBackup';
import getSelfOrgConnectionStatusApex from '@salesforce/apex/TuBotSelfOrgConnectionController.getConnectionStatus';
import getSelfOrgAuthorizationUrlApex from '@salesforce/apex/TuBotSelfOrgConnectionController.getAuthorizationUrl';
import disconnectSelfOrgApiApex from '@salesforce/apex/TuBotSelfOrgConnectionController.disconnect';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LightningConfirm from 'lightning/confirm';
import getIntegrationCandidatesApex from '@salesforce/apex/TubotSetupWizardController.getIntegrationCandidates';
import runSimpleSetupStepApex from '@salesforce/apex/SimpleSetupController.runStep';
import initiateEcaAuthorizationApex from '@salesforce/apex/SimpleSetupController.initiateEcaAuthorization';
import pollEcaAuthorizationApex from '@salesforce/apex/SimpleSetupController.pollEcaAuthorization';
import checkEcaAuthorizationApex from '@salesforce/apex/SimpleSetupController.checkEcaAuthorization';
import hasPanelSettingsAccess from '@salesforce/apex/PanelAuthController.hasPanelSettingsAccess';

import ensurePanelSession from '@salesforce/apex/PanelAuthController.ensurePanelSession';

async function withPanelSession(action, args) {
    await ensurePanelSession({ forceRefresh: false });
    try {
        return await action(args);
    } catch (error) {
        const message = error?.body?.message || error?.message || '';
        if (message !== 'PANEL_REFRESH_REQUIRED: Refresh the Panel session in a separate transaction.') throw error;
        await ensurePanelSession({ forceRefresh: true });
        return action(args);
    }
}

const logoutPanel = logoutPanelApex;
const getMessagingChannels = (args) => withPanelSession(getMessagingChannelsApex, args);
const getMessagingBackups = (args) => withPanelSession(getMessagingBackupsApex, args);
const createManualBackup = (args) => withPanelSession(createManualBackupApex, args);
const restoreMessagingBackup = (args) => withPanelSession(restoreMessagingBackupApex, args);
const getMessagingBackupDetails = (args) => withPanelSession(getMessagingBackupDetailsApex, args);
const deleteMessagingBackup = (args) => withPanelSession(deleteMessagingBackupApex, args);
const getSelfOrgConnectionStatus = (args) => withPanelSession(getSelfOrgConnectionStatusApex, args);
const getSelfOrgAuthorizationUrl = (args) => withPanelSession(getSelfOrgAuthorizationUrlApex, args);
const disconnectSelfOrgApi = (args) => withPanelSession(disconnectSelfOrgApiApex, args);
const getIntegrationCandidates = (args) => withPanelSession(getIntegrationCandidatesApex, args);
const runSimpleSetupStep = (args) => withPanelSession(runSimpleSetupStepApex, args);
const initiateEcaAuthorization = (args) => withPanelSession(initiateEcaAuthorizationApex, args);
const pollEcaAuthorization = (args) => withPanelSession(pollEcaAuthorizationApex, args);
const checkEcaAuthorization = (args) => withPanelSession(checkEcaAuthorizationApex, args);

export default class PanelLoginSettings extends LightningElement {
    @track activeTab = 'settings';
    @track panelBaseUrl = '';
    @track clientId = '';
    @track panelEnvironment = 'production';
    @track panelEnvironmentLabel = 'Production';
    @track showPanelEnvironmentToggle = false;
    @track isChangingPanelEnvironment = false;
    @track isConnected = false;
    @track userEmail = '';
    @track userRole = '';
    @track teamName = '';
    @track canEditSettings = false;
    @track usesExternalCredentials = false;
    @track namedCredentialName = 'Panel_Named_Credential';
    @track isLoading = false;
    @track hasSettingsAccess = false;
    @track settingsAccessChecked = false;

    // Integration-user selection for Simple Setup.
    @track integrationCandidates = [];
    @track integrationUserOptions = [];
    @track selectedIntegrationUserId = '';

    // Simple Setup (one-click automatic) state
    @track simpleSetupConsented = false;
    @track simpleSetupRunning = false;
    @track simpleSetupDone = false;
    @track simpleSetupSteps = [];
    @track simpleSetupError = '';
    @track simpleSetupEcaGuidance = null;
    @track simpleSetupEcaManual = false;
    @track simpleSetupEcaBusy = false;
    _setupPollEpoch = 0;

    // Headless log sink: backup/restore flows append here via addSetupLog
    @track setupLogs = [];

    // Messaging Channel selection and Salesforce API connection state
    @track messagingChannels = [];
    @track messagingChannelOptions = [];
    @track selectedChannelId = '';
    @track selfOrgConnectionConfigured = false;
    @track selfOrgConnectionConnected = false;
    @track selfOrgConnectionMessage = '';
    @track selfOrgConnectionError = '';
    @track isSelfOrgConnectionBusy = false;

    // Backup & Restore State
    @track backupsList = [];
    @track isBackupsLoading = false;
    @track isBackingUpNow = false;
    @track isRestoring = false;
    @track isRestoreModalOpen = false;
    @track selectedBackupForRestore = null;
    @track isDetailsModalOpen = false;
    @track selectedBackupDetails = null;
    @track isDetailsLoading = false;
    @track rawBackupJson = '';
    @track isManualBackupModalOpen = false;
    @track manualBackupName = '';
    @track manualBackupNotes = '';

    @track isAuthorizingOAuth = false;
    @track isPanelCredentialRepairNeeded = false;
    activeOAuthState = '';
    authWindow = null;
    _messageListener = null;
    _pollInterval = null;
    _pollInFlight = false;
    _pollFailures = 0;
    _setupWaitInterval = null;
    _environmentRevealClicks = 0;
    _environmentRevealStartedAt = 0;

    codeVerifier = '';

    connectedCallback() {
        this.verifySettingsAccess();
    }

    async verifySettingsAccess() {
        try {
            this.hasSettingsAccess = (await hasPanelSettingsAccess()) === true;
        } catch (ignoredError) {
            // A missing Apex class grant or failed authorization check denies access.
            this.hasSettingsAccess = false;
        }
        this.settingsAccessChecked = true;
        if (!this.hasSettingsAccess) return;

        try {
            this.isPanelCredentialRepairNeeded = localStorage.getItem('tubot_panel_credential_repair_needed') === 'true';
        } catch (ignoredError) {
            this.isPanelCredentialRepairNeeded = false;
        }
        this.checkIncomingOAuthCode();
        this.checkSelfOrgOAuthResult();
        this.loadData();
        this.loadMessagingChannels();
        this.loadSelfOrgConnection();
        this.loadBackups();
        this.loadIntegrationCandidates();
        this.setupMessageListener();
    }

    disconnectedCallback() {
        this.stopOAuthPolling();
        this.stopSimpleSetupWait();
        if (this._messageListener) {
            window.removeEventListener('message', this._messageListener);
            this._messageListener = null;
        }
    }

    checkIncomingOAuthCode() {
        try {
            if (typeof window !== 'undefined' && window.location && window.location.search) {
                const urlParams = new URLSearchParams(window.location.search);
                const code = urlParams.get('code');
                const state = urlParams.get('state');
                const savedState = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('panel_oauth_state') : null;
                if (code && state && savedState && state === savedState) {
                    const savedVerifier = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem('panel_oauth_code_verifier') : null;
                    if (savedVerifier) {
                        this.codeVerifier = savedVerifier;
                    }
                    if (window.history && window.history.replaceState) {
                        const cleanUrl = window.location.origin + window.location.pathname;
                        window.history.replaceState({}, document.title, cleanUrl);
                    }
                    this.exchangeCode(code);
                }
            }
        } catch (e) {
            console.error('Error checking incoming OAuth code in URL:', e);
        }
    }

    setupMessageListener() {
        this._messageListener = async (event) => {
            let data = event.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (ignoredError) { data = null; }
            }
            let expectedOrigin = '';
            try {
                expectedOrigin = new URL(this.panelBaseUrl).origin;
            } catch (ignoredError) {
                expectedOrigin = '';
            }
            if (event.origin === expectedOrigin &&
                data && data.type === 'PANEL_OAUTH_SUCCESS' && data.code &&
                data.state === this.activeOAuthState && this.isAuthorizingOAuth) {
                this.isAuthorizingOAuth = false;
                this.stopOAuthPolling();
                this.closeAuthWindow();
                this.showToast('OAuth Approved', 'Received authorization code. Connecting...', 'info');
                await this.exchangeCode(data.code);
            }
        };
        window.addEventListener('message', this._messageListener);
    }

    applyAuthStatus(status) {
        if (!status) return;
        this.isConnected = Boolean(status.isConnected);
        if (this.isConnected) {
            this.setPanelCredentialRepairNeeded(false);
        }
        if (status.panelBaseUrl) this.panelBaseUrl = status.panelBaseUrl;
        if (status.clientId) this.clientId = status.clientId;
        this.panelEnvironment = status.panelEnvironment || 'production';
        this.panelEnvironmentLabel = status.panelEnvironmentLabel || 'Production';
        this.userEmail = status.userEmail || '';
        this.userRole = status.userRole || '';
        this.teamName = status.teamName || '';
        this.canEditSettings = Boolean(status.canEditSettings);
        this.usesExternalCredentials = status.usesExternalCredentials === true;
        this.namedCredentialName = status.namedCredentialName || 'Panel_Named_Credential';
    }

    async loadData() {
        this.isLoading = true;
        try {
            const status = await getPanelAuthStatus();
            this.applyAuthStatus(status);
        } catch (err) {
            this.showToast('Initialization Error', err.body?.message || err.message, 'error');
        } finally {
            this.isLoading = false;
        }
    }

    handleDismissPanelCredentialRepair() {
        this.setPanelCredentialRepairNeeded(false);
    }

    handleRefresh() {
        this.setPanelCredentialRepairNeeded(false);
        this.loadData();
        this.loadSelfOrgConnection();
    }

    get isStagingPanelEnvironment() {
        return this.panelEnvironment === 'staging';
    }

    get isPanelEnvironmentToggleDisabled() {
        return this.isChangingPanelEnvironment || this.isLoading || this.isAuthorizingOAuth ||
            this.simpleSetupRunning || this.simpleSetupEcaBusy;
    }

    handleRevealPanelEnvironmentToggle() {
        const now = Date.now();
        if (!this._environmentRevealStartedAt || now - this._environmentRevealStartedAt > 2500) {
            this._environmentRevealStartedAt = now;
            this._environmentRevealClicks = 0;
        }
        this._environmentRevealClicks += 1;
        if (this._environmentRevealClicks >= 6) {
            this.showPanelEnvironmentToggle = true;
            this._environmentRevealClicks = 0;
            this._environmentRevealStartedAt = 0;
        }
    }

    async handlePanelEnvironmentToggle(event) {
        const targetEnvironment = event.target.checked ? 'staging' : 'production';
        if (targetEnvironment === this.panelEnvironment) return;

        const confirmed = await LightningConfirm.open({
            label: 'Switch Panel and auth environment',
            message: `Switch this Salesforce org from ${this.panelEnvironmentLabel} to ${targetEnvironment === 'staging' ? 'Staging' : 'Production'}? The current Panel session will be revoked and must be connected again.`,
            theme: 'warning'
        });
        if (!confirmed) {
            event.target.checked = this.isStagingPanelEnvironment;
            return;
        }

        this.isChangingPanelEnvironment = true;
        this.isLoading = true;
        try {
            const status = await setPanelEnvironmentApex({ environmentName: targetEnvironment });
            this.applyAuthStatus(status);
            this.clearPanelOAuthSessionState();
            this.activeOAuthState = '';
            try {
                sessionStorage.removeItem('panel_oauth_state');
                sessionStorage.removeItem('panel_oauth_code_verifier');
            } catch (ignoredError) {
                // Environment selection is persisted by Salesforce.
            }
                        this.showToast(
                'Panel environment changed',
                `This org now targets ${this.panelEnvironmentLabel} Panel and auth. Connect with Panel to start a new session.`,
                'success'
            );
        } catch (error) {
            event.target.checked = this.isStagingPanelEnvironment;
            this.showToast('Environment change failed', error.body?.message || error.message || 'Could not change the Panel environment.', 'error');
        } finally {
            this.isChangingPanelEnvironment = false;
            this.isLoading = false;
        }
    }

    checkSelfOrgOAuthResult() {
        if (typeof window === 'undefined' || !window.location?.search) return;
        const url = new URL(window.location.href);
        const result = url.searchParams.get('selfOrgOAuth');
        if (!result) return;
        const code = url.searchParams.get('selfOrgOAuthError');
        url.searchParams.delete('selfOrgOAuth');
        url.searchParams.delete('selfOrgOAuthError');
        window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
        if (result === 'connected') {
            this.showToast('Salesforce API connected', 'The Salesforce org connection is ready for package API actions.', 'success');
        } else {
            const message = code === 'authorization_denied'
                ? 'Salesforce authorization was cancelled. Try again when ready.'
                : 'Salesforce could not complete authorization. Check the External Client App setup and retry.';
            this.showToast('Salesforce API connection failed', message, 'error');
        }
    }

    closeAuthWindow() {
        this.stopOAuthPolling();
        const authWindow = this.authWindow;
        this.authWindow = null;
        if (!authWindow) return;
        try {
            authWindow.close();
        } catch (ignoredError) {
            return;
        }
    }

    clearPanelOAuthSessionState() {
        this.codeVerifier = '';
        this.activeOAuthState = '';
        this.stopOAuthPolling();
        try {
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.removeItem('panel_oauth_code_verifier');
                sessionStorage.removeItem('panel_oauth_state');
            }
        } catch (ignoredError) {
            return;
        }
    }

    async loadSelfOrgConnection() {
        if (!this.canManageSelfOrgApi) return;
        this.isSelfOrgConnectionBusy = true;
        this.selfOrgConnectionError = '';
        try {
            const status = await getSelfOrgConnectionStatus();
            this.selfOrgConnectionConfigured = status.configured === true;
            this.selfOrgConnectionConnected = status.connected === true;
            this.selfOrgConnectionMessage = status.message || '';
        } catch (error) {
            this.selfOrgConnectionError = error.body?.message || error.message || 'Could not load Salesforce API connection status.';
            this.selfOrgConnectionConnected = false;
        } finally {
            this.isSelfOrgConnectionBusy = false;
        }
    }

    async handleConnectSelfOrgApi() {
        if (!this.selfOrgConnectionConfigured) {
            this.showToast('Setup required', 'Run the PKCE setup command shown below, then refresh this page.', 'info');
            return;
        }
        this.isSelfOrgConnectionBusy = true;
        this.selfOrgConnectionError = '';
        try {
            const authorizationUrl = await getSelfOrgAuthorizationUrl();
            window.location.assign(authorizationUrl);
        } catch (error) {
            this.selfOrgConnectionError = error.body?.message || error.message || 'Could not start Salesforce authorization.';
            this.showToast('Connection could not start', this.selfOrgConnectionError, 'error');
        } finally {
            this.isSelfOrgConnectionBusy = false;
        }
    }

    async handleDisconnectSelfOrgApi() {
        const confirmed = await LightningConfirm.open({
            label: 'Disconnect Salesforce API',
            message: 'Package API actions will stop until this Salesforce org is connected again.',
            theme: 'warning'
        });
        if (!confirmed) return;
        this.isSelfOrgConnectionBusy = true;
        this.selfOrgConnectionError = '';
        try {
            await disconnectSelfOrgApi();
            this.showToast('Salesforce API disconnected', 'The stored authorization has been revoked.', 'success');
            await this.loadSelfOrgConnection();
        } catch (error) {
            this.selfOrgConnectionError = error.body?.message || error.message || 'Could not disconnect Salesforce API.';
            this.showToast('Disconnect failed', this.selfOrgConnectionError, 'error');
        } finally {
            this.isSelfOrgConnectionBusy = false;
        }
    }

    /**
     * Generates a random PKCE code verifier and computes the SHA-256 code challenge.
     */
    async generatePkce() {
        const randomValues = new Uint8Array(32);
        window.crypto.getRandomValues(randomValues);
        this.codeVerifier = Array.from(randomValues)
            .map(b => ('0' + b.toString(16)).slice(-2))
            .join('');

        try {
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('panel_oauth_code_verifier', this.codeVerifier);
            }
        } catch (e) {
            console.warn('Unable to persist codeVerifier to sessionStorage:', e);
        }

        const encoder = new TextEncoder();
        const data = encoder.encode(this.codeVerifier);
        const digest = await window.crypto.subtle.digest('SHA-256', data);

        const bytes = new Uint8Array(digest);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    async handleStartOAuth() {
        this.setPanelCredentialRepairNeeded(false);
        if (!this.panelBaseUrl || !this.clientId) {
            this.showToast('Panel environment unavailable', 'Refresh Panel Settings before starting OAuth.', 'error');
            return;
        }
        this.isLoading = true;
        try {
            const challenge = await this.generatePkce();
            const redirectUri = new URL('/oauth/callback', this.panelBaseUrl).href;
            const stateBytes = new Uint8Array(32);
            window.crypto.getRandomValues(stateBytes);
            const state = Array.from(stateBytes).map(b => ('0' + b.toString(16)).slice(-2)).join('');
            this.activeOAuthState = state;
            sessionStorage.setItem('panel_oauth_state', state);

            let authUrl = `${this.panelBaseUrl.replace(/\/$/, '')}/oauth/authorize?` +
                `client_id=${encodeURIComponent(this.clientId)}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&response_type=code` +
                `&state=${encodeURIComponent(state)}` +
                `&code_challenge=${encodeURIComponent(challenge)}` +
                `&code_challenge_method=S256` +
                `&scope=${encodeURIComponent('read write')}` +
                `&popup=1`;

            const width = 560;
            const height = 700;
            const left = (window.screen.width / 2) - (width / 2);
            const top = (window.screen.height / 2) - (height / 2);

            this.authWindow = window.open(
                authUrl,
                'PanelOAuthPopup',
                `width=${width},height=${height},top=${top},left=${left},toolbar=no,menubar=no`
            );

            this.isAuthorizingOAuth = true;
            this.startOAuthPolling();
        } catch (err) {
            this.showToast('OAuth Flow Error', err.message, 'error');
            this.isAuthorizingOAuth = false;
        } finally {
            this.isLoading = false;
        }
    }

    startOAuthPolling() {
        this.stopOAuthPolling();
        const startTime = Date.now();
        const maxDurationMs = 600000;
        this._pollFailures = 0;
        const tick = async () => {
            if (!this.isAuthorizingOAuth || !this.activeOAuthState) {
                this.stopOAuthPolling();
                return;
            }
            if (Date.now() - startTime > maxDurationMs) {
                this.isAuthorizingOAuth = false;
                this.stopOAuthPolling();
                this.closeAuthWindow();
                this.showToast('Authorization timed out', 'No approval arrived within 10 minutes. Click Connect with Panel to try again.', 'warning');
                return;
            }
            if (this._pollInFlight) {
                return;
            }
            const pollState = this.activeOAuthState;
            const pollVerifier = this.codeVerifier;
            this._pollInFlight = true;
            try {
                const result = await pollOAuthCode({
                    state: pollState,
                    codeVerifier: pollVerifier
                });
                if (!this.isAuthorizingOAuth || this.activeOAuthState !== pollState) {
                    return;
                }
                if (result?.success && result.code && this.isAuthorizingOAuth) {
                    this.isAuthorizingOAuth = false;
                    this.stopOAuthPolling();
                    this.closeAuthWindow();
                    this.showToast('OAuth Approved', 'Authorization code received. Connecting to Panel...', 'info');
                    await this.exchangeCode(result.code);
                } else {
                    this._pollFailures = 0;
                }
            } catch (ignoredError) {
                this._pollFailures += 1;
                if (this._pollFailures === 5) {
                    this.showToast('Still waiting for approval', 'Approve access in the popup. This page connects automatically once approved.', 'info');
                }
            } finally {
                this._pollInFlight = false;
            }
        };
        tick();
        this._pollInterval = setInterval(tick, 2000);
    }

    stopOAuthPolling() {
        if (this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
        }
    }

    handleCancelOAuth() {
        this.isAuthorizingOAuth = false;
        this.stopOAuthPolling();
        this.closeAuthWindow();
    }

    async exchangeCode(code) {
        this.isAuthorizingOAuth = false;
        this.stopOAuthPolling();
        this.isLoading = true;
        try {
            const redirectUri = new URL('/oauth/callback', this.panelBaseUrl).href;
            const verifier = this.codeVerifier || (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('panel_oauth_code_verifier') : '');
            const status = await exchangeOAuthCode({ requestJson: JSON.stringify({
                code: code,
                redirectUri: redirectUri,
                codeVerifier: verifier,
                panelBaseUrl: this.panelBaseUrl
            }) });

            this.clearPanelOAuthSessionState();
            this.setPanelCredentialRepairNeeded(false);
            this.applyAuthStatus(status);

            this.showToast(
                'Connected Successfully',
                `Authenticated as ${this.userEmail} (${this.userRole}) in ${this.teamName}.`,
                'success'
            );
            await this.loadSelfOrgConnection();
        } catch (err) {
            const message = err.body?.message || err.message || 'Panel login could not be completed.';
            if (message.includes('PANEL_CREDENTIAL_ACCESS_REQUIRED')) {
                this.setPanelCredentialRepairNeeded(true);
            }
            this.showToast('Token Exchange Failed', message, 'error');
        } finally {
            this.isLoading = false;
        }
    }

    setPanelCredentialRepairNeeded(needsRepair) {
        this.isPanelCredentialRepairNeeded = needsRepair;
        try {
            if (needsRepair) {
                localStorage.setItem('tubot_panel_credential_repair_needed', 'true');
            } else {
                localStorage.removeItem('tubot_panel_credential_repair_needed');
            }
        } catch (ignoredError) {
            // The repair instructions remain available for this component session.
        }
    }

    async handleLogout() {
        this.isAuthorizingOAuth = false;
        this.isLoading = true;
        try {
            await logoutPanel();
            this.isConnected = false;
            this.userEmail = '';
            this.userRole = '';
            this.teamName = '';
            this.canEditSettings = false;
            this.clearPanelOAuthSessionState();
            this.showToast('Disconnected', 'Panel session cleared.', 'info');
        } catch (err) {
            this.showToast('Logout Error', err.body?.message || err.message, 'error');
        } finally {
            this.isLoading = false;
        }
    }

    get roleBadgeClass() {
        const r = (this.userRole || '').toLowerCase();
        if (r === 'owner' || r === 'admin' || r === 'edit-salesforce-settings') {
            return 'slds-badge slds-theme_success font-bold';
        }
        return 'slds-badge slds-theme_warning font-bold';
    }

    async loadIntegrationCandidates() {
        try {
            const users = await getIntegrationCandidates();
            this.integrationCandidates = users || [];
            this.integrationUserOptions = this.integrationCandidates.map(user => ({
                label: user.name + ' (' + user.username + ' • ' + user.profileName + ')',
                value: user.id
            }));
            if (this.integrationCandidates.length > 0 && !this.selectedIntegrationUserId) {
                const preferred = this.integrationCandidates.find(user => user.isIntegrationProfile) || this.integrationCandidates[0];
                this.selectedIntegrationUserId = preferred.id;
            }
        } catch (err) {
            console.error('[loadIntegrationCandidates] error:', err);
        }
    }

    handleIntegrationUserChange(event) {
        this.selectedIntegrationUserId = event.detail.value;
    }

    handleTabSelect(event) {
        this.activeTab = event.target.value;
        if (this.activeTab === 'setup') {
            this.loadBackups();
        } else if (this.activeTab === 'settings') {
            this.loadMessagingChannels();
        } else if (this.activeTab === 'wizard') {
            this.loadIntegrationCandidates();
            this.loadMessagingChannels();
        }
    }

    async loadMessagingChannels() {
        try {
            const channels = await getMessagingChannels();
            this.messagingChannels = channels || [];
            this.messagingChannelOptions = (channels || []).map(c => ({
                label: `${c.label} (${c.developerName})`,
                value: c.id
            }));
            if (this.messagingChannels.length > 0) {
                if (!this.selectedChannelId || !this.messagingChannels.find(c => c.id === this.selectedChannelId)) {
                    this.selectedChannelId = this.messagingChannels[0].id;
                }
            } else {
                this.selectedChannelId = '';
            }
        } catch (err) {
            console.error('Failed to load messaging channels:', err);
        }
    }

    handleChannelChange(event) {
        this.selectedChannelId = event.target.value;
    }

    get selfOrgConnectionStatusLabel() {
        if (this.isSelfOrgConnectionBusy) return 'Checking';
        if (this.selfOrgConnectionConnected) return 'Connected';
        if (this.selfOrgConnectionConfigured && !this.isConnected) return 'Connect Panel first';
        return this.selfOrgConnectionConfigured ? 'Not connected' : 'Setup required';
    }

    get selfOrgConnectionStatusClass() {
        const statusClass = this.selfOrgConnectionConnected ? 'slds-theme_success' :
            this.selfOrgConnectionConfigured ? 'slds-theme_warning' : 'slds-theme_shade';
        return `slds-badge ${statusClass}`;
    }

    get selfOrgApiActionLabel() {
        return this.selfOrgConnectionConnected ? 'Reconnect Salesforce API' : 'Connect Salesforce API';
    }

    get selfOrgApiActionDisabled() {
        return !this.isConnected || !this.canEditSettings || !this.selfOrgConnectionConfigured || this.isSelfOrgConnectionBusy;
    }

    get selfOrgDisconnectDisabled() {
        return !this.isConnected || !this.canEditSettings || !this.selfOrgConnectionConnected || this.isSelfOrgConnectionBusy;
    }

    get panelCredentialRepairCommand() {
        return 'bun scripts/repair-panel-external-credential-access.mjs --target-org <org-alias>';
    }

    // =========================================================================
    // Simple Setup (one-click automatic)
    // =========================================================================

    get simpleSetupRunDisabled() {
        return !this.simpleSetupConsented || this.simpleSetupRunning;
    }

    handleSimpleSetupConsent(event) {
        this.simpleSetupConsented = event.target.checked;
    }

    simpleSetupDisplaySteps() {
        return [
            { key: 'user', label: 'Integration user & API access' },
            { key: 'channel', label: 'Messaging Channel & Omni-Queue' },
            { key: 'eca', label: 'External Client App' },
            { key: 'finalize', label: 'Register & verify' }
        ];
    }

    setSimpleSetupStep(key, state, message) {
        this.simpleSetupSteps = this.simpleSetupSteps.map((step) => {
            if (step.key !== key) {
                return step;
            }
            const iconName = state === 'done'
                ? 'utility:check'
                : state === 'failed' ? 'utility:error' : state === 'action-required' ? 'utility:warning' : 'utility:clock';
            return {
                ...step,
                state,
                message: message || '',
                iconName,
                showSpinner: state === 'running'
            };
        });
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async handleSimpleSetupRun() {
        if (!this.simpleSetupConsented || this.simpleSetupRunning) {
            return;
        }
        if (!this.isConnected) {
            this.simpleSetupError = 'Connect Panel first (Panel login above), then run Simple Setup.';
            this.showToast('Panel Login Required', this.simpleSetupError, 'warning');
            return;
        }
        this.simpleSetupRunning = true;
        this.simpleSetupDone = false;
        this.simpleSetupError = '';
        this.simpleSetupSteps = this.simpleSetupDisplaySteps().map((step) => ({
            ...step,
            state: 'pending',
            message: '',
            iconName: 'utility:clock',
            showSpinner: false
        }));
        // ECA preparation commits DML before the separate popup callout.
        this.stopSimpleSetupWait();
        this.simpleSetupEcaGuidance = null;
        this.simpleSetupEcaManual = false;
        this.simpleSetupEcaBusy = false;
        this._setupContinuation = null;
        const chain = [
            { call: 'user', row: 'user' },
            { call: 'channel', row: 'channel' },
            { call: 'eca', row: 'eca' },
            { call: 'finalize', row: 'finalize' },
            { call: 'finalize-register', row: 'finalize' }
        ];
        const state = {};
        if (this.selectedIntegrationUserId) {
            state.user = { id: this.selectedIntegrationUserId };
        }
        if (this.selectedChannelId) {
            state.channel = { id: this.selectedChannelId };
        }
        this.runSimpleSetupChain(chain, 0, state);
    }

    async runSimpleSetupChain(chain, startIndex, state) {
        try {
            for (let index = startIndex; index < chain.length; index++) {
                const link = chain[index];
                this.setSimpleSetupStep(link.row, 'running', '');
                const result = await runSimpleSetupStep({ step: link.call, state });
                if (result.status === 'popup-required') {
                    this.simpleSetupEcaGuidance = result.eca || null;
                    this._setupContinuation = { chain, index, state };
                    this.setSimpleSetupStep(link.row, 'action-required', result.message || '');
                    this.simpleSetupError = '';
                    return;
                }
                if (result.status !== 'done') {
                    throw new Error(result.message || 'Setup step failed.');
                }
                this.mergeSimpleSetupResult(state, link, result);
                this.setSimpleSetupStep(link.row, 'done', result.message || '');
            }
            this.simpleSetupDone = true;
            this.simpleSetupRunning = false;
            this.showToast('Simple Setup Complete', 'Channel registered and verified end to end.', 'success');
        } catch (err) {
            const message = err.body?.message || err.message || 'Simple Setup failed.';
            this.simpleSetupError = message;
            const failedRow = this.simpleSetupSteps.find((step) => step.state === 'running');
            if (failedRow) {
                this.setSimpleSetupStep(failedRow.key, 'failed', message);
            }
            this.showToast('Simple Setup Failed', message, 'error');
            this.simpleSetupRunning = false;
        }
    }

    mergeSimpleSetupResult(state, link, result) {
        Object.assign(state, result.state || {});
        if (result.user) {
            state.user = result.user;
        }
        if (result.channel) {
            state.channel = result.channel;
        }
        if (link.call === 'eca' && result.eca) {
            this.simpleSetupEcaGuidance = result.eca;
        }
    }

    async handleSimpleSetupAuthorize() {
        if (!this._setupContinuation || this.simpleSetupEcaBusy) {
            return;
        }
        // Open synchronously in the click handler so popup blockers see the user gesture.
        const popup = window.open('', `TubotSetupAuthorization_${Date.now()}`, 'width=560,height=700,toolbar=no,menubar=no');
        if (!popup) {
            this.simpleSetupError = 'Allow popups for Salesforce, then click Authorize & continue again.';
            return;
        }
        popup.opener = null;
        this._setupEcaPopup = popup;
        this.stopSimpleSetupWait();
        const epoch = this._setupPollEpoch;
        this.simpleSetupEcaBusy = true;
        this.simpleSetupEcaManual = false;
        this.simpleSetupError = '';
        try {
            const result = await initiateEcaAuthorization();
            if (epoch !== this._setupPollEpoch) {
                popup.close();
                return;
            }
            popup.location.href = result.authorizationUrl;
            this.setSimpleSetupStep('eca', 'running', 'Waiting for Salesforce approval and policy verification…');
            this.waitForSimpleSetupAuthorization(result.oauthState);
        } catch (error) {
            popup.close();
            if (epoch === this._setupPollEpoch) {
                this.failSimpleSetupAuthorization(error.body?.message || error.message || 'Could not open Salesforce authorization. Retry or use the manual steps.');
            }
        }
    }

    waitForSimpleSetupAuthorization(oauthState) {
        const epoch = this._setupPollEpoch;
        const startTime = Date.now();
        let closedAt = null;
        const poll = async () => {
            if (epoch !== this._setupPollEpoch) {
                return;
            }
            try {
                const result = await pollEcaAuthorization({ state: oauthState });
                if (epoch !== this._setupPollEpoch) {
                    return;
                }
                if (result.status === 'done') {
                    await this.continueAfterSimpleSetupAuthorization();
                    return;
                }
                if (result.status === 'failed') {
                    throw new Error(this.simpleSetupAuthorizationError(result.error));
                }
                if (this._setupEcaPopup?.closed && closedAt === null) {
                    closedAt = Date.now();
                }
                if (Date.now() - startTime > 600000 || (closedAt !== null && Date.now() - closedAt > 15000)) {
                    throw new Error('Authorization was closed or expired. Retry authorization or use the manual steps.');
                }
                this._setupWaitInterval = setTimeout(poll, 3000);
            } catch (error) {
                if (epoch === this._setupPollEpoch) {
                    this.failSimpleSetupAuthorization(error.body?.message || error.message || 'Could not read the setup outcome. Retry authorization.');
                }
            }
        };
        poll();
    }

    simpleSetupAuthorizationError(code) {
        const messages = {
            authorization_declined: 'Salesforce authorization was declined. Retry or use the manual steps.',
            org_mismatch: 'Salesforce approved a different org. Sign in to this org and retry.',
            state_expired: 'Setup authorization expired. Click Authorize & continue to start again.',
            token_exchange_failed: 'Salesforce could not exchange the approval. Start a new authorization and retry.',
            token_revocation_failed: 'The temporary token could not be confirmed revoked. Revoke TuBot Panel Connection in Salesforce Connected Apps OAuth Usage before retrying.',
            policy_not_found: 'The execution app policy was not found. Check the package installation or use the manual steps.',
            policy_update_failed: 'Salesforce rejected the policy change. Approve with a Salesforce administrator or use the manual steps.',
            policy_verification_failed: 'Salesforce did not confirm the policy change. Retry or use the manual steps.'
        };
        return messages[code] || 'Setup authorization did not complete. Retry with a Salesforce administrator or use the manual steps.';
    }

    failSimpleSetupAuthorization(message) {
        this.stopSimpleSetupWait();
        this.simpleSetupEcaBusy = false;
        this.simpleSetupError = message;
        this.setSimpleSetupStep('eca', 'action-required', message);
    }

    handleSimpleSetupManual() {
        this.stopSimpleSetupWait();
        if (this._setupEcaPopup && !this._setupEcaPopup.closed) {
            this._setupEcaPopup.close();
        }
        this.simpleSetupEcaBusy = false;
        this.simpleSetupEcaManual = true;
        this.simpleSetupError = '';
        this.setSimpleSetupStep('eca', 'action-required', 'Complete the manual Setup steps, then re-check.');
    }

    async handleSimpleSetupRecheck() {
        if (!this._setupContinuation || this.simpleSetupEcaBusy) {
            return;
        }
        this.simpleSetupEcaBusy = true;
        this.simpleSetupError = '';
        try {
            await this.continueAfterSimpleSetupAuthorization();
        } catch (error) {
            this.failSimpleSetupAuthorization(error.body?.message || error.message || 'Could not verify pre-authorization membership. Check the manual steps and retry.');
        }
    }

    async continueAfterSimpleSetupAuthorization() {
        const continuation = this._setupContinuation;
        if (!continuation) {
            return;
        }
        const epoch = this._setupPollEpoch;
        const result = await checkEcaAuthorization({ userId: continuation.state.user.id });
        if (epoch !== this._setupPollEpoch) {
            return;
        }
        if (result.status !== 'done') {
            throw new Error(result.message || 'Pre-authorization membership is missing.');
        }
        this.stopSimpleSetupWait();
        this.simpleSetupEcaBusy = false;
        this.simpleSetupEcaGuidance = null;
        this.simpleSetupEcaManual = false;
        this._setupContinuation = null;
        this.setSimpleSetupStep('eca', 'done', result.message);
        await this.runSimpleSetupChain(continuation.chain, continuation.index + 1, continuation.state);
    }

    stopSimpleSetupWait() {
        this._setupPollEpoch += 1;
        if (this._setupWaitInterval) {
            clearTimeout(this._setupWaitInterval);
            this._setupWaitInterval = null;
        }
    }

    async handleCopyPoliciesCommand() {
        const command = this.simpleSetupEcaGuidance?.cliCommand || '';
        if (!command) {
            return;
        }
        try {
            await navigator.clipboard.writeText(command);
            this.showToast('Copied', 'Policies command copied to clipboard.', 'success');
        } catch (ignoredError) {
            this.showToast('Copy failed', 'Select the command text and copy it manually.', 'warning');
        }
    }

    get showSelfOrgSetupInstructions() {
        // The Panel-connection client ships in the package: no CLI or manual
        // ECA setup can be missing. Instructions stay hidden permanently.
        return false;
    }

    get canManageSelfOrgApi() {
        return this.hasSettingsAccess;
    }

    addSetupLog(line) {
        this.setupLogs = [
            ...this.setupLogs,
            { id: `slog_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`, text: line }
        ];
    }

    // ==========================================
    // Messaging Configuration Backup & Restore Handlers
    // ==========================================
    get hasBackups() {
        return this.backupsList && this.backupsList.length > 0;
    }

    get backupsCountLabel() {
        const count = this.backupsList ? this.backupsList.length : 0;
        return `${count} ${count === 1 ? 'Backup' : 'Backups'}`;
    }

    get detailsCounts() {
        if (!this.selectedBackupDetails) {
            return { fields: 0, webChatDeployments: 0, messagingChannels: 0, queues: 0, skills: 0, flows: 0 };
        }
        const snap = this.selectedBackupDetails.snapshot;
        if (snap && snap.counts) {
            return {
                fields: snap.counts.fields || 0,
                webChatDeployments: snap.counts.webChatDeployments || 0,
                messagingChannels: snap.counts.messagingChannels || 0,
                queues: snap.counts.queues || 0,
                skills: snap.counts.skills || 0,
                flows: snap.counts.flows || 0
            };
        }
        const meta = this.selectedBackupDetails.metadata || (snap ? snap.metadata : null);
        return {
            fields: meta?.fields?.length || 0,
            webChatDeployments: meta?.webChatDeployments?.length || 0,
            messagingChannels: meta?.messagingChannels?.length || 0,
            queues: meta?.queues?.length || 0,
            skills: meta?.skills?.length || 0,
            flows: meta?.flows?.length || 0
        };
    }

    async loadBackups() {
        this.isBackupsLoading = true;
        try {
            const data = await getMessagingBackups();
            this.backupsList = data || [];
        } catch (err) {
            console.error('Error loading backups:', err);
            this.showToast('Error Loading Backups', err.body?.message || err.message, 'error');
        } finally {
            this.isBackupsLoading = false;
        }
    }

    handleOpenManualBackupModal() {
        const now = new Date();
        const dateStr = now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
        this.manualBackupName = `Manual Snapshot - ${dateStr}`;
        this.manualBackupNotes = '';
        this.isManualBackupModalOpen = true;
    }

    handleCloseManualBackupModal() {
        this.isManualBackupModalOpen = false;
    }

    handleManualBackupNameChange(event) {
        this.manualBackupName = event.target.value;
    }

    handleManualBackupNotesChange(event) {
        this.manualBackupNotes = event.target.value;
    }

    async handleCreateManualBackup() {
        if (!this.manualBackupName || !this.manualBackupName.trim()) {
            this.showToast('Validation Error', 'Please specify a backup name.', 'warning');
            return;
        }

        this.isBackingUpNow = true;
        try {
            const depName = 'Global';
            const res = await createManualBackup({ requestJson: JSON.stringify({
                backupName: this.manualBackupName.trim(),
                deploymentName: depName,
                notes: this.manualBackupNotes ? this.manualBackupNotes.trim() : null
            }) });

            if (res && res.success) {
                this.showToast('Backup Created', `Captured messaging configuration backup: ${res.backupReference || res.backupName}`, 'success');
                this.addSetupLog(`✔ [Manual Backup] Created snapshot: ${res.backupReference || res.backupName} (${res.backupSummary || ''})`);
                this.handleCloseManualBackupModal();
                await this.loadBackups();
            } else {
                const errMsg = res?.error || 'Failed to capture backup.';
                this.showToast('Backup Failed', errMsg, 'error');
            }
        } catch (err) {
            const msg = err.body?.message || err.message;
            this.showToast('Backup Error', msg, 'error');
        } finally {
            this.isBackingUpNow = false;
        }
    }

    handleOpenRestoreModal(event) {
        const backupId = event.currentTarget.dataset.id;
        const found = this.backupsList.find(b => b.id === backupId);
        if (found) {
            this.selectedBackupForRestore = found;
            this.isRestoreModalOpen = true;
        }
    }

    handleCloseRestoreModal() {
        if (this.isRestoring) return;
        this.isRestoreModalOpen = false;
        this.selectedBackupForRestore = null;
    }

    async handleConfirmRestore() {
        if (!this.selectedBackupForRestore) return;

        const backupId = this.selectedBackupForRestore.id;
        const backupName = this.selectedBackupForRestore.name || this.selectedBackupForRestore.backupName;
        this.isRestoring = true;

        this.addSetupLog(`\n======================================================`);
        this.addSetupLog(`🔄 [Restore] Starting restore of backup "${backupName}" (${this.selectedBackupForRestore.backupName})...`);

        try {
            const res = await restoreMessagingBackup({
                backupId: backupId
            });

            if (res && res.logs && Array.isArray(res.logs)) {
                res.logs.forEach(l => this.addSetupLog(l));
            }

            if (res && res.success) {
                this.showToast(
                    'Backup Restored Successfully',
                    `Messaging configuration restored to snapshot "${backupName}".`,
                    'success'
                );
                this.handleCloseRestoreModal();
                await this.loadData();
                await this.loadMessagingChannels();
                await this.loadBackups();
            } else {
                const errMsg = res?.error || 'Failed to restore backup snapshot.';
                this.addSetupLog(`✖ Restore failed: ${errMsg}`);
                this.showToast('Restore Failed', errMsg, 'error');
            }
        } catch (err) {
            const msg = err.body?.message || err.message;
            this.addSetupLog(`✖ Restore exception: ${msg}`);
            this.showToast('Restore Error', msg, 'error');
        } finally {
            this.isRestoring = false;
        }
    }

    get detailsBackupName() {
        return this.selectedBackupDetails ? (this.selectedBackupDetails.name || this.selectedBackupDetails.backupName || 'Backup Snapshot') : 'Backup Snapshot';
    }

    get detailsBackupSubName() {
        return this.selectedBackupDetails ? (this.selectedBackupDetails.backupName || '') : '';
    }

    get detailsBackupTrigger() {
        return this.selectedBackupDetails ? (this.selectedBackupDetails.triggerType || '') : '';
    }

    get detailsBackupCreated() {
        return this.selectedBackupDetails ? (this.selectedBackupDetails.createdDate || '') : '';
    }

    get detailsBackupItemSummary() {
        return this.selectedBackupDetails ? (this.selectedBackupDetails.itemSummary || 'Loading item summary...') : 'Loading item summary...';
    }

    get detailsBackupNotes() {
        return this.selectedBackupDetails ? (this.selectedBackupDetails.notes || '') : '';
    }

    get hasDetailsBackupNotes() {
        return Boolean(this.selectedBackupDetails && this.selectedBackupDetails.notes);
    }

    async handleOpenDetailsModal(event) {
        const backupId = event.currentTarget.dataset.id;
        const found = this.backupsList.find(b => b.id === backupId);
        this.isDetailsLoading = true;
        this.isDetailsModalOpen = true;
        this.selectedBackupDetails = {
            id: backupId,
            name: found ? (found.name || found.backupName) : 'Loading...',
            backupName: found ? found.backupName : '',
            triggerType: found ? found.triggerType : '',
            createdDate: found ? found.createdDate : '',
            itemSummary: found ? found.itemSummary : 'Loading item summary...',
            notes: found ? found.notes : ''
        };
        this.rawBackupJson = '';

        try {
            const res = await getMessagingBackupDetails({ backupId });
            if (res && res.success) {
                this.selectedBackupDetails = res;
                try {
                    const parsed = JSON.parse(res.rawJson);
                    this.rawBackupJson = JSON.stringify(parsed, null, 2);
                } catch (ignoredError) {
                    this.rawBackupJson = res.rawJson || '';
                }
            } else {
                this.showToast('Error', res?.error || 'Failed to load backup details.', 'error');
            }
        } catch (err) {
            this.showToast('Error', err.body?.message || err.message, 'error');
        } finally {
            this.isDetailsLoading = false;
        }
    }

    handleCloseDetailsModal() {
        this.isDetailsModalOpen = false;
        this.selectedBackupDetails = null;
        this.rawBackupJson = '';
    }

    handleCopyBackupJson() {
        if (this.rawBackupJson) {
            navigator.clipboard?.writeText(this.rawBackupJson);
            this.showToast('Copied', 'Backup JSON payload copied to clipboard.', 'info');
        }
    }

    async handleDeleteBackup(event) {
        const backupId = event.currentTarget.dataset.id;
        const found = this.backupsList.find(b => b.id === backupId);
        const refName = found ? (found.name || found.backupName) : 'backup';

        this.isBackupsLoading = true;
        try {
            const res = await deleteMessagingBackup({ backupId });
            if (res && res.success) {
                this.showToast('Deleted', `Backup "${refName}" was deleted.`, 'info');
                await this.loadBackups();
            } else {
                this.showToast('Error', res?.error || 'Failed to delete backup.', 'error');
            }
        } catch (err) {
            this.showToast('Error', err.body?.message || err.message, 'error');
        } finally {
            this.isBackupsLoading = false;
        }
    }

    // =========================================================================
    // Flow t2 Subflow (varSubflow) Management
    // =========================================================================

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
