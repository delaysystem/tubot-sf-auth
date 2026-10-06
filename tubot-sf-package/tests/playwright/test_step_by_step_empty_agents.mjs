import { chromium } from 'playwright-core';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ARTIFACT_DIR = '/teamspace/studios/this_studio/.gemini/antigravity-cli/brain/b08b8d32-f879-4c0e-a02f-d223506f42e5';
const SCREENSHOT_DIR = path.join(ARTIFACT_DIR, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFrontdoorUrl(orgAlias = 'test1empty') {
    const out = execSync(`sf org open -r --target-org ${orgAlias}`, { encoding: 'utf8' });
    const match = out.match(/https:\/\/[^\s]+\/secur\/frontdoor\.jsp\?[^\s]+/);
    if (!match) {
        throw new Error('Failed to parse frontdoor URL from output: ' + out);
    }
    return match[0].trim();
}

async function run() {
    console.log('--- Checking Step-by-Step Setup Tab for No Fake Agents ---');
    const frontdoorUrl = await getFrontdoorUrl('test1empty');

    const browser = await chromium.launch({
        executablePath: '/usr/bin/google-chrome',
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();

    try {
        await page.goto(frontdoorUrl, { timeout: 60000 });
        await page.waitForURL(url => url.href.includes('/lightning/'), { timeout: 60000 });
        const host = new URL(page.url()).origin;
        await page.goto(`${host}/lightning/n/tubot__Panel_Settings`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('c-panel-login-settings, tubot-panel-login-settings', { timeout: 45000 });
        await sleep(3000);

        // Click "Step-by-Step Setup" tab
        const setupTab = page.locator('a:has-text("Step-by-Step Setup")').first();
        await setupTab.click();
        await sleep(2000);

        // Screenshot
        const ssPath = path.join(SCREENSHOT_DIR, '28_step_by_step_no_fake_agents.png');
        await page.screenshot({ path: ssPath, fullPage: true });
        console.log(`Captured screenshot: ${ssPath}`);

        // Verify banner or agent selector status
        const warningBanner = page.locator('text=No Agentforce Agents found in this org').first();
        const hasWarning = await warningBanner.isVisible();
        console.log(`Warning banner visible (when 0 agents exist): ${hasWarning}`);

        // Check if any fake agents are in DOM
        const coralCloud = page.locator('text=Coral Cloud Agent').first();
        const hasCoral = await coralCloud.isVisible();
        console.log(`"Coral Cloud Agent" fake agent visible: ${hasCoral} (Expected: false)`);

        const utyuytu = page.locator('text=utyuytu').first();
        const hasUty = await utyuytu.isVisible();
        console.log(`"utyuytu" fake agent visible: ${hasUty} (Expected: false)`);

        if (hasCoral || hasUty) {
            throw new Error('Fake agents are still appearing in DOM!');
        }

        console.log('SUCCESS: No fake agents found in Step-by-Step Setup tab!');
    } finally {
        await browser.close();
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
