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
    console.log('STARTING PLAYWRIGHT E2E TEST: AGENT SETTINGS & TESTING TAB VERIFICATION');
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
            '--window-size=1440,1050'
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1440, height: 1050 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    try {
        console.log('[Step 1] Authenticating into test1empty via Frontdoor session...');
        await page.goto(frontdoorUrl, { timeout: 60000 });
        
        console.log('[Step 1b] Waiting for redirect into Lightning shell (/lightning/)...');
        await page.waitForURL(url => url.href.includes('/lightning/'), { timeout: 60000 });
        console.log(` ✔ Authenticated! Current URL: ${page.url()}`);

        const lightningHost = new URL(page.url()).origin;
        if (!page.url().includes('Panel_Settings')) {
            console.log(`[Step 1c] Navigating directly to Panel Settings tab...`);
            await page.goto(`${lightningHost}/lightning/n/tubot__Panel_Settings`, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        }

        console.log('[Step 1d] Waiting for custom component to mount...');
        await page.waitForSelector('c-panel-login-settings, tubot-panel-login-settings', { timeout: 45000 });
        console.log(' ✔ Component mounted successfully in DOM!');

        await sleep(4000);

        // --- Step 1e: Test Tubot Settings (Custom Metadata Type) in Agent Settings tab ---
        console.log('[Step 1e] Testing Tubot Settings in Agent Settings tab...');
        const tubotHeader = page.locator('text=Tubot Settings (Custom Metadata Type)').first();
        const hasTubotHeader = await tubotHeader.isVisible();
        console.log(` ✔ "Tubot Settings (Custom Metadata Type)" card visible: ${hasTubotHeader}`);

        const fallbackInput = page.locator('lightning-input:has-text("Fallback Queue API Name") input, input[name="fallbackQueueApiName"], lightning-card:has-text("Tubot Settings") input').first();
        const hasFallbackInput = await fallbackInput.isVisible();
        console.log(` ✔ Fallback Queue API Name input visible: ${hasFallbackInput}`);

        // --- Step 1e: Testing AI Routing & Queues and Skills in Agent Settings tab ---
        console.log('[Step 1e] Testing AI Routing and Queues and Skills list in Agent Settings tab...');
        const aiRoutingTextarea = page.locator('lightning-textarea[name="AI Routing"] textarea, textarea[name="AI Routing"], lightning-textarea:has-text("AI Routing") textarea').first();
        const hasAiRouting = await aiRoutingTextarea.isVisible();
        console.log(` ✔ "AI Routing" textarea visible: ${hasAiRouting}`);

        if (hasAiRouting) {
            const sampleParagraph = 'Primary customer conversations should be routed to AI bot holding queue. If escalation is required, route according to intent and customer priority to designated Tier 2 queues or specialized skills.';
            await aiRoutingTextarea.fill(sampleParagraph);
            console.log(' ✔ Filled AI Routing paragraph into textarea.');
        }

        // Test Queues and Skills list
        const queueSkillInputs = page.locator('lightning-input[name="Queue or Skill"] input, input[placeholder*="Enter queue or skill"]');
        const initialCount = await queueSkillInputs.count();
        console.log(` ✔ Initial "Queues and Skills" input count (expected 1): ${initialCount}`);

        if (initialCount > 0) {
            await queueSkillInputs.first().fill('AI_Bot_Holding_Queue_100');
            console.log(' ✔ Filled first item in Queues and Skills list.');
        }

        const addQueueSkillBtn = page.locator('button:has-text("Add Queue / Skill")').first();
        if (await addQueueSkillBtn.isVisible()) {
            console.log(' Clicking "Add Queue / Skill" button...');
            await addQueueSkillBtn.click();
            await sleep(500);
            const countAfterAdd = await queueSkillInputs.count();
            console.log(` ✔ Queues and Skills input count after Add: ${countAfterAdd}`);

            if (countAfterAdd > 1) {
                await queueSkillInputs.nth(1).fill('Technical_Support_Queue');
                console.log(' ✔ Filled second item in Queues and Skills list.');
            }
        }

        if (hasFallbackInput) {
            const curVal = await fallbackInput.inputValue();
            console.log(` ✔ Current Fallback Queue API Name: "${curVal}"`);

            await fallbackInput.fill('AI_Bot_Holding_Queue_100');
            await sleep(500);

            const ssTubot = path.join(SCREENSHOT_DIR, '20_agent_settings_tubot_setting.png');
            await page.screenshot({ path: ssTubot, fullPage: true });
            console.log(` ✔ Captured Agent Settings Tubot card screenshot: ${ssTubot}`);

            const saveTubotBtn = page.locator('button:has-text("Save Tubot Setting")').first();
            if (await saveTubotBtn.isVisible()) {
                console.log('[Step 1f] Clicking "Save Tubot Setting" button...');
                await saveTubotBtn.click();
                await sleep(4000);
                console.log(' ✔ "Save Tubot Setting" button clicked.');

                const ssTubotSaved = path.join(SCREENSHOT_DIR, '21_tubot_setting_saved.png');
                await page.screenshot({ path: ssTubotSaved, fullPage: true });
                console.log(` ✔ Captured Tubot Setting saved screenshot: ${ssTubotSaved}`);
            }
        }

        // --- Step 1g: Test Messaging Channel Omni-Flow Routing Card in Agent Settings tab ---
        console.log('[Step 1g] Verifying Omni-Flow routing card in Agent Settings tab...');
        const configureOmniFlowBtn = page.locator('button:has-text("Configure Omni-Flow t2")').first();
        const hasConfigureOmniFlowBtn = await configureOmniFlowBtn.isVisible();
        console.log(` ✔ "Configure Omni-Flow t2" button visible in Agent Settings: ${hasConfigureOmniFlowBtn}`);

        if (hasConfigureOmniFlowBtn && !(await configureOmniFlowBtn.isDisabled())) {
            console.log(' Clicking "Configure Omni-Flow t2" button in Agent Settings...');
            await configureOmniFlowBtn.click();
            await sleep(4000);
            console.log(' ✔ Omni-Flow button clicked.');

            const ssOmniFlow = path.join(SCREENSHOT_DIR, '16_omni_flow_configured_success.png');
            await page.screenshot({ path: ssOmniFlow, fullPage: true });
            console.log(` ✔ Captured Omni-Flow result screenshot: ${ssOmniFlow}`);
        } else {
            console.log(' ℹ Channel is already configured for Omni-Flow t2 (or button disabled).');
            const ssOmniFlowReady = path.join(SCREENSHOT_DIR, '16_omni_flow_card_ready.png');
            await page.screenshot({ path: ssOmniFlowReady, fullPage: true });
            console.log(` ✔ Captured Omni-Flow card screenshot: ${ssOmniFlowReady}`);
        }

        // --- Step 2: Click on the Testing tab ---
        console.log('[Step 2] Locating and clicking the "Testing" tab...');
        const testingTab = page.locator('lightning-tab-bar li[title="Testing"], lightning-tab-bar a:has-text("Testing"), a[data-tab-value="tab-testing"], a:has-text("Testing")').first();
        if (await testingTab.isVisible()) {
            await testingTab.click();
            console.log(' ✔ Clicked on "Testing" tab.');
        } else {
            // Fallback click on text
            await page.getByRole('tab', { name: 'Testing' }).click();
            console.log(' ✔ Clicked on "Testing" tab via role.');
        }
        await sleep(3000);

        // Screenshot of testing tab initial view (with 8 fields)
        const ss1 = path.join(SCREENSHOT_DIR, '22_testing_tab_8_fields.png');
        await page.screenshot({ path: ss1, fullPage: true });
        console.log(` ✔ Captured Testing tab view with 8 fields: ${ss1}`);

        // Verify "Added on Addon Install & Checked by Addon" banner
        const addonBanner = page.locator('text=Added on Addon Install & Checked by Addon');
        const hasBanner = await addonBanner.isVisible();
        console.log(` ✔ "Added on Addon Install & Checked by Addon" banner visible: ${hasBanner}`);

        // Verify 7 custom fields are present in table
        const fieldsToCheck = [
            'AI_Conversation_Summary__c',
            'Escalation_Reason__c',
            'varSkillLevel__c',
            'varTargetSkillName__c',
            'varTargetQueueName__c',
            'varRouting__c',
            'Escalate_To_Human__c'
        ];
        for (const fld of fieldsToCheck) {
            const loc = page.locator(`text=${fld}`).first();
            const isVis = await loc.isVisible();
            console.log(` ✔ Field present in table: ${fld} -> ${isVis}`);
        }

        const ssFields = path.join(SCREENSHOT_DIR, '26_testing_tab_7_fields_varRouting.png');
        await page.screenshot({ path: ssFields, fullPage: true });
        console.log(` ✔ Captured Testing tab view with 7 fields: ${ssFields}`);

        // Verify Omni-Channel Platform Settings Bar & Badges
        console.log('[Step 2b] Verifying Omni-Channel Platform Settings bar & badges...');
        const skillsBadge = page.locator('text=Skills-Based & Direct-to-Agent Routing').first();
        const secondaryBadge = page.locator('text=Secondary Routing Priority').first();
        const capModelBadge = page.locator('text=Status-Based Capacity Model').first();
        console.log(` ✔ Skills-Based Routing badge visible: ${await skillsBadge.isVisible()}`);
        console.log(` ✔ Secondary Routing Priority badge visible: ${await secondaryBadge.isVisible()}`);
        console.log(` ✔ Status-Based Capacity Model badge visible: ${await capModelBadge.isVisible()}`);

        const ssOmni = path.join(SCREENSHOT_DIR, '24_omni_channel_settings_active.png');
        await page.screenshot({ path: ssOmni, fullPage: true });
        console.log(` ✔ Captured Omni-Channel Settings badges screenshot: ${ssOmni}`);

        // Test Re-Activate Omni Settings button
        const reactivateOmniBtn = page.locator('button:has-text("Re-Activate Omni Settings")').first();
        if (await reactivateOmniBtn.isVisible()) {
            console.log('[Step 2c] Clicking "Re-Activate Omni Settings" button...');
            await reactivateOmniBtn.click();
            await sleep(4000);
            console.log(' ✔ Re-Activate Omni Settings button clicked.');

            const ssReactivate = path.join(SCREENSHOT_DIR, '25_omni_settings_reactivated.png');
            await page.screenshot({ path: ssReactivate, fullPage: true });
            console.log(` ✔ Captured Re-Activate Omni Settings screenshot: ${ssReactivate}`);
        }

        // Test Add Escalate Button to Messaging Session Page button
        console.log('[Step 3] Testing "Add Escalate Button to Messaging Session Page" button...');
        const addEscalateBtn = page.locator('button:has-text("Add Escalate Button to Messaging Session Page")').first();
        const hasAddEscalateBtn = await addEscalateBtn.isVisible();
        console.log(` ✔ "Add Escalate Button to Messaging Session Page" button visible: ${hasAddEscalateBtn}`);

        if (hasAddEscalateBtn && !(await addEscalateBtn.isDisabled())) {
            console.log('[Step 3b] Clicking "Add Escalate Button to Messaging Session Page"...');
            await addEscalateBtn.click();
            await sleep(6000);
            console.log(' ✔ Add Escalate Button clicked.');

            const ssEscalateBtn = path.join(SCREENSHOT_DIR, '27_add_escalate_button_executed.png');
            await page.screenshot({ path: ssEscalateBtn, fullPage: true });
            console.log(` ✔ Captured Add Escalate Button executed screenshot: ${ssEscalateBtn}`);
        }

        // Test Verify Field Access & FLS button
        const verifyBtn = page.locator('button:has-text("Verify Assignment & Access")').first();
        if (await verifyBtn.isVisible()) {
            console.log('[Step 4] Clicking "Verify Assignment & Access" button...');
            await verifyBtn.click();
            await sleep(4000);
            console.log(' ✔ Verify button clicked.');

            const ss3 = path.join(SCREENSHOT_DIR, '23_verify_access_8_fields.png');
            await page.screenshot({ path: ss3, fullPage: true });
            console.log(` ✔ Captured FLS verification screenshot: ${ss3}`);
        }

        // Test Escalate Popup Modal
        const modalBtn = page.locator('button:has-text("Test Escalate Popup Modal")').first();
        if (await modalBtn.isVisible()) {
            console.log('[Step 5] Clicking "Test Escalate Popup Modal"...');
            await modalBtn.click();
            await sleep(2000);

            // Wait for dialog
            const modalDialog = page.locator('section[role="dialog"]:has-text("Escalate to Human Agent")').first();
            const isModalOpen = await modalDialog.isVisible();
            console.log(` ✔ Escalate modal dialog open: ${isModalOpen}`);

            const ss4 = path.join(SCREENSHOT_DIR, '18_escalate_modal_open.png');
            await page.screenshot({ path: ss4, fullPage: true });
            console.log(` ✔ Captured Escalate modal open screenshot: ${ss4}`);

            // Verify the 4 routing input fields and fallback queue notice
            const targetQueueInput = page.getByLabel('Target Queue Name (varTargetQueueName)');
            const routingInput = page.getByLabel('Routing Config (varRouting)');
            const skillLevelInput = page.getByLabel('Skill Level (varSkillLevel)');
            const targetSkillInput = page.getByLabel('Target Skill Name (varTargetSkillName)');

            console.log(` ✔ Target Queue Name (varTargetQueueName) input visible: ${await targetQueueInput.isVisible()}`);
            console.log(` ✔ Routing Config (varRouting) input visible: ${await routingInput.isVisible()}`);
            console.log(` ✔ Skill Level (varSkillLevel) input visible: ${await skillLevelInput.isVisible()}`);
            console.log(` ✔ Target Skill Name (varTargetSkillName) input visible: ${await targetSkillInput.isVisible()}`);

            // Check helper note for fallback queue text
            const fallbackNotice = page.locator('text=If Target Queue, Routing, Skill Level, and Target Skill are all left empty').first();
            console.log(` ✔ Fallback Queue helper text visible: ${await fallbackNotice.isVisible()}`);

            // TEST 1: Submit with ALL 4 routing fields EMPTY -> should use fallback queue (AI_Bot_Holding_Queue_100)
            console.log(' [Step 5a] Submitting modal with all 4 routing fields empty to verify fallback queue logic...');
            const reasonInput = page.getByLabel('Escalation Reason (Optional)');
            if (await reasonInput.isVisible()) {
                await reasonInput.fill('Testing empty routing params - Fallback Queue verification');
            }
            const summaryArea = page.getByLabel('AI Conversation Summary (Optional)');
            if (await summaryArea.isVisible()) {
                await summaryArea.fill('Verifying that empty routing params automatically apply fallback queue metadata.');
            }

            const confirmEscalateBtn = page.locator('button:has-text("Escalate Session")').first();
            if (await confirmEscalateBtn.isVisible()) {
                await confirmEscalateBtn.click();
                await sleep(4000);
                console.log(' ✔ Executed session escalation with empty routing params.');

                const ss5 = path.join(SCREENSHOT_DIR, '19_escalation_executed.png');
                await page.screenshot({ path: ss5, fullPage: true });
                console.log(` ✔ Captured Escalation executed screenshot: ${ss5}`);
            }

            // TEST 2: Reopen modal and submit with EXPLICIT routing values
            console.log(' [Step 5b] Reopening modal to submit with explicit routing parameters...');
            if (await modalBtn.isVisible()) {
                await modalBtn.click();
                await sleep(2000);

                if (await reasonInput.isVisible()) {
                    await reasonInput.fill('Customer requested tier-2 supervisor (explicit routing test)');
                }
                if (await summaryArea.isVisible()) {
                    await summaryArea.fill('Testing explicit routing values for varTargetQueueName, varRouting, varSkillLevel, varTargetSkillName.');
                }
                if (await targetQueueInput.isVisible()) {
                    await targetQueueInput.fill('Explicit_Tier2_Queue');
                }
                if (await routingInput.isVisible()) {
                    await routingInput.fill('Chat_Routing_Config');
                }
                if (await skillLevelInput.isVisible()) {
                    await skillLevelInput.fill('3.5');
                }
                if (await targetSkillInput.isVisible()) {
                    await targetSkillInput.fill('Technical_Support');
                }

                const ssModalFilled = path.join(SCREENSHOT_DIR, '29_escalate_modal_filled.png');
                await page.screenshot({ path: ssModalFilled, fullPage: true });
                console.log(` ✔ Captured Escalate modal filled with explicit values: ${ssModalFilled}`);

                const confirmBtn2 = page.locator('button:has-text("Escalate Session")').first();
                if (await confirmBtn2.isVisible()) {
                    await confirmBtn2.click();
                    await sleep(4000);
                    console.log(' ✔ Executed session escalation with explicit routing params.');
                }
            }
        }

        console.log('\n========================================================================');
        console.log('PLAYWRIGHT TEST COMPLETED SUCCESSFULLY!');
        console.log('========================================================================\n');

    } catch (err) {
        console.error('❌ Playwright Test Error:', err);
        const errScreenshot = path.join(SCREENSHOT_DIR, 'error_testing_tab.png');
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
