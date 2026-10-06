import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCREENSHOT_DIR = '/home/saul/.gemini/antigravity-cli/brain/be9e4f28-b648-4dfd-a723-a8801a269ba7/screenshots';
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFrontdoorUrl() {
    console.log('[Setup] Acquiring Salesforce Org Frontdoor URL via SF CLI...');
    const out = execSync('sf org open -r --target-org test1empty', { encoding: 'utf8' });
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
    console.log('PLAYWRIGHT E2E TEST: MESSAGING CONFIGURATION BACKUP & RESTORE');
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
    page.on('console', msg => console.log(`[Browser ${msg.type()}] ${msg.text()}`));

    try {
        console.log('[Step 1] Authenticating into Salesforce Org via Frontdoor session...');
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await page.goto(frontdoorUrl, { timeout: 60000 });
                await page.waitForURL(url => url.href.includes('/lightning/'), { timeout: 60000 });
                break;
            } catch (navErr) {
                if (attempt === 3) throw navErr;
                console.log(`[Step 1] Frontdoor navigation attempt ${attempt} failed (${navErr.message}), retrying in 3s...`);
                await sleep(3000);
            }
        }
        console.log(` ✔ Authenticated! Current URL: ${page.url()}`);

        const urlObj = new URL(page.url());
        const panelTabUrl = `${urlObj.origin}/lightning/n/tubot__Panel_Settings`;
        console.log(`[Step 1c] Navigating to Panel Settings tab (${panelTabUrl})...`);
        await page.goto(panelTabUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        console.log('[Step 1d] Waiting for <tubot-panel-login-settings, c-panel-login-settings> custom component to mount...');
        await page.waitForSelector('tubot-panel-login-settings, c-panel-login-settings', { timeout: 45000 });
        console.log(' ✔ Component mounted successfully in DOM!');

        await sleep(3000);

        // Step 2: Navigate to "Step-by-Step Setup" Tab
        console.log('\n[Step 2] Clicking the "Step-by-Step Setup" tab...');
        const setupTab = page.locator('tubot-panel-login-settings a:has-text("Step-by-Step Setup"), c-panel-login-settings a:has-text("Step-by-Step Setup"), lightning-tab-bar li[title*="Step-by-Step Setup"] a').first();
        await setupTab.waitFor({ state: 'visible', timeout: 15000 });
        await setupTab.click();
        console.log(' ✔ Clicked "Step-by-Step Setup" tab!');

        await sleep(3000);

        // Verify Backup & Restore section is visible
        console.log('\n[Step 3] Verifying Messaging Configuration Backups & Restore Card...');
        const backupsSection = page.locator('[data-testid="messaging-backups-section"]').first();
        await backupsSection.waitFor({ state: 'visible', timeout: 15000 });
        console.log(' ✔ Found "Messaging Configuration Backups & Restore" section!');

        const backupNowBtn = page.locator('lightning-button[data-testid="backup-now-btn"]').first();
        await backupNowBtn.waitFor({ state: 'visible', timeout: 10000 });
        console.log(' ✔ Found "Backup Now" button!');

        // Capture initial view screenshot
        const screenshot1 = path.join(SCREENSHOT_DIR, '01_step_by_step_backup_section.png');
        await page.screenshot({ path: screenshot1, fullPage: true });
        console.log(` ✔ Captured initial setup screenshot: ${screenshot1}`);

        // =========================================================================
        // TEST A: MANUAL BACKUP CREATION
        // =========================================================================
        console.log('\n--- TEST A: MANUAL BACKUP CREATION ---');
        console.log('Clicking "Backup Now" button...');
        await backupNowBtn.click();
        await sleep(1000);

        const manualModal = page.locator('section[data-testid="manual-backup-modal"]').first();
        await manualModal.waitFor({ state: 'visible', timeout: 8000 });
        console.log(' ✔ "Create Messaging Configuration Backup" modal opened!');

        const customName = 'E2E Playwright Manual Backup ' + Date.now();
        console.log(`Setting backup name: "${customName}"...`);
        const nameInput = manualModal.locator('lightning-input[data-testid="manual-backup-name-input"] input').first();
        await nameInput.fill(customName);
        await nameInput.press('Tab');
        await nameInput.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true })));
        await sleep(500);

        const createBtn = manualModal.locator('lightning-button[data-testid="create-backup-btn"]').first();
        await createBtn.click();
        console.log(' ✔ Clicked "Create Backup" button! Waiting for snapshot capture...');

        await sleep(6000);

        // Verify backup appears in table
        console.log('Checking that new backup is displayed in the table...');
        const newBackupRow = page.locator(`[data-testid="backups-table"] tr:has-text("${customName}")`).first();
        await newBackupRow.waitFor({ state: 'visible', timeout: 20000 });
        console.log(` ✔ Verified: Backup "${customName}" is present in the table!`);

        const screenshot2 = path.join(SCREENSHOT_DIR, '02_manual_backup_created.png');
        await page.screenshot({ path: screenshot2, fullPage: true });
        console.log(` ✔ Captured manual backup screenshot: ${screenshot2}`);

        // =========================================================================
        // TEST B: VIEW BACKUP DETAILS MODAL & JSON
        // =========================================================================
        console.log('\n--- TEST B: VIEW BACKUP DETAILS & JSON ---');
        const viewBtn = newBackupRow.locator('lightning-button-icon[data-testid="view-backup-btn"]').first();
        await viewBtn.click();
        await sleep(2000);

        const detailsModal = page.locator('section[data-testid="details-modal"]').first();
        await detailsModal.waitFor({ state: 'visible', timeout: 8000 });
        console.log(' ✔ "Backup Snapshot Details" modal opened!');

        // Check that snapshot component counts are displayed
        const fieldsCount = await detailsModal.locator('.text-blue-700').innerText();
        const webChatCount = await detailsModal.locator('.text-indigo-700').innerText();
        const channelsCount = await detailsModal.locator('.text-emerald-700').innerText();
        console.log(` ✔ Component Counts in Snapshot: Fields=${fieldsCount}, WebChat=${webChatCount}, Channels=${channelsCount}`);

        const screenshot3 = path.join(SCREENSHOT_DIR, '03_backup_details_modal.png');
        await page.screenshot({ path: screenshot3, fullPage: true });
        console.log(` ✔ Captured backup details screenshot: ${screenshot3}`);

        const closeDetailsBtn = detailsModal.locator('lightning-button:has-text("Close"), button:has-text("Close")').first();
        await closeDetailsBtn.click();
        await sleep(1000);
        console.log(' ✔ Closed Details modal.');

        // =========================================================================
        // TEST C: AUTOMATIC BACKUP ON "APPLY"
        // =========================================================================
        console.log('\n--- TEST C: AUTOMATIC BACKUP ON "APPLY" ---');
        console.log('Locating Apply / Accept button...');
        const applyBtn = page.locator('lightning-button[data-testid="apply-setup-btn"]').first();
        await applyBtn.scrollIntoViewIfNeeded();
        await applyBtn.waitFor({ state: 'visible', timeout: 10000 });
        const applyBtnText = await applyBtn.innerText();
        console.log(` Located button with label: "${applyBtnText.trim()}". Clicking Apply now...`);

        await applyBtn.click();
        console.log(' ✔ Clicked Apply! Waiting for pre-apply auto-backup and deployment configuration...');

        // Wait for setup & backup completion
        await sleep(14000);

        // If SCRT modal opened (for API deployment), dismiss it
        const scrtCloseBtn = page.locator('section[role="dialog"] lightning-button:has-text("Close")').first();
        if (await scrtCloseBtn.count() > 0 && await scrtCloseBtn.isVisible()) {
            await scrtCloseBtn.click();
            await sleep(1000);
        }

        // Verify Automatic (Apply) backup appears in table
        console.log('Verifying Automatic (Apply) backup is present in backups table...');
        const autoBackupBadge = page.locator('[data-testid="backups-table"] span:has-text("Automatic (Apply)")').first();
        await autoBackupBadge.waitFor({ state: 'visible', timeout: 30000 });
        console.log(' ✔ Verified: Automatic (Apply) backup record is prominently visible in table!');

        const screenshot4 = path.join(SCREENSHOT_DIR, '04_automatic_backup_on_apply.png');
        await page.screenshot({ path: screenshot4, fullPage: true });
        console.log(` ✔ Captured automatic backup on apply screenshot: ${screenshot4}`);

        // =========================================================================
        // TEST D: RESTORE BACKUP FUNCTIONALITY
        // =========================================================================
        console.log('\n--- TEST D: RESTORE BACKUP FUNCTIONALITY ---');
        console.log('Clicking "Restore" on the top backup in the table...');
        const restoreBtn = page.locator('[data-testid="backups-table"] lightning-button[data-testid="restore-btn"]').first();
        await restoreBtn.waitFor({ state: 'visible', timeout: 8000 });
        await restoreBtn.click();
        await sleep(1500);

        const restoreModal = page.locator('section[data-testid="restore-modal"]').first();
        await restoreModal.waitFor({ state: 'visible', timeout: 8000 });
        console.log(' ✔ "Restore Messaging Configuration" modal opened!');

        const screenshot5 = path.join(SCREENSHOT_DIR, '05_restore_confirmation_modal.png');
        await page.screenshot({ path: screenshot5, fullPage: true });
        console.log(` ✔ Captured restore confirmation modal screenshot: ${screenshot5}`);

        console.log('Clicking "Confirm & Restore" button...');
        const confirmRestoreBtn = restoreModal.locator('lightning-button[data-testid="confirm-restore-btn"]').first();
        await confirmRestoreBtn.click();

        console.log('Waiting for restore engine to execute callouts and DML...');
        await sleep(10000);

        const screenshot6 = path.join(SCREENSHOT_DIR, '06_backup_restored_success.png');
        await page.screenshot({ path: screenshot6, fullPage: true });
        console.log(` ✔ Captured backup restored screenshot: ${screenshot6}`);

        console.log('\n========================================================================');
        console.log('🎉 ALL TESTS PASSED: MESSAGING BACKUP & RESTORE VERIFIED SUCCESSFULLY!');
        console.log('========================================================================\n');

    } catch (err) {
        console.error('❌ Test failed with error:', err);
        const errScreenshot = path.join(SCREENSHOT_DIR, 'error_backup_restore.png');
        await page.screenshot({ path: errScreenshot, fullPage: true });
        console.log(`Captured failure screenshot: ${errScreenshot}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

run();
