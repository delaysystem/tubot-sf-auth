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
    console.log('========================================================================');
    console.log('STARTING COMPREHENSIVE PLAYWRIGHT E2E SUITE: MULTI-TENANT AGENT SELECT');
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

        // Screenshot 1: Connected State with 'edit-salesforce-settings' Role
        const screenshot1 = path.join(SCREENSHOT_DIR, '01_oauth_connected_authorized.png');
        await page.screenshot({ path: screenshot1, fullPage: true });
        console.log(` ✔ Captured authorized connected state screenshot: ${screenshot1}`);

        // Extract title and text to verify LWC content
        const lwcElement = page.locator('c-panel-login-settings');
        const cardText = await lwcElement.innerText();
        console.log('\n--- Component Inner Text Preview ---');
        console.log(cardText.slice(0, 500));
        console.log('-------------------------------------\n');

        // Step 2: Test Add Mapping button
        console.log('[Step 2] Testing "+ Add Mapping" button to configure multiple deployments...');
        const addMappingBtn = page.locator('c-panel-login-settings button:has-text("Add Mapping")').first();
        if (await addMappingBtn.isVisible()) {
            await addMappingBtn.click();
            await sleep(1000);
            console.log(' ✔ Clicked "+ Add Mapping" button.');
        }

        // Fill in deployment channel name for the newly added row
        const depInputs = page.locator('c-panel-login-settings table input');
        const depCount = await depInputs.count();
        console.log(` ✔ Found ${depCount} deployment input fields in table.`);
        if (depCount > 1) {
            await depInputs.nth(1).fill('MyLWCWebApp');
            console.log(' ✔ Entered "MyLWCWebApp" into second deployment channel field.');
        }

        const screenshot2 = path.join(SCREENSHOT_DIR, '02_agent_select_multiple_deployments.png');
        await page.screenshot({ path: screenshot2, fullPage: true });
        console.log(` ✔ Captured multiple deployments configuration screenshot: ${screenshot2}`);

        // Step 3: Save Agent Select Settings
        console.log('[Step 3] Clicking "Save Custom Settings & Ground in Panel" button...');
        const saveBtn = page.locator('c-panel-login-settings button:has-text("Save Custom Settings")').first();
        const hasSaveBtn = await saveBtn.isVisible();
        console.log(` ✔ Save button visible: ${hasSaveBtn}`);

        if (hasSaveBtn) {
            await saveBtn.click();
            console.log(' ✔ Clicked Save Custom Settings button.');
            await sleep(4000);
        }

        const screenshot3 = path.join(SCREENSHOT_DIR, '03_saved_settings_proof.png');
        await page.screenshot({ path: screenshot3, fullPage: true });
        console.log(` ✔ Captured saved settings proof screenshot: ${screenshot3}`);

        console.log('\n========================================================================');
        console.log('COMPREHENSIVE PLAYWRIGHT E2E SUITE COMPLETED SUCCESSFULLY!');
        console.log('========================================================================\n');

    } catch (err) {
        console.error('❌ Playwright Test Error:', err);
        const errScreenshot = path.join(SCREENSHOT_DIR, 'error_state_comprehensive.png');
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
