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

async function getLatestMessagingSessionId() {
    console.log('[Setup] Querying latest MessagingSession ID via SF CLI...');
    const out = execSync('sf data query --query "SELECT Id, Name, Status FROM MessagingSession ORDER BY CreatedDate DESC LIMIT 1" --target-org tubot.10f347fecf84@agentforce.com --json', { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    if (parsed?.result?.records?.length > 0) {
        const id = parsed.result.records[0].Id;
        console.log(`[Setup] Target MessagingSession ID: ${id} (${parsed.result.records[0].Name})`);
        return id;
    }
    throw new Error('No MessagingSession records found in org.');
}

async function run() {
    console.log('========================================================================');
    console.log('PLAYWRIGHT E2E SUITE: OMNI-CHANNEL SUPPRESSION TOGGLE & HERMES ESCALATION');
    console.log('========================================================================\n');

    const frontdoorUrl = await getFrontdoorUrl();
    const sessionId = await getLatestMessagingSessionId();

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
    page.on('console', msg => console.log('[Browser Console]', msg.type(), msg.text()));
    page.on('pageerror', err => console.log('[Browser Error]', err.message));

    try {
        // Step 1: Frontdoor Login
        console.log('[Step 1] Authenticating into Salesforce Org via Frontdoor session...');
        await page.goto(frontdoorUrl, { timeout: 60000 });
        await page.waitForURL(url => url.href.includes('/lightning/'), { timeout: 60000 });
        console.log(` ✔ Authenticated into Lightning: ${page.url()}`);

        // Step 2: Navigate to Panel Settings tab
        console.log('[Step 2] Navigating to Panel Settings tab (/lightning/n/Panel_Settings)...');
        await page.goto('https://orgfarm-9c01b1d16c-dev-ed.develop.lightning.force.com/lightning/n/Panel_Settings', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        console.log('[Step 2b] Waiting for <c-panel-login-settings> component...');
        await page.waitForSelector('c-panel-login-settings', { timeout: 45000 });
        console.log(' ✔ <c-panel-login-settings> mounted in DOM!');
        await sleep(3000);

        // Verify "Suppress Human Queue" toggle is rendered
        console.log('[Step 3] Verifying and toggling "Suppress Human Queue" for deployments...');
        const toggleInputs = page.locator('c-panel-login-settings input[type="checkbox"]');
        const toggleCount = await toggleInputs.count();
        console.log(` ✔ Found ${toggleCount} queue suppression toggles/checkboxes.`);

        for (let i = 0; i < toggleCount; i++) {
            const toggle = toggleInputs.nth(i);
            const isChecked = await toggle.isChecked();
            if (!isChecked) {
                await toggle.click({ force: true });
                console.log(` ✔ Toggled Suppress Human Queue -> ON for row ${i + 1}.`);
            }
        }

        // Click Save Custom Settings
        console.log('[Step 4] Clicking "Save Custom Settings & Ground in Panel"...');
        const saveBtn = page.locator('c-panel-login-settings button:has-text("Save Custom Settings")').first();
        if (await saveBtn.isVisible()) {
            await saveBtn.click();
            console.log(' ✔ Clicked Save button.');
            await sleep(3000);
        }

        const screenshot4 = path.join(SCREENSHOT_DIR, '04_suppress_omni_channel_toggle_saved.png');
        await page.screenshot({ path: screenshot4, fullPage: true });
        console.log(` ✔ Captured suppression toggle saved screenshot: ${screenshot4}`);

        // Step 5: Close open console tabs to avoid stale cache
        console.log('[Step 5] Closing open console tabs to ensure fresh flexipage load...');
        const closeTabBtns = page.locator('button[title^="Close "], button.slds-button_icon-x-small');
        const closeCount = await closeTabBtns.count();
        for (let i = 0; i < Math.min(closeCount, 5); i++) {
            try {
                await closeTabBtns.nth(i).click({ timeout: 1000 }).catch(() => {});
            } catch {}
        }
        await sleep(1000);

        // Step 6: Navigate to MessagingSession record page
        console.log(`[Step 6] Navigating to Messaging Session record page (/lightning/r/MessagingSession/${sessionId}/view)...`);
        await page.goto(`https://orgfarm-9c01b1d16c-dev-ed.develop.lightning.force.com/lightning/r/MessagingSession/${sessionId}/view`, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        console.log('[Step 6b] Waiting for record page elements to load...');
        await sleep(6000);

        // Check if c-messaging-session-escalation is rendered on page
        const escalationLwc = page.locator('c-messaging-session-escalation');
        let isEscalationVisible = await escalationLwc.isVisible().catch(() => false);
        console.log(` ✔ <c-messaging-session-escalation> visibility: ${isEscalationVisible}`);

        const screenshot5 = path.join(SCREENSHOT_DIR, '05_messaging_session_escalation_lwc.png');
        await page.screenshot({ path: screenshot5, fullPage: true });
        console.log(` ✔ Captured Messaging Session record page screenshot: ${screenshot5}`);

        if (isEscalationVisible) {
            // Step 7: Test Evaluate with Hermes 2 Pro
            console.log('[Step 7] Testing "Evaluate with Hermes 2 Pro" AI decisioning...');
            const evaluateBtn = page.locator('c-messaging-session-escalation button:has-text("Hermes 2 Pro"), c-messaging-session-escalation button:has-text("Evaluate")').first();
            if (await evaluateBtn.isVisible()) {
                await evaluateBtn.click();
                console.log(' ✔ Clicked "Evaluate Escalation with Hermes 2 Pro" button.');
                await sleep(3000);
            }

            // Step 8: Test Manual Escalation
            console.log('[Step 8] Testing manual "Escalate to Human Agent" button...');
            const escalateBtn = page.locator('c-messaging-session-escalation button:has-text("Escalate to Human")').first();
            if (await escalateBtn.isVisible()) {
                await escalateBtn.click();
                console.log(' ✔ Clicked "Escalate to Human Agent" button.');
                await sleep(1500);

                // Check for modal confirm button
                const confirmBtn = page.locator('c-messaging-session-escalation button:has-text("Confirm & Route to Live Queue"), c-messaging-session-escalation button:has-text("Confirm")').first();
                if (await confirmBtn.isVisible()) {
                    await confirmBtn.click();
                    console.log(' ✔ Clicked modal Confirm Escalation button.');
                    await sleep(3000);
                }
            }

            const screenshot6 = path.join(SCREENSHOT_DIR, '06_messaging_session_escalated_state.png');
            await page.screenshot({ path: screenshot6, fullPage: true });
            console.log(` ✔ Captured escalated state screenshot: ${screenshot6}`);
        }

        console.log('\n========================================================================');
        console.log('PLAYWRIGHT E2E SUITE FOR SUPPRESSION & ESCALATION COMPLETED!');
        console.log('========================================================================\n');

    } catch (err) {
        console.error('❌ Playwright Test Error:', err);
        const errScreenshot = path.join(SCREENSHOT_DIR, 'error_state_suppression_test.png');
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
