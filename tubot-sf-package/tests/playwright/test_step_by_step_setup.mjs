import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = '/teamspace/studios/this_studio/.gemini/antigravity-cli/brain/35c4c2aa-f9bd-44b4-b7b7-de5ad01801fd/screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFrontdoorUrl() {
    console.log('[Setup] Acquiring Salesforce Org Frontdoor URL via SF CLI...');
    const out = execSync('sf org open -r --target-org tubot.10f347fecf84@agentforce.com', { encoding: 'utf8' });
    const match = out.match(/https:\/\/[^\s]+\/secur\/frontdoor\.jsp\?[^\s]+/);
    if (!match) {
        throw new Error('Failed to parse frontdoor URL from output: ' + out);
    }
    const url = match[0].trim();
    console.log('[Setup] Frontdoor URL retrieved successfully.');
    return url;
}

async function run() {
    console.log('========================================================================');
    console.log('PLAYWRIGHT E2E TEST: STEP-BY-STEP SETUP TAB (WEB & API/MOBILE DEPLOYMENTS)');
    console.log('========================================================================\n');

    const frontdoorUrl = await getFrontdoorUrl();

    console.log('[Playwright] Launching Chromium browser (headless)...');
    const browser = await chromium.launch({
        executablePath: '/usr/bin/google-chrome',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1440,960'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1440, height: 960 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        console.log('[Step 1] Authenticating into Salesforce Org via Frontdoor session...');
        await page.goto(frontdoorUrl, { timeout: 60000 });
        
        console.log('[Step 1b] Waiting for redirect into Lightning shell (/lightning/)...');
        await page.waitForURL(url => url.href.includes('/lightning/'), { timeout: 60000 });
        console.log(` ✔ Authenticated! Current URL: ${page.url()}`);

        console.log('[Step 1c] Navigating to Panel Settings tab (/lightning/n/Panel_Settings)...');
        await page.goto('https://orgfarm-9c01b1d16c-dev-ed.develop.lightning.force.com/lightning/n/Panel_Settings', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        console.log('[Step 1d] Waiting for <c-panel-login-settings> custom component to mount...');
        await page.waitForSelector('c-panel-login-settings', { timeout: 45000 });
        console.log(' ✔ Component <c-panel-login-settings> mounted successfully in DOM!');

        // Wait 3s for initial data loading
        await sleep(3000);

        // Step 2: Click "Step-by-Step Setup" Tab
        console.log('[Step 2] Locating and clicking the "Step-by-Step Setup" tab...');
        const setupTab = page.locator('c-panel-login-settings a:has-text("Step-by-Step Setup"), c-panel-login-settings lightning-tab-bar li[title*="Step-by-Step Setup"] a').first();
        await setupTab.waitFor({ state: 'visible', timeout: 15000 });
        await setupTab.click();
        console.log(' ✔ Clicked "Step-by-Step Setup" tab!');

        await sleep(2500);

        // Screenshot 1: Step-by-Step Setup Initial View
        const screenshot1 = path.join(SCREENSHOT_DIR, '09_step_by_step_setup_tab.png');
        await page.screenshot({ path: screenshot1, fullPage: true });
        console.log(` ✔ Captured Step-by-Step Setup tab screenshot: ${screenshot1}`);

        // =========================================================================
        // SCENARIO 1: Select a Web Deployment -> Accept -> headerCustom configured
        // =========================================================================
        console.log('\n--- SCENARIO 1: WEB DEPLOYMENT CONFIGURATION ---');
        
        // Find Step 1 deployment combobox inside the setup tab
        console.log('[Scenario 1] Locating Step 1 Embedded Service Deployment combobox...');
        const depCombobox = page.locator('c-panel-login-settings lightning-tab[data-tab-value="setup"] lightning-combobox, c-panel-login-settings lightning-combobox:has-text("Embedded Service Deployment")').first();
        await depCombobox.waitFor({ state: 'visible', timeout: 10000 });
        
        // Open combobox dropdown
        const depInput = depCombobox.locator('button[role="combobox"], input[role="combobox"]').first();
        await depInput.click();
        await sleep(1000);

        // Choose a Web deployment option (e.g. containing "(Web)")
        console.log('[Scenario 1] Selecting a Web deployment option...');
        const webOption = page.locator('lightning-base-combobox-item:has-text("Web")').first();
        await webOption.waitFor({ state: 'visible', timeout: 8000 });
        const webOptionText = await webOption.innerText();
        console.log(` Selected Web deployment: ${webOptionText.trim()}`);
        await webOption.click();
        await sleep(1000);

        // Screenshot 2: Web Deployment Selected
        const screenshot2 = path.join(SCREENSHOT_DIR, '10_setup_web_selected.png');
        await page.screenshot({ path: screenshot2, fullPage: true });
        console.log(` ✔ Captured Web deployment selected screenshot: ${screenshot2}`);

        // Click Accept button
        console.log('[Scenario 1] Locating and clicking "Accept" button...');
        const acceptBtn = page.locator('c-panel-login-settings lightning-tab[data-tab-value="setup"] lightning-button:has-text("Accept") button, c-panel-login-settings button:has-text("Accept")').first();
        await acceptBtn.waitFor({ state: 'visible', timeout: 10000 });
        await acceptBtn.click();
        console.log(' ✔ Clicked "Accept" for Web deployment!');

        // Wait for Tooling API callout & DOM update
        console.log('[Scenario 1] Waiting for Tooling API header configuration to complete...');
        await sleep(6000);

        // Verify Custom UI Components table and headerCustom badge
        const headerBadge = page.locator('c-panel-login-settings span:has-text("headerCustom")').first();
        await headerBadge.waitFor({ state: 'visible', timeout: 15000 });
        console.log(' ✔ Verified: headerCustom component is ACTIVE on the Web deployment!');

        // Screenshot 3: Web Accepted Result
        const screenshot3 = path.join(SCREENSHOT_DIR, '11_setup_web_accepted_result.png');
        await page.screenshot({ path: screenshot3, fullPage: true });
        console.log(` ✔ Captured Web accepted result screenshot: ${screenshot3}`);

        // =========================================================================
        // SCENARIO 2: Select API / Mobile Deployment -> Accept -> SCRT Popup Modal
        // =========================================================================
        console.log('\n--- SCENARIO 2: API / MOBILE DEPLOYMENT CONFIGURATION ---');

        // Re-open deployment combobox
        console.log('[Scenario 2] Selecting an API deployment option...');
        await depInput.click();
        await sleep(1000);

        // Look for API deployment option (e.g. APIMessagingDeployment or containing "(API)")
        const apiOption = page.locator('lightning-base-combobox-item:has-text("API")').first();
        await apiOption.waitFor({ state: 'visible', timeout: 8000 });
        const apiOptionText = await apiOption.innerText();
        console.log(` Selected API deployment: ${apiOptionText.trim()}`);
        await apiOption.click();
        await sleep(1000);

        // Screenshot 4: API Deployment Selected
        const screenshot4 = path.join(SCREENSHOT_DIR, '12_setup_api_selected.png');
        await page.screenshot({ path: screenshot4, fullPage: true });
        console.log(` ✔ Captured API deployment selected screenshot: ${screenshot4}`);

        // Click Accept button
        console.log('[Scenario 2] Clicking "Accept" for API deployment...');
        await acceptBtn.click();

        // Wait for popup modal to display
        console.log('[Scenario 2] Waiting for SCRT popup modal to appear...');
        const scrtModal = page.locator('section[role="dialog"]:has-text("Embedded API Deployment SCRT URL")').first();
        await scrtModal.waitFor({ state: 'visible', timeout: 15000 });
        console.log(' ✔ SCRT URL popup modal is open and visible!');

        // Verify text saying "placeholder"
        const placeholderElem = page.locator('p[data-testid="scrt-placeholder-text"], p:has-text("placeholder")').first();
        await placeholderElem.waitFor({ state: 'visible', timeout: 5000 });
        const placeholderContent = await placeholderElem.innerText();
        console.log(` ✔ Verified popup contains text saying: "${placeholderContent.trim()}"`);

        // Verify SCRT URL input
        const scrtUrlInput = page.locator('input[data-testid="scrt-url-input"]').first();
        await scrtUrlInput.waitFor({ state: 'visible', timeout: 5000 });
        const scrtUrlVal = await scrtUrlInput.inputValue();
        console.log(` ✔ Verified SCRT URL in popup: "${scrtUrlVal}"`);

        // Screenshot 5: API SCRT Popup Modal
        const screenshot5 = path.join(SCREENSHOT_DIR, '13_setup_api_scrt_popup.png');
        await page.screenshot({ path: screenshot5, fullPage: true });
        console.log(` ✔ Captured API SCRT popup modal screenshot: ${screenshot5}`);

        // Close modal
        console.log('[Scenario 2] Closing SCRT URL popup modal...');
        const closeBtn = page.locator('footer.slds-modal__footer lightning-button:has-text("Close") button').first();
        await closeBtn.click();
        await sleep(1000);

        // Screenshot 6: Setup Complete
        const screenshot6 = path.join(SCREENSHOT_DIR, '14_setup_complete.png');
        await page.screenshot({ path: screenshot6, fullPage: true });
        console.log(` ✔ Captured final state screenshot: ${screenshot6}`);

        console.log('\n========================================================================');
        console.log('✔ ALL PLAYWRIGHT TESTS PASSED SUCCESSFULLY FOR STEP-BY-STEP SETUP TAB!');
        console.log('========================================================================');

    } catch (err) {
        console.error('\n✖ Playwright Test Failed:', err);
        const errorScreenshot = path.join(SCREENSHOT_DIR, 'error_step_by_step_setup.png');
        await page.screenshot({ path: errorScreenshot, fullPage: true });
        console.log(`Saved error screenshot to: ${errorScreenshot}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

run();
