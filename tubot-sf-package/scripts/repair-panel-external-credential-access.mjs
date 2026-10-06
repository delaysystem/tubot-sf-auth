import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const projectConfig = JSON.parse(await readFile(join(projectDir, 'sfdx-project.json'), 'utf8'));
const packageNamespace = typeof projectConfig.namespace === 'string' ? projectConfig.namespace.trim() : '';
const permissionSetName = 'TuBot_Panel_External_Credential_Admin_Repair';
const permissionSetLabel = 'TuBot Panel External Credential Admin Repair';
const permissionSetDescription = 'Provides User External Credential access required to connect Panel from TuBot Settings. Created by the TuBot credential repair script.';
const marker = '\n__TUBOT_HTTP_STATUS__';

function parseArgs(argv) {
    const options = { targetOrg: '', apiVersion: '', checkOnly: false, help: false };
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

function printHelp() {
    console.log(`Restore Panel External Credential access for the Salesforce user logged in with Salesforce CLI.

Usage:
  bun scripts/repair-panel-external-credential-access.mjs --target-org <org-alias>
  bun scripts/repair-panel-external-credential-access.mjs --target-org <org-alias> --check-only

The script verifies TuBot's packaged Panel External Credential and Named Credential, then uses
Salesforce Metadata REST API through cURL to create a small org-local permission set and assigns it
only to the CLI's current user. Salesforce CLI independently verifies the result. No Panel token is
requested, displayed, or stored. Run as the same Salesforce admin who uses Panel Settings.`);
}

function parseCliJson(stdout) {
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) throw new Error('Salesforce CLI returned an unexpected response.');
    try { return JSON.parse(stdout.slice(jsonStart)); }
    catch { throw new Error('Salesforce CLI returned an unexpected response.'); }
}

function runSf(args) {
    let result;
    try {
        result = spawnSync('sf', [...args, '--json'], {
            cwd: projectDir,
            encoding: 'utf8',
            env: { ...process.env, SF_DISABLE_LOG_FILE: 'true' },
            timeout: 120_000,
            maxBuffer: 8 * 1024 * 1024,
        });
    } catch {
        throw new Error('Salesforce CLI (`sf`) could not be started.');
    }
    if (result.error || result.status !== 0) {
        throw new Error('Salesforce CLI failed. Confirm that this org alias is logged in and try again.');
    }
    const payload = parseCliJson(result.stdout || '');
    if (payload.status !== 0) throw new Error('Salesforce CLI failed. Confirm that this org alias is logged in and try again.');
    return payload.result;
}

function soqlLiteral(value) {
    return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function curlConfigString(value) {
    return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`;
}

async function curlRequest({ url, method = 'GET', token, forms = [], body }) {
    const args = ['--silent', '--show-error', '--write-out', `${marker}%{http_code}`, '--config', '-'];
    for (const form of forms) args.push('--form', form);
    if (body !== undefined) args.push('--data-binary', body);
    const child = Bun.spawn(['curl', ...args], {
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, CURL_HOME: tmpdir() },
    });
    child.stdin.write([
        `url = ${curlConfigString(url)}`,
        `request = ${curlConfigString(method)}`,
        `header = ${curlConfigString(`Authorization: Bearer ${token}`)}`,
        `header = ${curlConfigString('Accept: application/json')}`,
        ...(body === undefined ? [] : [`header = ${curlConfigString('Content-Type: application/json')}`]),
    ].join('\n'));
    child.stdin.end();
    const [stdout, , exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    const statusAt = stdout.lastIndexOf(marker);
    if (statusAt < 0) throw new Error('cURL could not reach Salesforce. Confirm network access and retry.');
    const status = Number(stdout.slice(statusAt + marker.length).trim());
    const bodyText = stdout.slice(0, statusAt);
    let responseBody;
    try { responseBody = bodyText ? JSON.parse(bodyText) : {}; }
    catch { throw new Error(`Salesforce returned an invalid JSON response (HTTP ${status}).`); }
    if (exitCode !== 0 || status < 200 || status >= 300) {
        const apiError = Array.isArray(responseBody) ? responseBody[0] : responseBody;
        const code = typeof apiError?.errorCode === 'string' ? ` ${apiError.errorCode}` : '';
        throw new Error(`Salesforce REST request failed (HTTP ${status}).${code}`);
    }
    return responseBody;
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
    const localParts = [];
    const directoryParts = [];
    let localOffset = 0;
    let directorySize = 0;

    for (const [fileName, content] of Object.entries(files)) {
        const name = Buffer.from(fileName, 'utf8');
        const data = Buffer.from(content, 'utf8');
        const checksum = crc32(data);
        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(33, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        name.copy(local, 30);
        localParts.push(local, data);

        const directory = Buffer.alloc(46 + name.length);
        directory.writeUInt32LE(0x02014b50, 0);
        directory.writeUInt16LE(20, 4);
        directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(0, 8);
        directory.writeUInt16LE(0, 10);
        directory.writeUInt16LE(0, 12);
        directory.writeUInt16LE(33, 14);
        directory.writeUInt32LE(checksum, 16);
        directory.writeUInt32LE(data.length, 20);
        directory.writeUInt32LE(data.length, 24);
        directory.writeUInt16LE(name.length, 28);
        directory.writeUInt16LE(0, 30);
        directory.writeUInt16LE(0, 32);
        directory.writeUInt16LE(0, 34);
        directory.writeUInt16LE(0, 36);
        directory.writeUInt32LE(0, 38);
        directory.writeUInt32LE(localOffset, 42);
        name.copy(directory, 46);
        directoryParts.push(directory);
        localOffset += local.length + data.length;
        directorySize += directory.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(directoryParts.length, 8);
    end.writeUInt16LE(directoryParts.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(localOffset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, ...directoryParts, end]);
}

function isFullUserExternalCredentialAccess(row) {
    return row?.PermissionsRead === true && row?.PermissionsCreate === true &&
        row?.PermissionsEdit === true && row?.PermissionsDelete === true &&
        row?.PermissionsViewAllRecords === true;
}

function externalCredentialMetadata() {
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<ExternalCredential xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
        `    <authenticationProtocol>Custom</authenticationProtocol>\n` +
        `    <externalCredentialParameters>\n` +
        `        <parameterGroup>DefaultGroup</parameterGroup>\n` +
        `        <parameterName>Panel_Principal</parameterName>\n` +
        `        <parameterType>NamedPrincipal</parameterType>\n` +
        `        <sequenceNumber>1</sequenceNumber>\n` +
        `    </externalCredentialParameters>\n` +
        `    <externalCredentialParameters>\n` +
        `        <parameterGroup>DefaultGroup</parameterGroup>\n` +
        `        <parameterName>Authorization</parameterName>\n` +
        `        <parameterType>AuthHeader</parameterType>\n` +
        `        <parameterValue>Bearer {!$Credential.Panel_External_Credential.token}</parameterValue>\n` +
        `        <sequenceNumber>2</sequenceNumber>\n` +
        `    </externalCredentialParameters>\n` +
        `    <label>Panel External Credential</label>\n` +
        `</ExternalCredential>\n`;
}

function namedCredentialMetadata(panelBaseUrl = 'https://tubot-new-panel.emalteaproductions.workers.dev') {
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
        `    <allowMergeFieldsInBody>false</allowMergeFieldsInBody>\n` +
        `    <allowMergeFieldsInHeader>true</allowMergeFieldsInHeader>\n` +
        `    <calloutStatus>Enabled</calloutStatus>\n` +
        `    <generateAuthorizationHeader>true</generateAuthorizationHeader>\n` +
        `    <label>Panel Named Credential</label>\n` +
        `    <namedCredentialParameters>\n` +
        `        <parameterName>Url</parameterName>\n` +
        `        <parameterType>Url</parameterType>\n` +
        `        <parameterValue>${panelBaseUrl}</parameterValue>\n` +
        `    </namedCredentialParameters>\n` +
        `    <namedCredentialParameters>\n` +
        `        <externalCredential>Panel_External_Credential</externalCredential>\n` +
        `        <parameterName>ExternalCredential</parameterName>\n` +
        `        <parameterType>Authentication</parameterType>\n` +
        `    </namedCredentialParameters>\n` +
        `    <namedCredentialType>SecuredEndpoint</namedCredentialType>\n` +
        `</NamedCredential>\n`;
}

function permissionSetMetadata(includePackagedPrincipal = false) {
    let principalsXml = `    <externalCredentialPrincipalAccesses>\n` +
        `        <enabled>true</enabled>\n` +
        `        <externalCredentialPrincipal>Panel_External_Credential-Panel_Principal</externalCredentialPrincipal>\n` +
        `    </externalCredentialPrincipalAccesses>\n`;
    if (includePackagedPrincipal) {
        principalsXml += `    <externalCredentialPrincipalAccesses>\n` +
            `        <enabled>true</enabled>\n` +
            `        <externalCredentialPrincipal>tubot__Panel_External_Credential-Panel_Principal</externalCredentialPrincipal>\n` +
            `    </externalCredentialPrincipalAccesses>\n`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
        `    <description>${permissionSetDescription}</description>\n` +
        `    <hasActivationRequired>false</hasActivationRequired>\n` +
        `    <label>${permissionSetLabel}</label>\n` +
        principalsXml +
        `    <objectPermissions>\n` +
        `        <allowCreate>true</allowCreate>\n` +
        `        <allowDelete>true</allowDelete>\n` +
        `        <allowEdit>true</allowEdit>\n` +
        `        <allowRead>true</allowRead>\n` +
        `        <modifyAllRecords>false</modifyAllRecords>\n` +
        `        <object>UserExternalCredential</object>\n` +
        `        <viewAllRecords>true</viewAllRecords>\n` +
        `    </objectPermissions>\n` +
        `</PermissionSet>\n`;
}

function remoteSiteMetadata(panelBaseUrl = 'https://tubot-new-panel.emalteaproductions.workers.dev') {
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
        `    <description>Active remote site setting for TuBot Panel polling and callouts</description>\n` +
        `    <disableProtocolSecurity>false</disableProtocolSecurity>\n` +
        `    <isActive>true</isActive>\n` +
        `    <url>${panelBaseUrl}</url>\n` +
        `</RemoteSiteSetting>\n`;
}

function packageManifest(apiVersion) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n` +
        `    <types><members>Panel_External_Credential</members><name>ExternalCredential</name></types>\n` +
        `    <types><members>Panel_Named_Credential</members><name>NamedCredential</name></types>\n` +
        `    <types><members>Panel_Tubot_Active</members><name>RemoteSiteSetting</name></types>\n` +
        `    <types><members>${permissionSetName}</members><name>PermissionSet</name></types>\n` +
        `    <version>${apiVersion}</version>\n` +
        `</Package>\n`;
}

async function deployPermissionSet({ instanceUrl, apiVersion, token, checkOnly, includePackagedPrincipal }) {
    const workspace = await mkdtemp(join(tmpdir(), 'tubot-panel-credential-repair-'));
    try {
        const archivePath = join(workspace, 'repair.zip');
        const metadataZip = makeZip({
            'package.xml': packageManifest(apiVersion),
            [`permissionsets/${permissionSetName}.permissionset`]: permissionSetMetadata(includePackagedPrincipal),
            'externalCredentials/Panel_External_Credential.externalCredential': externalCredentialMetadata(),
            'namedCredentials/Panel_Named_Credential.namedCredential': namedCredentialMetadata(),
            'remoteSiteSettings/Panel_Tubot_Active.remoteSite': remoteSiteMetadata(),
        });
        await writeFile(archivePath, metadataZip, { mode: 0o600 });
        const deployOptions = JSON.stringify({ deployOptions: {
            allowMissingFiles: false,
            autoUpdatePackage: false,
            checkOnly,
            ignoreWarnings: false,
            performRetrieve: false,
            purgeOnDelete: false,
            rollbackOnError: true,
            singlePackage: true,
            testLevel: 'NoTestRun',
        } });

        const queued = await curlRequest({
            url: `${instanceUrl}/services/data/v${apiVersion}/metadata/deployRequest`,
            method: 'POST', token,
            forms: [
                `json=${deployOptions};type=application/json`,
                `file=@${archivePath};type=application/zip;filename=repair.zip`,
            ],
        });
        const deployId = queued.id || queued.deployId;
        if (typeof deployId !== 'string') throw new Error('Salesforce accepted no deployment ID for the permission repair.');

        const statusUrl = `${instanceUrl}/services/data/v${apiVersion}/metadata/deployRequest/${encodeURIComponent(deployId)}?includeDetails=true`;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            const status = await curlRequest({ url: statusUrl, token });
            const result = status.deployResult || status;
            if (result.done === true || ['Succeeded', 'Failed', 'Canceled'].includes(result.status)) {
                if (result.status === 'Succeeded') return;
                const failures = result.numberComponentErrors ?? result.details?.componentFailures?.length ?? 0;
                throw new Error(`Salesforce permission-set deployment ${result.status || 'failed'} with ${failures} component error(s).`);
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
        throw new Error('Salesforce permission-set deployment is still running; check Setup → Deployment Status before retrying.');
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
}

async function queryRest({ instanceUrl, apiVersion, token, soql }) {
    const url = `${instanceUrl}/services/data/v${apiVersion}/query/?q=${encodeURIComponent(soql)}`;
    const result = await curlRequest({ url, token });
    return Array.isArray(result.records) ? result.records : [];
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return printHelp();
    if (packageNamespace && !/^[A-Za-z][A-Za-z0-9_]*$/.test(packageNamespace)) {
        throw new Error('The TuBot namespace in sfdx-project.json is invalid.');
    }

    const org = runSf(['org', 'display', '--verbose', '--target-org', options.targetOrg]);
    const instanceUrl = org.instanceUrl;
    const auth = runSf(['org', 'auth', 'show-access-token', '--target-org', options.targetOrg]);
    const token = auth.accessToken;
    const apiVersion = options.apiVersion || org.apiVersion || '67.0';
    if (typeof instanceUrl !== 'string' || !instanceUrl.startsWith('https://') || typeof token !== 'string' || !token) {
        throw new Error('Salesforce CLI did not return an authenticated org session. Log in with `sf org login web` and retry.');
    }
    if (!/^\d+\.\d+$/.test(apiVersion)) throw new Error('Salesforce CLI returned an invalid API version.');

    let hasPackagedCredential = false;
    try {
        const pkgCred = await curlRequest({
            url: `${instanceUrl}/services/data/v${apiVersion}/named-credentials/external-credentials/tubot__Panel_External_Credential`,
            token,
        });
        if (pkgCred?.developerName || pkgCred?.principals) {
            hasPackagedCredential = true;
        }
    } catch {
        hasPackagedCredential = false;
    }

    const userRecords = await queryRest({
        instanceUrl, apiVersion, token,
        soql: `SELECT Id FROM User WHERE Username = ${soqlLiteral(org.username)} AND IsActive = true LIMIT 1`,
    });
    const userId = userRecords[0]?.Id;
    if (!userId) throw new Error('Salesforce could not resolve the current CLI user.');

    const existingRepairSets = await queryRest({
        instanceUrl, apiVersion, token,
        soql: `SELECT Id, Label, Description, NamespacePrefix FROM PermissionSet WHERE Name = '${permissionSetName}' LIMIT 1`,
    });
    const existingRepairSet = existingRepairSets[0];
    if (existingRepairSet && existingRepairSet.NamespacePrefix && existingRepairSet.NamespacePrefix !== packageNamespace) {
        throw new Error(`A permission set named ${permissionSetName} already exists in another namespace. Rename it before retrying.`);
    }

    await deployPermissionSet({ instanceUrl, apiVersion, token, checkOnly: options.checkOnly, includePackagedPrincipal: hasPackagedCredential });
    if (options.checkOnly) {
        console.log('The org-local Panel credential access permission set passed Metadata REST validation. No org changes were made.');
        return;
    }

    const repairNamespaceClause = packageNamespace
        ? `(NamespacePrefix = null OR NamespacePrefix = '${packageNamespace}')`
        : 'NamespacePrefix = null';
    const repairSets = await queryRest({
        instanceUrl, apiVersion, token,
        soql: `SELECT Id FROM PermissionSet WHERE Name = '${permissionSetName}' AND ${repairNamespaceClause} LIMIT 1`,
    });
    const repairPermissionSetId = repairSets[0]?.Id;
    if (!repairPermissionSetId) throw new Error('Salesforce deployed no org-local Panel credential permission set.');

    const assignments = await queryRest({
        instanceUrl, apiVersion, token,
        soql: `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' AND PermissionSetId = '${repairPermissionSetId}' LIMIT 1`,
    });
    if (!assignments.length) {
        await curlRequest({
            url: `${instanceUrl}/services/data/v${apiVersion}/sobjects/PermissionSetAssignment`,
            method: 'POST', token,
            body: JSON.stringify({ AssigneeId: userId, PermissionSetId: repairPermissionSetId }),
        });
    }

    // Blind verification is deliberately performed through Salesforce CLI after the cURL mutations.
    const verifiedPermissions = runSf(['data', 'query', '--target-org', options.targetOrg, '--query',
        `SELECT PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords FROM ObjectPermissions WHERE Parent.Name = '${permissionSetName}' AND SobjectType = 'UserExternalCredential' LIMIT 1`])?.records || [];
    const verifiedAssignments = runSf(['data', 'query', '--target-org', options.targetOrg, '--query',
        `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' AND PermissionSetId = '${repairPermissionSetId}' LIMIT 1`])?.records || [];
    if (!isFullUserExternalCredentialAccess(verifiedPermissions[0]) || verifiedAssignments.length !== 1) {
        throw new Error('Salesforce CLI could not verify the Panel credential repair after assignment.');
    }
    console.log('Panel credential administration access is repaired and verified for the Salesforce user logged in with this org alias. Return to Panel Settings and connect with Panel again.');
}

try {
    await main();
} catch (error) {
    console.error(`Panel credential repair failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
}
