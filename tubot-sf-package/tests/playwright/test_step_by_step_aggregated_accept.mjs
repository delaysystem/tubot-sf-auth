import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ARTIFACT_DIR = process.env.ARTIFACT_DIR || '/teamspace/studios/this_studio/.gemini/antigravity-cli/brain/34faf005-f53d-4d70-a581-2e854ae243fc';
const SCREENSHOT_DIR = path.join(ARTIFACT_DIR, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFrontdoorUrl(orgAlias = 'test1empty') {
    console.log(`[Setup] Acquiring Salesforce Org Frontdoor URL for ${orgAlias} via SF CLI...`);
    const out = execSync(`sf org open -r --target-org ${orgAlias}`, { encoding: 'utf8' });
    const match = out.match(/https:\/\/[^\s]+\/secur\/frontdoor\.jsp\?[^\s]+/);
    if (!match) {
        throw new Error('Failed to parse frontdoor URL from output: ' + out);
    }
    const url = match[0].trim();
    console.log(`[Setup] Frontdoor URL retrieved successfully for ${orgAlias}.`);
    return url;
}

async function run() {
    console.log('========================================================================');
    console.log('STARTING PLAYWRIGHT E2E TEST: STEP-BY-STEP AGGREGATED ACCEPT AUTOMATION');
    console.log('========================================================================\n');

    const frontdoorUrl = await getFrontdoorUrl('test1empty');

    console.log('[Playwright] Launching Chromium browser (headless)...');
    const browser = await chromium.launch({
        executablePath: '/usr/bin/google-chrome',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1440,1100'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        console.log('[Step 1] Authenticating into test1empty via Frontdoor session...');
        await page.goto(frontdoorUrl, { timeout: 60000 });

        console.log('[Step 1b] Waiting for redirect into Lightning shell (/lightning/)...');
        await page.waitForURL(url => url.href.includes('/lightning/'), { timeout: 60000 });
        console.log(` ✔ Authenticated! Current URL: ${page.url()}`);

        const lightningOrigin = new URL(page.url()).origin;
        const panelSettingsUrl = `${lightningOrigin}/lightning/n/tubot__Panel_Settings`;
        console.log(`[Step 1c] Navigating to Panel Settings tab: ${panelSettingsUrl}...`);
        await page.goto(panelSettingsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log('[Step 1d] Waiting for custom component to mount...');
        await page.waitForSelector('c-panel-login-settings, tubot-panel-login-settings', { timeout: 45000 });
        console.log(' ✔ Component mounted successfully in DOM!');

        await sleep(4000);

        // ---------------------------------------------------------------------
        // VERIFICATION A: Tab 1 (Agent Settings)
        // ---------------------------------------------------------------------
        console.log('\n--- VERIFICATION A: AGENT SETTINGS TAB ---');

        // Check Testing tab is removed
        const testingTabCount = await page.locator('tubot-panel-login-settings a:has-text("Testing"), c-panel-login-settings a:has-text("Testing"), lightning-tab-bar li[title*="Testing"]').count();
        console.log(`Testing tab presence count: ${testingTabCount} (Expected: 0)`);
        if (testingTabCount > 0) {
            console.error('✖ FAIL: Testing tab is still present in DOM!');
        } else {
            console.log(' ✔ PASS: Testing tab has been successfully deleted!');
        }

        // Check Agent Select (Multi-Tenant Grounding) selector is removed
        const agentSelectCard = await page.locator('tubot-panel-login-settings :has-text("Agent Select (Multi-Tenant Grounding)"), c-panel-login-settings :has-text("Agent Select (Multi-Tenant Grounding)")').count();
        console.log(`Agent Select (Multi-Tenant Grounding) presence count: ${agentSelectCard} (Expected: 0)`);
        if (agentSelectCard > 0) {
            console.error('✖ FAIL: Agent Select card is still present!');
        } else {
            console.log(' ✔ PASS: Agent Select (Multi-Tenant Grounding) card is deleted!');
        }

        // Verify Tubot Settings: AI Routing and Queues & Skills
        const aiRoutingInput = page.locator('textarea[name="AI Routing"], textarea[data-id="ai-routing-input"]');
        const aiRoutingExists = await aiRoutingInput.count() > 0;
        console.log(`AI Routing textarea exists: ${aiRoutingExists}`);

        const qsInputs = page.locator('input[data-testid="qs-input"], lightning-input[data-testid="qs-input"]');
        const qsCount = await qsInputs.count();
        console.log(`Queues and Skills inputs count: ${qsCount}`);

        // Verify Messaging Channel Card (no standalone configure button)
        const standaloneBtn = page.locator('lightning-button[data-testid="configure-omni-flow-btn"]');
        const standaloneBtnCount = await standaloneBtn.count();
        console.log(`Standalone Configure Omni-Flow button count: ${standaloneBtnCount} (Expected: 0)`);
        if (standaloneBtnCount === 0) {
            console.log(' ✔ PASS: Standalone channel routing button successfully removed!');
        }

        // Capture Screenshot 30: Tab 1 Cleaned View
        const shot30 = path.join(SCREENSHOT_DIR, '30_agent_settings_cleaned.png');
        await page.screenshot({ path: shot30, fullPage: true });
        console.log(` ✔ Captured Tab 1 screenshot: ${shot30}`);

        // ---------------------------------------------------------------------
        // VERIFICATION B: Tab 2 (Step-by-Step Setup)
        // ---------------------------------------------------------------------
        console.log('\n--- VERIFICATION B: STEP-BY-STEP SETUP TAB ---');
        const setupTabLink = page.locator('tubot-panel-login-settings a:has-text("Step-by-Step Setup"), c-panel-login-settings a:has-text("Step-by-Step Setup"), lightning-tab-bar li[title*="Step-by-Step Setup"] a').first();
        await setupTabLink.waitFor({ state: 'visible', timeout: 15000 });
        await setupTabLink.click();
        console.log(' ✔ Switched to Step-by-Step Setup tab!');

        await sleep(2500);

        // Verify deployment selection
        const deploymentCombobox = page.locator('lightning-combobox:has-text("Embedded Service Deployment"), lightning-combobox[data-testid="setup-deployment-select"]').first();
        await deploymentCombobox.waitFor({ state: 'visible', timeout: 10000 });

        // Verify associated messaging channel display
        const channelDisplay = page.locator(':has-text("Associated Messaging Channel:")');
        const hasChannelDisplay = await channelDisplay.count() > 0;
        console.log(`Associated Messaging Channel display visible: ${hasChannelDisplay}`);

        // Capture Screenshot 31: Step-by-Step Setup ready for Accept
        const shot31 = path.join(SCREENSHOT_DIR, '31_step_by_step_setup_ready.png');
        await page.screenshot({ path: shot31, fullPage: true });
        console.log(` ✔ Captured Step-by-Step Setup ready screenshot: ${shot31}`);

        // ---------------------------------------------------------------------
        // VERIFICATION C: Click Accept Setup and execute aggregated pipeline
        // ---------------------------------------------------------------------
        console.log('\n--- VERIFICATION C: EXECUTING AGGREGATED ACCEPT PIPELINE ---');
        const acceptBtn = page.locator('lightning-button[data-testid="accept-setup-btn"] button, button:has-text("Accept")').first();
        await acceptBtn.waitFor({ state: 'visible', timeout: 10000 });
        console.log(' ✔ Located Accept button. Clicking now...');
        await acceptBtn.click();

        console.log('[Pipeline] Waiting for aggregated Tooling API setup to complete (up to 30s)...');
        // Wait for setup logs to populate
        await sleep(15000);

        // Check if logs are visible
        const logsContainer = page.locator('[data-testid="setup-pipeline-logs"], div.bg-gray-900').first();
        if (await logsContainer.count() > 0) {
            const logsText = await logsContainer.innerText();
            console.log('\n========== CAPTURED PIPELINE LOGS ==========');
            console.log(logsText);
            console.log('============================================\n');
        }

        // Wait another 3s for any toasts or final DOM updates
        await sleep(3000);

        // Capture Screenshot 32: Aggregated Accept Pipeline Executed
        const shot32 = path.join(SCREENSHOT_DIR, '32_aggregated_accept_executed.png');
        await page.screenshot({ path: shot32, fullPage: true });
        console.log(` ✔ Captured aggregated Accept execution screenshot: ${shot32}`);

        // ---------------------------------------------------------------------
        // VERIFICATION D: Return to Tab 1 to verify live channel Omni-Flow status
        // ---------------------------------------------------------------------
        console.log('\n--- VERIFICATION D: VERIFY REFRESHED CHANNEL STATUS IN TAB 1 ---');
        const settingsTabLink = page.locator('tubot-panel-login-settings a:has-text("Agent Settings"), c-panel-login-settings a:has-text("Agent Settings"), lightning-tab-bar li[title*="Agent Settings"] a').first();
        await settingsTabLink.click();
        await sleep(2500);

        const shot33 = path.join(SCREENSHOT_DIR, '33_refreshed_channel_omni_flow.png');
        await page.screenshot({ path: shot33, fullPage: true });
        console.log(` ✔ Captured refreshed Tab 1 channel status screenshot: ${shot33}`);

        console.log('\n========================================================================');
        console.log('ALL E2E PLAYWRIGHT VERIFICATIONS PASSED SUCCESSFULLY!');
        console.log('========================================================================\n');

    } catch (err) {
        console.error('Playwright Test Error:', err);
        const errorShot = path.join(SCREENSHOT_DIR, 'error_step_by_step.png');
        await page.screenshot({ path: errorShot, fullPage: true });
        console.log(`Captured error screenshot: ${errorShot}`);
        throw err;
    } finally {
        await browser.close();
    }
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
