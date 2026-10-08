#!/usr/bin/env bun
// Configures subscriber-side pre-authorization for the packaged TuBot
// Channel API execution client (JWT bearer flow). Deploys an unpackaged
// permission set plus a policies update that locks the packaged app to
// admin-approved users holding that set. Uses the admin's own Salesforce
// CLI session. No secrets are requested, displayed, or stored: Panel holds
// the JWT private key and mints only for pre-authorized users.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'Tubot_Channel_API';
const PREAUTH_SET_NAME = 'Tubot_JWT_PreAuth';
const DEFAULT_API_VERSION = '67.0';

export function parseArgs(argv) {
    const options = { targetOrg: '', apiVersion: DEFAULT_API_VERSION, checkOnly: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--check-only') options.checkOnly = true;
        else if (arg === '--target-org' || arg === '-o') options.targetOrg = argv[++i] ?? '';
        else if (arg === '--api-version') options.apiVersion = argv[++i] ?? '';
        else throw new Error(`Unknown option: ${arg}`);
    }
    if (!options.help && !options.targetOrg) throw new Error('Pass the Salesforce org alias or username with --target-org.');
    if (options.apiVersion && !/^\d+\.\d+$/.test(options.apiVersion)) throw new Error('--api-version must look like 67.0.');
    return options;
}

export function printHelp() {
    console.log(`Configure subscriber pre-authorization for the packaged TuBot Channel API client.

Usage:
  bun scripts/setup-eca-policies.mjs --target-org <org-alias>
  bun scripts/setup-eca-policies.mjs --target-org <org-alias> --check-only

The script deploys an unpackaged permission set (${PREAUTH_SET_NAME}) and updates the packaged
app's subscriber policies to admin-approved users holding that set, then
verifies both. Setup assigns the set to the integration user by DML.
No secrets are involved. Run as a Salesforce admin authenticated with Salesforce CLI.`);
}

function sf(args, { cwd } = {}) {
    const result = spawnSync('sf', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new Error(`sf ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout || '').slice(0, 500)}`);
    }
    return (result.stdout || '').trim();
}

function sfJson(args, options) {
    return JSON.parse(sf([...args, '--json'], options));
}

export function buildPermissionSetXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n  <description>Subscriber-side pre-authorization for the packaged TuBot Channel API execution client (JWT bearer flow). Members may obtain tokens. Created by setup-eca-policies.mjs.</description>\n  <label>Tubot JWT PreAuth</label>\n</PermissionSet>\n`;
}

export function buildPoliciesXml(namespacedApp, policiesName) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<ExtlClntAppOauthConfigurablePolicies xmlns="http://soap.sforce.com/2006/04/metadata">\n  <externalClientApplication>${namespacedApp}</externalClientApplication>\n  <label>${policiesName}</label>\n  <permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType>\n  <commaSeparatedPermissionSet>${PREAUTH_SET_NAME}</commaSeparatedPermissionSet>\n</ExtlClntAppOauthConfigurablePolicies>\n`;
}

// Finds the subscriber policies record for the packaged app by scanning
// retrieved metadata (the auto-generated record name is an install detail).
export function findPoliciesName(retrievedFiles, namespacedApp) {
    for (const file of retrievedFiles) {
        if (!file.name.endsWith('.ecaOauthPlcy-meta.xml')) continue;
        if (file.body.includes(`<externalClientApplication>${namespacedApp}</externalClientApplication>`)) {
            return file.name.replace(/\.ecaOauthPlcy-meta\.xml$/, '');
        }
    }
    return null;
}

async function readNamespace() {
    const projectDir = fileURLToPath(new URL('..', import.meta.url));
    const projectConfig = JSON.parse(await readFile(join(projectDir, 'sfdx-project.json'), 'utf8'));
    return typeof projectConfig.namespace === 'string' ? projectConfig.namespace.trim() : '';
}

async function queryOrg(options, soql) {
    const result = sfJson(['data', 'query', '--query', soql, '-o', options.targetOrg]);
    return result?.result?.records ?? [];
}

async function deployDir(options, projectDir, sourceDir) {
    // Run inside the temp project: newer sf CLI versions reject source dirs
    // outside the project ("unsafe character sequences").
    sf(
        ['project', 'deploy', 'start', '--source-dir', sourceDir, '-o', options.targetOrg, '--ignore-conflicts', '--concise'],
        { cwd: projectDir }
    );
}

async function checkState(options, namespacedApp) {
    const apps = await queryOrg(options, `SELECT Id FROM ExternalClientApplication WHERE DeveloperName = '${APP_NAME}' LIMIT 1`);
    const sets = await queryOrg(options, `SELECT Id FROM PermissionSet WHERE Name = '${PREAUTH_SET_NAME}' AND NamespacePrefix = null LIMIT 1`);
    return { appInstalled: apps.length > 0, preAuthSetExists: sets.length > 0 };
}

async function discoverPoliciesName(options, namespacedApp, workDir) {
    const retrieveDir = join(workDir, 'retrieve');
    await mkdir(join(retrieveDir, 'force-app'), { recursive: true });
    await writeFile(join(retrieveDir, 'sfdx-project.json'), JSON.stringify({
        packageDirectories: [{ path: 'force-app', default: true }],
        name: 'tubot-policies-discovery', namespace: '', sfdcLoginUrl: 'https://login.salesforce.com', sourceApiVersion: options.apiVersion
    }));
    sf(['project', 'retrieve', 'start', '--metadata', 'ExtlClntAppOauthConfigurablePolicies', '-o', options.targetOrg], { cwd: retrieveDir });
    const policiesDir = join(retrieveDir, 'force-app', 'main', 'default', 'extlClntAppOauthPolicies');
    const files = [];
    for (const name of await readdir(policiesDir)) {
        files.push({ name, body: await readFile(join(policiesDir, name), 'utf8') });
    }
    const found = findPoliciesName(files, namespacedApp);
    if (!found) throw new Error(`No subscriber policies found for ${namespacedApp}. Reinstall or upgrade the TuBot package, then retry.`);
    return found;
}

async function verifyPolicies(options, namespacedApp, workDir, policiesName) {
    const found = await discoverPoliciesName(options, namespacedApp, workDir);
    if (found !== policiesName) throw new Error(`Policies record changed during setup (saw ${found}). Retry.`);
    const policiesDir = join(workDir, 'retrieve', 'force-app', 'main', 'default', 'extlClntAppOauthPolicies');
    const body = await readFile(join(policiesDir, `${policiesName}.ecaOauthPlcy-meta.xml`), 'utf8');
    if (!body.includes('<permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType>')) {
        throw new Error('Policies verification failed: permitted-users type is not admin-approved.');
    }
    if (!body.includes(`<commaSeparatedPermissionSet>${PREAUTH_SET_NAME}</commaSeparatedPermissionSet>`)) {
        throw new Error('Policies verification failed: pre-auth permission set is missing.');
    }
}

export async function main(argv) {
    const options = parseArgs(argv);
    if (options.help) {
        printHelp();
        return { help: true };
    }
    const namespace = await readNamespace();
    const namespacedApp = namespace ? `${namespace}__${APP_NAME}` : APP_NAME;
    const state = await checkState(options, namespacedApp);
    if (!state.appInstalled) {
        throw new Error(`Packaged app ${namespacedApp} is not installed in ${options.targetOrg}. Install the TuBot package first.`);
    }
    if (options.checkOnly) {
        console.log(JSON.stringify({ appInstalled: true, preAuthSetExists: state.preAuthSetExists }));
        return { checkOnly: true, ...state };
    }
    const workDir = await mkdtemp(join(tmpdir(), 'tubot-eca-policies-'));
    try {
        const deployDirPath = join(workDir, 'deploy', 'force-app', 'main', 'default');
        await mkdir(join(deployDirPath, 'permissionsets'), { recursive: true });
        await mkdir(join(deployDirPath, 'extlClntAppOauthPolicies'), { recursive: true });
        await writeFile(join(workDir, 'deploy', 'sfdx-project.json'), JSON.stringify({
            packageDirectories: [{ path: 'force-app', default: true }],
            name: 'tubot-eca-policies', namespace: '', sfdcLoginUrl: 'https://login.salesforce.com', sourceApiVersion: options.apiVersion
        }));
        await writeFile(join(deployDirPath, 'permissionsets', `${PREAUTH_SET_NAME}.permissionset-meta.xml`), buildPermissionSetXml());
        const policiesName = await discoverPoliciesName(options, namespacedApp, workDir);
        await writeFile(
            join(deployDirPath, 'extlClntAppOauthPolicies', `${policiesName}.ecaOauthPlcy-meta.xml`),
            buildPoliciesXml(namespacedApp, policiesName)
        );
        await deployDir(options, join(workDir, 'deploy'), 'force-app');
        const after = await checkState(options, namespacedApp);
        if (!after.preAuthSetExists) throw new Error('Verification failed: pre-auth permission set is missing after deploy.');
        await verifyPolicies(options, namespacedApp, workDir, policiesName);
        console.log(JSON.stringify({ ok: true, policies: policiesName, preAuthSet: PREAUTH_SET_NAME }));
        return { ok: true, policies: policiesName };
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    main(process.argv.slice(2)).catch((error) => {
        console.error(`setup-eca-policies failed: ${error.message}`);
        process.exit(1);
    });
}
