import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const projectConfig = JSON.parse(await readFile(join(projectDir, 'sfdx-project.json'), 'utf8'));
const packageNamespace = typeof projectConfig.namespace === 'string' ? projectConfig.namespace : '';
const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target-org');
const targetOrg = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
const checkOnly = args.includes('--check-only');
if (!targetOrg || targetOrg.startsWith('--')) {
    throw new Error('Usage: bun scripts/deploy-package.mjs --target-org <org-alias> [--check-only]');
}

async function sf(commandArgs) {
    const child = Bun.spawn(['sf', ...commandArgs, '--json'], {
        cwd: projectDir,
        stdout: 'pipe',
        stderr: 'inherit'
    });
    const output = await new Response(child.stdout).text();
    const code = await child.exited;
    const payload = JSON.parse(output);
    if (code !== 0 || payload.status !== 0) {
        const failures = payload.result?.details?.componentFailures;
        const message = failures?.map(item => `${item.fullName}: ${item.problem}`).join('\n');
        throw new Error(message || payload.message || `Salesforce CLI exited with ${code}.`);
    }
    return payload.result;
}

const workspace = await mkdtemp(join(tmpdir(), 'tubot-package-deploy-'));
try {
    const org = await sf(['data', 'query', '--target-org', targetOrg,
        '--query', 'SELECT NamespacePrefix FROM Organization']);
    if (org.records?.length !== 1) {
        throw new Error('The target org metadata could not be resolved.');
    }
    const namespace = org.records?.[0]?.NamespacePrefix;
    if (namespace && !/^[A-Za-z][A-Za-z0-9_]*$/.test(namespace)) {
        throw new Error('The target org returned an invalid namespace.');
    }
    await sf(['project', 'convert', 'source', '--root-dir', 'force-app', '--output-dir', workspace]);
    // Credential principal references require the target namespace in a namespaced
    // development org. Keep package source portable for orgs without a namespace.
    {
        const permissionDir = join(workspace, 'permissionsets');
        for (const name of await readdir(permissionDir)) {
            if (!name.endsWith('.permissionset')) { continue; }
            const path = join(permissionDir, name);
            const xml = await readFile(path, 'utf8');
            const adapted = xml.replace(
                /<externalCredentialPrincipal>([^<]+)<\/externalCredentialPrincipal>/g,
                (_, principal) => {
                    const prefix = principal.match(/^([A-Za-z][A-Za-z0-9_]*?)__/);
                    const currentNamespace = prefix?.[1] ?? '';
                    if (currentNamespace && currentNamespace !== packageNamespace && currentNamespace !== namespace) {
                        throw new Error('External Credential principal has an unexpected namespace.');
                    }
                    const unqualifiedPrincipal = prefix ? principal.slice(prefix[0].length) : principal;
                    const targetPrincipal = namespace ? `${namespace}__${unqualifiedPrincipal}` : unqualifiedPrincipal;
                    return `<externalCredentialPrincipal>${targetPrincipal}</externalCredentialPrincipal>`;
                }
            );
            if (adapted !== xml) { await writeFile(path, adapted); }
        }
    }
    const deployArgs = ['project', 'deploy', 'start', '--metadata-dir', workspace,
        '--target-org', targetOrg, '--test-level', 'RunLocalTests', '--wait', '30'];
    if (checkOnly) { deployArgs.push('--dry-run'); }
    const deployment = await sf(deployArgs);
    const report = await sf(['project', 'deploy', 'report', '--job-id', deployment.id,
        '--target-org', targetOrg]);
    if (report.status !== 'Succeeded' || report.numberComponentErrors !== 0) {
        throw new Error(`Deployment ${deployment.id} is ${report.status}.`);
    }
    console.log(JSON.stringify({
        mode: checkOnly ? 'check-only' : 'deployed',
        status: report.status,
        components: report.numberComponentsDeployed,
        tests: report.numberTestsCompleted
    }, null, 2));
} finally {
    await rm(workspace, { recursive: true, force: true });
}
