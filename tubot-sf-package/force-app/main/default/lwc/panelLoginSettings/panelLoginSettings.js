import { LightningElement, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import getPanelAuthStatus from '@salesforce/apex/PanelAuthController.getPanelAuthStatus';
import exchangeOAuthCode from '@salesforce/apex/PanelAuthController.exchangeOAuthCode';
import pollOAuthCode from '@salesforce/apex/PanelAuthController.pollOAuthCode';
import logoutPanel from '@salesforce/apex/PanelAuthController.logoutPanel';
import fetchPanelSubscriptionData from '@salesforce/apex/PanelAccountController.fetchPanelSubscriptionData';
import fetchPanelTeamMembers from '@salesforce/apex/PanelAccountController.fetchPanelTeamMembers';
import getMessagingChannels from '@salesforce/apex/MessagingConfigurationController.getMessagingChannels';
import getMessagingBackups from '@salesforce/apex/MessagingBackupController.getMessagingBackups';
import createManualBackup from '@salesforce/apex/MessagingBackupController.createManualBackup';
import restoreMessagingBackup from '@salesforce/apex/MessagingBackupController.restoreMessagingBackup';
import getMessagingBackupDetails from '@salesforce/apex/MessagingBackupController.getMessagingBackupDetails';
import deleteMessagingBackup from '@salesforce/apex/MessagingBackupController.deleteMessagingBackup';
import listApiConnections from '@salesforce/apex/PanelSalesforceChannelService.listConnections';
import connectApiChannel from '@salesforce/apex/PanelSalesforceChannelService.connectChannel';
import disconnectApiChannel from '@salesforce/apex/PanelSalesforceChannelService.disconnectChannel';
import prepareApiChannel from '@salesforce/apex/PanelSalesforceChannelService.prepareChannel';
import isApiPermissionReady from '@salesforce/apex/PanelSalesforceChannelService.isApiPermissionReady';
import getToolProxyList from '@salesforce/apex/PanelSalesforceChannelService.getToolProxyList';
import getSelfOrgConnectionStatus from '@salesforce/apex/TuBotSelfOrgConnectionController.getConnectionStatus';
import getSelfOrgAuthorizationUrl from '@salesforce/apex/TuBotSelfOrgConnectionController.getAuthorizationUrl';
import disconnectSelfOrgApi from '@salesforce/apex/TuBotSelfOrgConnectionController.disconnect';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import LightningConfirm from 'lightning/confirm';
import getSetupHealthCheck from '@salesforce/apex/TubotSetupWizardController.getSetupHealthCheck';
import getIntegrationCandidates from '@salesforce/apex/TubotSetupWizardController.getIntegrationCandidates';
import assignApiPermissionSet from '@salesforce/apex/TubotSetupWizardController.assignApiPermissionSet';
import getEcaSetupGuidance from '@salesforce/apex/TubotSetupWizardController.getEcaSetupGuidance';
import runSimpleSetupStep from '@salesforce/apex/SimpleSetupController.runStep';
import canManageApiConnections from '@salesforce/customPermission/Manage_Tubot_API_Connections';

export default class PanelLoginSettings extends NavigationMixin(LightningElement) {
    @track activeTab = 'settings';
    @track panelBaseUrl = 'https://panel.tubot.lat';
    @track clientId = 'pnl_client_salesforce_mcp';
    @track isConnected = false;
    @track userEmail = '';
    @track userRole = '';
    @track teamName = '';
    @track teamId = '';
    @track canEditSettings = false;
    @track usesExternalCredentials = false;
    @track externalCredentialName = 'Panel_External_Credential';
    @track namedCredentialName = 'Panel_Named_Credential';
    @track isLoading = false;

    // Setup Wizard State
    @track wizardStep = 'health';
    @track wizardHealth = null;
    @track isWizardHealthLoading = false;
    @track wizardUsers = [];
    @track wizardUserOptions = [];
    @track selectedWizardUserId = '';
    @track selectedWizardUser = null;
    @track isAssigningPermission = false;
    @track wizardEcaGuidance = null;
    @track wizardSelectedChannelId = '';
    @track isWizardConnecting = false;
    @track wizardConnectSuccess = false;

    // Simple Setup (one-click automatic) state
    @track simpleSetupConsented = false;
    @track simpleSetupRunning = false;
    @track simpleSetupDone = false;
    @track simpleSetupSteps = [];
    @track simpleSetupError = '';
    @track simpleSetupEcaGuidance = null;

    // Legacy manual setup UI (step wizard, connection details, per-channel
    // API access) stays in the template for break-glass but unrendered:
    // Simple Setup is the supported path. Flip to true to restore it.
    showLegacySetupUi = false;

    @track showPanelData = false;
    @track subscriptionData = null;
    @track teamMembersData = null;

    // Headless log sink: backup/restore flows append here via addSetupLog
    @track setupLogs = [];

    // Messaging Channel Omni-Flow Routing State
    @track messagingChannels = [];
    @track messagingChannelOptions = [];
    @track selectedChannelId = '';
    @track apiConnections = [];
    @track apiIntegrationUserId = '';
    @track isApiConnectionBusy = false;
    @track apiConnectionsError = '';
    @track apiConnectionSetupError = '';
    @track selfOrgConnectionConfigured = false;
    @track selfOrgConnectionConnected = false;
    @track selfOrgConnectionMessage = '';
    @track selfOrgConnectionError = '';
    @track isSelfOrgConnectionBusy = false;

    // Callable Tool Proxy Endpoints State
    @track isToolProxyModalOpen = false;
    @track toolProxyList = [];
    @track toolProxiesLoading = false;
    @track toolProxyError = '';
    @track toolProxySearchFilter = '';

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

    codeVerifier = '';

    connectedCallback() {
        try {
            this.isPanelCredentialRepairNeeded = localStorage.getItem('tubot_panel_credential_repair_needed') === 'true';
        } catch {
            this.isPanelCredentialRepairNeeded = false;
        }
        this.checkIncomingOAuthCode();
        this.checkSelfOrgOAuthResult();
        this.loadData();
        this.loadMessagingChannels();
        this.loadApiConnections();
        this.loadSelfOrgConnection();
        this.loadBackups();
        this.loadWizardData();
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
                try { data = JSON.parse(data); } catch { data = null; }
            }
            let expectedOrigin = '';
            try {
                expectedOrigin = new URL(this.panelBaseUrl).origin;
            } catch {
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
        this.userEmail = status.userEmail || '';
        this.userRole = status.userRole || '';
        this.teamName = status.teamName || '';
        this.teamId = status.teamId || '';
        this.canEditSettings = Boolean(status.canEditSettings);
        this.usesExternalCredentials = status.usesExternalCredentials === true;
        this.externalCredentialName = status.externalCredentialName || 'Panel_External_Credential';
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
        if (!authWindow || authWindow.closed) {
            this.authWindow = null;
            return;
        }
        try {
            authWindow.close();
            this.authWindow = null;
        } catch {
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
        } catch {
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

    handleStartOAuthDifferentAccount() {
        this.handleStartOAuth(true);
    }

    async handleStartOAuth(forcePromptLogin = false) {
        this.setPanelCredentialRepairNeeded(false);
        const forcePrompt = typeof forcePromptLogin === 'boolean' ? forcePromptLogin : false;
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

            if (forcePrompt) {
                authUrl += `&prompt=login&switch_account=true`;
            }

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
            let popupClosed = false;
            try {
                popupClosed = Boolean(this.authWindow && this.authWindow.closed);
            } catch {
                popupClosed = false;
            }
            if (popupClosed) {
                this.isAuthorizingOAuth = false;
                this.stopOAuthPolling();
                this.authWindow = null;
                this.showToast('Popup closed', 'The Panel login popup was closed before approval. Click Connect with Panel to try again.', 'info');
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
            this._pollInFlight = true;
            try {
                const result = await pollOAuthCode({
                    state: this.activeOAuthState,
                    codeVerifier: this.codeVerifier
                });
                if (result?.success && result.code && this.isAuthorizingOAuth) {
                    this.isAuthorizingOAuth = false;
                    this.stopOAuthPolling();
                    this.closeAuthWindow();
                    this.showToast('OAuth Approved', 'Authorization code received. Connecting to Panel...', 'info');
                    await this.exchangeCode(result.code);
                } else {
                    this._pollFailures = 0;
                }
            } catch {
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
            await this.loadApiConnections();
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
        } catch {
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
            this.teamId = '';
            this.canEditSettings = false;
            this.subscriptionData = null;
            this.teamMembersData = null;
            this.clearPanelOAuthSessionState();
            this.showToast('Disconnected', 'Panel session cleared.', 'info');
        } catch (err) {
            this.showToast('Logout Error', err.body?.message || err.message, 'error');
        } finally {
            this.isLoading = false;
        }
    }

    handleTogglePanelData() {
        this.showPanelData = !this.showPanelData;
        if (this.showPanelData) {
            this.handleLoadSubscription();
        }
    }

    async handleLoadSubscription() {
        try {
            this.subscriptionData = await fetchPanelSubscriptionData();
        } catch (err) {
            this.showToast('Subscription Load Error', err.body?.message || err.message, 'warning');
        }
    }

    async handleLoadTeamMembers() {
        try {
            this.teamMembersData = await fetchPanelTeamMembers();
        } catch (err) {
            this.showToast('Members Load Error', err.body?.message || err.message, 'warning');
        }
    }

    get roleBadgeClass() {
        const r = (this.userRole || '').toLowerCase();
        if (r === 'owner' || r === 'admin' || r === 'edit-salesforce-settings') {
            return 'slds-badge slds-theme_success font-bold';
        }
        return 'slds-badge slds-theme_warning font-bold';
    }

    // --- Administrator Setup Wizard Getters & Methods ---
    get isWizardStepHealth() { return this.wizardStep === 'health'; }
    get isWizardStepUser() { return this.wizardStep === 'user'; }
    get isWizardStepEca() { return this.wizardStep === 'eca'; }
    get isWizardStepConnect() { return this.wizardStep === 'connect'; }
    get wizardNextFromHealthDisabled() { return !this.wizardHealth; }
    get wizardNextFromUserDisabled() { return !this.selectedWizardUser; }
    get wizardConnectDisabled() {
        return !this.wizardSelectedChannelId || !this.selectedWizardUserId || this.isWizardConnecting;
    }
    get wizardEcaPoliciesCli() {
        return 'bun scripts/setup-eca-policies.mjs --target-org YOUR_ORG_ALIAS';
    }
    get selectedWizardUserUsername() {
        return this.selectedWizardUser ? this.selectedWizardUser.username : 'Selected Integration User';
    }
    get selectedWizardUserDisplayName() {
        return this.selectedWizardUser
            ? `${this.selectedWizardUser.name} (${this.selectedWizardUser.username})`
            : 'No user selected';
    }

    async loadWizardData() {
        this.isWizardHealthLoading = true;
        try {
            const [health, users, guidance] = await Promise.all([
                getSetupHealthCheck(),
                getIntegrationCandidates(),
                getEcaSetupGuidance()
            ]);
            this.wizardHealth = health;
            this.wizardUsers = users || [];
            this.wizardUserOptions = (users || []).map(u => ({
                label: `${u.name} (${u.username} • ${u.profileName})`,
                value: u.id
            }));
            if (this.wizardUsers.length > 0 && !this.selectedWizardUserId) {
                const preferred = this.wizardUsers.find(u => u.isIntegrationProfile) || this.wizardUsers[0];
                this.selectedWizardUserId = preferred.id;
                this.selectedWizardUser = preferred;
                this.apiIntegrationUserId = preferred.id;
            }
            this.wizardEcaGuidance = guidance;
        } catch (err) {
            console.error('[loadWizardData] error:', err);
        } finally {
            this.isWizardHealthLoading = false;
        }
    }

    handleWizardStepClick(event) {
        const step = event.target.value;
        if (step) this.wizardStep = step;
    }

    handleWizardGoToHealth() {
        this.wizardStep = 'health';
    }

    handleWizardGoToUser() {
        this.wizardStep = 'user';
    }

    handleWizardGoToEca() {
        this.wizardStep = 'eca';
    }

    handleWizardGoToConnect() {
        this.wizardStep = 'connect';
    }

    handleWizardRestart() {
        this.wizardStep = 'health';
        this.wizardConnectSuccess = false;
        this.loadWizardData();
    }

    handleWizardSelectUser(event) {
        const selectedId = event.detail.value;
        this.selectedWizardUserId = selectedId;
        this.selectedWizardUser = this.wizardUsers.find(u => u.id === selectedId) || null;
        this.apiIntegrationUserId = selectedId;
    }

    async handleWizardAssignPermission() {
        if (!this.selectedWizardUserId) return;
        this.isAssigningPermission = true;
        try {
            await assignApiPermissionSet({ userIdentifier: this.selectedWizardUserId });
            this.showToast('Success', 'Tubot_Salesforce_API_Read permission set assigned successfully.', 'success');
            if (this.selectedWizardUser) {
                this.selectedWizardUser = { ...this.selectedWizardUser, hasApiPermission: true };
            }
            this.wizardUsers = this.wizardUsers.map(u => (u.id === this.selectedWizardUserId ? { ...u, hasApiPermission: true } : u));
        } catch (err) {
            this.showToast('Error', err?.body?.message || err?.message || 'Failed to assign permission set', 'error');
        } finally {
            this.isAssigningPermission = false;
        }
    }

    handleWizardChannelChange(event) {
        this.wizardSelectedChannelId = event.detail.value;
        this.selectedChannelId = event.detail.value;
    }

    async handleWizardConnectChannel() {
        if (this.wizardConnectDisabled) return;
        this.isWizardConnecting = true;
        try {
            await prepareApiChannel({
                channelId: this.wizardSelectedChannelId,
                integrationUserId: this.selectedWizardUserId
            });
            const payload = JSON.stringify({
                channelId: this.wizardSelectedChannelId,
                integrationUserId: this.selectedWizardUserId
            });
            await connectApiChannel({ requestJson: payload });
            this.wizardConnectSuccess = true;
            this.showToast('Connected', 'Channel registered and verified with Panel (Run As mapping checked server-side)!', 'success');
            await this.loadApiConnections();
        } catch (err) {
            this.showToast('Connection Failed', err?.body?.message || err?.message || 'Registration failed', 'error');
        } finally {
            this.isWizardConnecting = false;
        }
    }

    handleTabSelect(event) {
        this.activeTab = event.target.value;
        if (this.activeTab === 'setup') {
            this.loadBackups();
        } else if (this.activeTab === 'settings') {
            this.loadMessagingChannels();
        } else if (this.activeTab === 'wizard') {
            this.loadWizardData();
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

    get selectedChannelApiConnected() {
        return this.apiConnections.some(c => c.channelId === this.selectedChannelId && c.isActive === 'true');
    }

    get selectedChannelApiPending() {
        return this.apiConnections.some(c => c.channelId === this.selectedChannelId && c.isActive !== 'true');
    }

    get selectedChannelExecutionUsers() {
        return this.apiConnections.filter(c => c.channelId === this.selectedChannelId && c.isActive === 'true');
    }

    get apiConnectionDisabled() {
        return !this.isConnected || !this.canEditSettings || !this.selectedChannelId || this.isApiConnectionBusy;
    }

    async loadApiConnections() {
        if (!this.isConnected || !this.canEditSettings) return;
        try {
            this.apiConnections = (await listApiConnections()).map(connection => ({
                ...connection,
                isPrimary: connection.isPrimary === 'true'
            }));
            this.apiConnectionsError = '';
        } catch (error) {
            this.apiConnectionsError = error.body?.message || error.message || 'Could not load channel access status. Retry Panel login and check the request ID in the error.';
        }
    }

    async handleRetryApiConnections() {
        this.apiConnectionsError = '';
        await this.loadApiConnections();
    }

    handleApiIntegrationUserChange(event) { this.apiIntegrationUserId = event.target.value.trim(); }

    handleOpenEcaSetup() {
        // Keep the privileged app setup in Salesforce Setup. Lightning sessions cannot
        // call the general Metadata API, so this navigates to the supported admin UI directly
        // via standard Lightning navigation to comply with Lightning Web Security policies.
        const ecaUrl = '/lightning/setup/ExternalClientApps/home';
        try {
            this[NavigationMixin.Navigate]({
                type: 'standard__webPage',
                attributes: {
                    url: ecaUrl
                }
            });
        } catch {
            window.location.assign(ecaUrl);
        }
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

    get postinstallScriptUrl() {
        return `${(this.panelBaseUrl || '').replace(/\/+$/, '')}/setup/tubot-postinstall.py`;
    }

    get postinstallCommand() {
        return `curl -fsSL ${this.postinstallScriptUrl} -o tubot-postinstall.py && python3 tubot-postinstall.py`;
    }

    async handleCopyPostinstallCommand() {
        const success = await this.copyToClipboard(this.postinstallCommand);
        if (success) {
            this.showToast('Copied', 'Post-install one-liner copied to clipboard.', 'success');
        } else {
            this.showToast('Copy Failed', 'Could not copy the command to clipboard.', 'error');
        }
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
        // Server calls per display row. Every step is synchronous (the OAuth
        // clients ship in the package, so nothing deploys or polls) except
        // the ECA step, which waits for the one policies command and then
        // resumes automatically.
        this.stopSimpleSetupWait();
        this.simpleSetupEcaGuidance = null;
        const chain = [
            { call: 'user', row: 'user' },
            { call: 'channel', row: 'channel' },
            { call: 'eca', row: 'eca' },
            { call: 'finalize', row: 'finalize' },
            { call: 'finalize-register', row: 'finalize' }
        ];
        const state = {};
        if (this.selectedWizardUserId) {
            state.user = { id: this.selectedWizardUserId };
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
                if (result.status === 'action-required') {
                    this.simpleSetupEcaGuidance = result.eca || null;
                    this.setSimpleSetupStep(link.row, 'action-required', result.message || '');
                    this.simpleSetupError = '';
                    this.showToast('Action required', result.message || 'Run the policies command below — setup continues automatically.', 'warning');
                    this.waitForSimpleSetupPolicies(chain, index, state);
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

    waitForSimpleSetupPolicies(chain, ecaIndex, state) {
        this.stopSimpleSetupWait();
        this.setSimpleSetupStep(chain[ecaIndex].row, 'running', 'Waiting for the policies command…');
        const startTime = Date.now();
        const maxDurationMs = 600000;
        this._setupWaitInterval = setInterval(async () => {
            if (Date.now() - startTime > maxDurationMs) {
                this.stopSimpleSetupWait();
                this.simpleSetupRunning = false;
                this.setSimpleSetupStep(chain[ecaIndex].row, 'action-required', 'Timed out waiting for the policies command.');
                this.simpleSetupError = 'Timed out waiting for the policies command. Run it, then click Run Simple Setup to retry.';
                this.showToast('Timed out', this.simpleSetupError, 'warning');
                return;
            }
            try {
                const result = await runSimpleSetupStep({ step: 'eca', state });
                if (result.status === 'done') {
                    this.stopSimpleSetupWait();
                    this.mergeSimpleSetupResult(state, chain[ecaIndex], result);
                    this.setSimpleSetupStep(chain[ecaIndex].row, 'done', result.message || '');
                    this.showToast('Pre-authorization detected', 'Continuing setup automatically.', 'success');
                    this.runSimpleSetupChain(chain, ecaIndex + 1, state);
                }
            } catch {
                // Keep waiting; a failed recheck must not kill the run.
            }
        }, 5000);
    }

    stopSimpleSetupWait() {
        if (this._setupWaitInterval) {
            clearInterval(this._setupWaitInterval);
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
        } catch {
            this.showToast('Copy failed', 'Select the command text and copy it manually.', 'warning');
        }
    }

    get showSelfOrgSetupInstructions() {
        // The Panel-connection client ships in the package: no CLI or manual
        // ECA setup can be missing. Instructions stay hidden permanently.
        return false;
    }

    get canManageSelfOrgApi() {
        return canManageApiConnections;
    }

    async handleConnectApiChannel() {
        this.isApiConnectionBusy = true;
        this.apiConnectionSetupError = '';
        try {
            await prepareApiChannel({ channelId: this.selectedChannelId, integrationUserId: this.apiIntegrationUserId });
            const permissionReady = await isApiPermissionReady({ integrationUserId: this.apiIntegrationUserId });
            if (!permissionReady) throw new Error('Salesforce API permission assignment is still pending. Wait a few seconds and retry. If it remains pending, assign Tubot_Salesforce_API_Read to this user in Setup, then retry.');
            await connectApiChannel({ requestJson: JSON.stringify({
                channelId: this.selectedChannelId,
                integrationUserId: this.apiIntegrationUserId
            }) });
            this.showToast('Channel connected', 'Panel can now use this channel with the configured Salesforce integration user.', 'success');
            await this.loadApiConnections();
        } catch (error) {
            const message = error.body?.message || error.message || 'Check the Run As user on the packaged TuBot Channel API app and retry.';
            this.apiConnectionSetupError = message;
            this.showToast('Channel connection failed', message, 'error');
            await this.loadApiConnections();
        } finally {
            this.isApiConnectionBusy = false;
        }
    }

    async handleDisconnectApiChannel() {
        this.isApiConnectionBusy = true;
        this.apiConnectionSetupError = '';
        try {
            await disconnectApiChannel({ channelId: this.selectedChannelId });
            this.showToast('Channel disconnected', 'Panel API access for this channel has been revoked.', 'success');
            await this.loadApiConnections();
        } catch (error) {
            const message = error.body?.message || error.message || 'Check Panel login and retry.';
            this.apiConnectionSetupError = message;
            this.showToast('Disconnect failed', message, 'error');
        } finally {
            this.isApiConnectionBusy = false;
        }
    }

    get toolProxyCount() {
        return this.toolProxyList ? this.toolProxyList.length : 0;
    }

    get hasNoToolProxies() {
        return !this.toolProxyList || this.toolProxyList.length === 0;
    }

    get hasFilteredToolProxies() {
        return this.filteredToolProxyList && this.filteredToolProxyList.length > 0;
    }

    get filteredToolProxyList() {
        if (!this.toolProxyList) return [];
        if (!this.toolProxySearchFilter) return this.toolProxyList;
        return this.toolProxyList.filter(url => url.toLowerCase().includes(this.toolProxySearchFilter));
    }

    async handleFetchToolProxies() {
        if (!this.selectedChannelId) {
            this.showToast('No Channel Selected', 'Please select a messaging channel first.', 'warning');
            return;
        }
        this.toolProxiesLoading = true;
        this.toolProxyError = '';
        this.toolProxySearchFilter = '';
        try {
            const proxies = await getToolProxyList({ channelId: this.selectedChannelId });
            this.toolProxyList = proxies || [];
            this.isToolProxyModalOpen = true;
        } catch (err) {
            const message = err.body?.message || err.message || 'Failed to load callable tool proxy endpoints.';
            this.toolProxyError = message;
            this.showToast('Fetch Failed', message, 'error');
        } finally {
            this.toolProxiesLoading = false;
        }
    }

    handleCloseToolProxyModal() {
        this.isToolProxyModalOpen = false;
        this.toolProxySearchFilter = '';
    }

    handleToolProxySearchChange(event) {
        this.toolProxySearchFilter = (event.target.value || '').trim().toLowerCase();
    }

    async copyToClipboard(text) {
        if (!text) return false;
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) {
            console.warn('Clipboard writeText failed, using fallback textarea', e);
        }
        try {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            return successful;
        } catch (fallbackErr) {
            console.error('Fallback clipboard copy failed', fallbackErr);
            return false;
        }
    }

    async handleCopyToolProxy(event) {
        const url = event.currentTarget?.dataset?.url || event.target?.dataset?.url;
        if (!url) return;
        const success = await this.copyToClipboard(url);
        if (success) {
            this.showToast('Copied', 'Tool proxy URL copied to clipboard.', 'success');
        } else {
            this.showToast('Copy Failed', 'Could not copy URL to clipboard.', 'error');
        }
    }

    async handleCopyAllToolProxies() {
        if (!this.toolProxyList || this.toolProxyList.length === 0) {
            this.showToast('Nothing to Copy', 'No proxy endpoints available.', 'info');
            return;
        }
        const allUrls = this.toolProxyList.join('\n');
        const success = await this.copyToClipboard(allUrls);
        if (success) {
            this.showToast('Copied All', `${this.toolProxyList.length} tool proxy endpoints copied to clipboard.`, 'success');
        } else {
            this.showToast('Copy Failed', 'Could not copy endpoints to clipboard.', 'error');
        }
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
                } catch {
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
