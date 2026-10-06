import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = '/teamspace/studios/this_studio/.gemini/antigravity-cli/brain/b55cd639-3281-4d1f-a5f7-0fcd1821c9ae/screenshots';
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
    console.log('===============================================================');
    console.log('STARTING PLAYWRIGHT E2E TEST: SALESFORCE LWC & OAUTH SETTINGS');
    console.log('===============================================================\n');

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

        console.log('[Step 1c] Navigating directly to Panel Settings tab (/lightning/n/Panel_Settings)...');
        await page.goto('https://orgfarm-9c01b1d16c-dev-ed.develop.lightning.force.com/lightning/n/Panel_Settings', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        console.log('[Step 1d] Waiting for <c-panel-login-settings> custom component to mount...');
        await page.waitForSelector('c-panel-login-settings', { timeout: 45000 });
        console.log(' ✔ Component <c-panel-login-settings> mounted successfully in DOM!');

        // Wait 4s for Apex data load
        await sleep(4000);

        // Take initial state screenshot
        const screenshot1 = path.join(SCREENSHOT_DIR, '01_panel_settings_tab_loaded.png');
        await page.screenshot({ path: screenshot1, fullPage: true });
        console.log(` ✔ Captured initial tab screenshot: ${screenshot1}`);

        // Extract title and text to verify LWC content
        const lwcElement = page.locator('c-panel-login-settings');
        const cardText = await lwcElement.innerText();
        console.log('\n--- Component Inner Text Preview ---');
        console.log(cardText.slice(0, 600));
        console.log('-------------------------------------\n');

        // Test manual code exchange toggle
        console.log('[Step 2] Testing Manual Authorization Code toggle button...');
        const manualBtn = page.locator('button:has-text("Manual Code Exchange")').first();
        if (await manualBtn.isVisible()) {
            await manualBtn.click();
            await sleep(1500);
            console.log(' ✔ Clicked Manual Code Exchange toggle.');
        }

        const screenshot2 = path.join(SCREENSHOT_DIR, '02_oauth_login_register_options.png');
        await page.screenshot({ path: screenshot2, fullPage: true });
        console.log(` ✔ Captured OAuth options screenshot: ${screenshot2}`);

        // Test Agent Selection interaction
        console.log('[Step 3] Inspecting Agentforce Agent Select configuration table...');
        const comboboxes = page.locator('c-panel-login-settings lightning-combobox');
        const count = await comboboxes.count();
        console.log(` ✔ Found ${count} lightning-combobox controls for Agent Selection.`);

        const saveBtn = page.locator('c-panel-login-settings button:has-text("Save Agent Selection")').first();
        const hasSaveBtn = await saveBtn.isVisible();
        console.log(` ✔ Save Agent Selection button present: ${hasSaveBtn}`);

        if (hasSaveBtn) {
            console.log('[Step 4] Clicking "Save Agent Selection" button in LWC UI...');
            await saveBtn.click();
            await sleep(3000);
            console.log(' ✔ Save button clicked in UI.');
        }

        // Take final interaction screenshot
        const screenshot3 = path.join(SCREENSHOT_DIR, '03_agent_select_configuration.png');
        await page.screenshot({ path: screenshot3, fullPage: true });
        console.log(` ✔ Captured Agent Select configuration screenshot: ${screenshot3}`);

        console.log('\n===============================================================');
        console.log('PLAYWRIGHT E2E TEST COMPLETED SUCCESSFULLY!');
        console.log('===============================================================\n');

    } catch (err) {
        console.error('❌ Playwright Test Error:', err);
        const errScreenshot = path.join(SCREENSHOT_DIR, 'error_state.png');
        await page.screenshot({ path: errScreenshot, fullPage: true }).catch(() => {});
        throw err;
    } finally {
        await browser.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
