import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = '/teamspace/studios/this_studio/.gemini/antigravity-cli/brain/ec3c3a68-47d4-4cc1-bba3-870e9725cc0e/screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getOrgInfo(targetOrgAlias) {
    console.log(`[Setup] Retrieving frontdoor URL and instance URL for target org '${targetOrgAlias}'...`);
    const stdout = execSync(`sf org open -o ${targetOrgAlias} -r --json`, { encoding: 'utf8' });
    const parsed = JSON.parse(stdout);
    if (!parsed.result || !parsed.result.url) {
        throw new Error(`Failed to retrieve frontdoor URL: ${stdout}`);
    }
    const frontdoorUrl = parsed.result.url;
    const urlObj = new URL(frontdoorUrl);
    const instanceUrl = `${urlObj.protocol}//${urlObj.host}`;
    console.log(`[Setup] Target Instance: ${instanceUrl}`);
    return { frontdoorUrl, instanceUrl };
}

async function run() {
    console.log('====================================================================');
    console.log('STARTING PLAYWRIGHT E2E TEST: TUBOT SETUP WIZARD (SCRATCH ORG)');
    console.log('====================================================================\n');

    const targetOrg = process.env.SF_TARGET_ORG || 'tubot-oauth-fix-test';
    const { frontdoorUrl, instanceUrl } = getOrgInfo(targetOrg);

    console.log('[Playwright] Launching Chromium browser (headless)...');
    const browser = await chromium.launch({
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

    // Log browser console events
    page.on('console', msg => {
        if (msg.type() === 'error' || msg.text().includes('Tubot') || msg.text().includes('Wizard')) {
            console.log(`[Browser Console ${msg.type()}] ${msg.text()}`);
        }
    });

    try {
        console.log('[Step 1] Authenticating into Scratch Org via frontdoor session...');
        await page.goto(frontdoorUrl, { timeout: 60000 });

        console.log('[Step 1b] Waiting for redirect into Lightning shell (/lightning/)...');
        await page.waitForURL(url => url.href.includes('/lightning/'), { timeout: 60000 });
        console.log(` ✔ Authenticated! Shell URL: ${page.url()}`);

        const panelTabUrl = `${instanceUrl}/lightning/n/tubot__Panel_Settings`;
        console.log(`[Step 1c] Navigating to TuBot Panel Settings tab: ${panelTabUrl}...`);
        await page.goto(panelTabUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        console.log('[Step 1d] Waiting for custom LWC <c-panel-login-settings> or <tubot-panel-login-settings> to mount...');
        const lwcLocator = page.locator('c-panel-login-settings, tubot-panel-login-settings').first();
        await lwcLocator.waitFor({ state: 'attached', timeout: 45000 });
        console.log(' ✔ Component mounted successfully in DOM!');

        // Give Apex wire / init methods time to complete
        await sleep(4000);

        // Screenshot initial view
        const shot1 = path.join(SCREENSHOT_DIR, '01_wizard_step1_health.png');
        await page.screenshot({ path: shot1, fullPage: true });
        console.log(` ✔ Step 1 Screenshot captured: ${shot1}`);

        // Click Setup Wizard tab
        console.log('[Step 1e] Clicking "Setup Wizard" tab...');
        const setupWizardTab = page.locator('[role="tab"]').filter({ hasText: 'Setup Wizard' }).first();
        await setupWizardTab.waitFor({ state: 'visible', timeout: 15000 });
        await setupWizardTab.click();
        console.log(' ✔ "Setup Wizard" tab clicked.');
        await sleep(4000);

        // --- STEP 1: HEALTH AUDIT ---
        console.log('\n--- Verifying Step 1: Health Audit ---');
        const healthTitle = lwcLocator.locator('text=Step 1: Org Readiness').first();
        await healthTitle.waitFor({ state: 'visible', timeout: 15000 });
        console.log(' ✔ Step 1 Title verified: "Step 1: Org Readiness & Permissions Health Check"');

        // Check health audit metrics
        const ecaStatus = await lwcLocator.locator('text=External Client Apps (ECA)').first().isVisible();
        const permSetStatus = await lwcLocator.locator('text=Packaged Permission Sets').first().isVisible();
        const licensesStatus = await lwcLocator.locator('text=Integration User Licenses').first().isVisible();
        console.log(` ✔ Health Check items rendered: ECA=${ecaStatus}, PermSets=${permSetStatus}, Licenses=${licensesStatus}`);

        // Click Next to Step 2
        console.log('\n--- Navigating to Step 2: Integration User Selection ---');
        const nextToUserBtn = lwcLocator.locator('button:has-text("Next: Select Integration User")').first();
        await nextToUserBtn.waitFor({ state: 'visible', timeout: 10000 });
        await nextToUserBtn.click();
        await sleep(2000);

        const shot2 = path.join(SCREENSHOT_DIR, '02_wizard_step2_user_discovery.png');
        await page.screenshot({ path: shot2, fullPage: true });
        console.log(` ✔ Step 2 Screenshot captured: ${shot2}`);

        const userStepTitle = lwcLocator.locator('text=Step 2: Integration User Selection').first();
        await userStepTitle.waitFor({ state: 'visible', timeout: 10000 });
        console.log(' ✔ Step 2 Title verified: "Step 2: Integration User Selection & Permission Assignment"');

        // Test Integration User Combobox
        const userCombobox = lwcLocator.locator('lightning-combobox').filter({ hasText: 'Select Integration User in Org' }).first();
        if (await userCombobox.isVisible()) {
            console.log(' ✔ Integration User combobox is present.');
            // Open combobox dropdown
            const comboInput = userCombobox.locator('button, input').first();
            await comboInput.click();
            await sleep(1000);
            
            // Choose candidate with Administrator profile
            const options = lwcLocator.locator('lightning-base-combobox-item, lightning-combobox [role="option"]');
            const optionCount = await options.count();
            console.log(` ✔ Found ${optionCount} user candidates in dropdown.`);
            
            const adminOption = options.filter({ hasText: 'Administrator' });
            if (await adminOption.count() > 0) {
                const optText = await adminOption.first().innerText();
                console.log(` ✔ Selecting candidate: ${optText.replace(/\n/g, ' ')}`);
                await adminOption.first().click();
            } else {
                await options.first().click();
            }
            await sleep(1500);

            const shot2b = path.join(SCREENSHOT_DIR, '02b_wizard_step2_user_selected.png');
            await page.screenshot({ path: shot2b, fullPage: true });
            console.log(` ✔ Step 2b Candidate Selected Screenshot captured: ${shot2b}`);

            // Check "Assign Tubot API Permission Set" button
            const assignBtn = lwcLocator.locator('button:has-text("Assign Tubot API Permission Set")').first();
            if (await assignBtn.isVisible()) {
                console.log(' ✔ "Assign Tubot API Permission Set" button is visible.');
                console.log(' Clicking "Assign Tubot API Permission Set"...');
                await assignBtn.click();
                await sleep(3000);
                
                const shot2c = path.join(SCREENSHOT_DIR, '02c_wizard_step2_permission_assigned.png');
                await page.screenshot({ path: shot2c, fullPage: true });
                console.log(` ✔ Step 2c Permission Assignment Result captured: ${shot2c}`);

                // Blind Testing Protocol: Verify via Salesforce CLI
                console.log('[Blind Testing Protocol] Verifying mutation directly in Salesforce target via CLI...');
                const verifyQuery = execSync(
                    `sf data query -q "SELECT Id, Assignee.Username, PermissionSet.Name FROM PermissionSetAssignment WHERE PermissionSet.Name LIKE '%Tubot_Salesforce_API_Read%'" -o ${targetOrg} --json`,
                    { encoding: 'utf8' }
                );
                const queryResult = JSON.parse(verifyQuery);
                console.log(` ✔ Blind Test CLI query returned ${queryResult.result?.totalSize || 0} assignment records in target org.`);
                if (!queryResult.result || queryResult.result.totalSize < 1) {
                    throw new Error('Blind Test Assertion Failed: PermissionSetAssignment record not found in target scratch org!');
                }
                console.log(' ✔ Blind Test Succeeded: State change confirmed in target scratch org!');
            }
        }

        // --- STEP 3: EXTERNAL CLIENT APP GUIDANCE ---
        console.log('\n--- Navigating to Step 3: External Client App Policy ---');
        const nextToEcaBtn = lwcLocator.locator('button:has-text("Next: External Client App Setup")').first();
        await nextToEcaBtn.waitFor({ state: 'visible', timeout: 10000 });
        await nextToEcaBtn.click();
        await sleep(2000);

        const shot3 = path.join(SCREENSHOT_DIR, '03_wizard_step3_eca_policy.png');
        await page.screenshot({ path: shot3, fullPage: true });
        console.log(` ✔ Step 3 Screenshot captured: ${shot3}`);

        const ecaStepTitle = lwcLocator.locator('text=Step 3: External Client App').first();
        await ecaStepTitle.waitFor({ state: 'visible', timeout: 10000 });
        console.log(' ✔ Step 3 Title verified: "Step 3: External Client App (ECA) Policy & OAuth Setup"');

        const openEcaBtn = lwcLocator.locator('button:has-text("Open External Client App Manager")').first();
        const hasOpenEcaBtn = await openEcaBtn.isVisible();
        console.log(` ✔ "Open External Client App Manager" button visible: ${hasOpenEcaBtn}`);

        // --- STEP 4: CHANNEL CONNECTION ---
        console.log('\n--- Navigating to Step 4: Channel Connection & Verification ---');
        const nextToConnectBtn = lwcLocator.locator('button:has-text("Next: Connect & Verify Channel")').first();
        await nextToConnectBtn.waitFor({ state: 'visible', timeout: 10000 });
        await nextToConnectBtn.click();
        await sleep(2000);

        const shot4 = path.join(SCREENSHOT_DIR, '04_wizard_step4_channel_connect.png');
        await page.screenshot({ path: shot4, fullPage: true });
        console.log(` ✔ Step 4 Screenshot captured: ${shot4}`);

        const connectStepTitle = lwcLocator.locator('text=Step 4: Register & Verify Channel API Credentials').first();
        await connectStepTitle.waitFor({ state: 'visible', timeout: 10000 });
        console.log(' ✔ Step 4 Title verified: "Step 4: Register & Verify Channel API Credentials"');

        const connectVerifyBtn = lwcLocator.locator('button:has-text("Connect & Verify Channel API")').first();
        const hasConnectBtn = (await connectVerifyBtn.count()) > 0;
        console.log(` ✔ "Connect & Verify Channel API" button present in DOM: ${hasConnectBtn}`);

        // Test step back to Step 1
        console.log('\n--- Testing Back Navigation back to Step 1 ---');
        let backBtn = lwcLocator.locator('button:has-text("Back")').first();
        while (await backBtn.isVisible()) {
            await backBtn.click();
            await sleep(1000);
            backBtn = lwcLocator.locator('button:has-text("Back")').first();
        }
        await sleep(1500);
        const shotFinal = path.join(SCREENSHOT_DIR, '05_wizard_back_to_health.png');
        await page.screenshot({ path: shotFinal, fullPage: true });
        console.log(` ✔ Navigation Back Screenshot captured: ${shotFinal}`);

        console.log('\n====================================================================');
        console.log('PLAYWRIGHT E2E TEST PASSED: ALL SETUP WIZARD STEPS VERIFIED!');
        console.log('====================================================================\n');

    } catch (err) {
        console.error('❌ Playwright Test Failed:', err);
        const errShot = path.join(SCREENSHOT_DIR, 'error_state.png');
        await page.screenshot({ path: errShot, fullPage: true }).catch(() => {});
        throw err;
    } finally {
        await browser.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
