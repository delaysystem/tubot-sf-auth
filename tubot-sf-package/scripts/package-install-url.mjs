#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installUrlPrefix = 'https://login.salesforce.com/packaging/installPackage.apexp?p0=';

function usage() {
    console.log(`Usage: bun scripts/package-install-url.mjs --target-dev-hub <alias> [options]

Options:
  --verification-org <alias>  Also run the repository's live source coverage gate before creating a version
  --promote                   Promote a matching beta or newly created version to released
  --check-only                Report whether a matching version exists without creating or promoting
  --wait <minutes>            Salesforce CLI wait time (default: 30)
  -h, --help                  Show this help

Each version created by this script is tagged with a SHA-256 fingerprint of the
package source and its packaging configuration. Existing untagged versions cannot
be source-matched, so the first run creates a fingerprinted version if needed.`);
}

function parseArgs(argv) {
    const options = {
        targetDevHub: '',
        verificationOrg: '',
        promote: false,
        checkOnly: false,
        wait: '30',
        help: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '-h' || arg === '--help') {
            options.help = true;
            continue;
        }
        if (arg === '--promote') {
            options.promote = true;
            continue;
        }
        if (arg === '--check-only') {
            options.checkOnly = true;
            continue;
        }
        if (['--target-dev-hub', '--verification-org', '--wait'].includes(arg)) {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error(`${arg} requires a value.`);
            }
            if (arg === '--target-dev-hub') options.targetDevHub = value;
            if (arg === '--verification-org') options.verificationOrg = value;
            if (arg === '--wait') options.wait = value;
            index += 1;
            continue;
        }
        throw new Error(`Unknown option: ${arg}`);
    }
    if (options.help) return options;
    if (!options.targetDevHub) throw new Error('--target-dev-hub is required.');
    if (!/^\d+$/.test(options.wait)) throw new Error('--wait must be a non-negative whole number of minutes.');
    return options;
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

async function run(command, args, { cwd = projectDir, label = command } = {}) {
    let child;
    try {
        child = Bun.spawn([command, ...args], {
            cwd,
            env: { ...process.env, SF_NO_COLOR: '1' },
            stdout: 'pipe',
            stderr: 'pipe'
        });
    } catch {
        throw new Error(`Could not start ${label}. Ensure the required command is installed and on PATH.`);
    }
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ]);
    if (exitCode !== 0) {
        const detail = [stdout, stderr].filter(Boolean).join('\n')
            .replace(/(access[_ -]?token|refresh[_ -]?token|authorization)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
            .replace(/\b00D[A-Za-z0-9]{12}![A-Za-z0-9._-]+\b/g, '[redacted Salesforce session]')
            .trim()
            .slice(-1200);
        throw new Error(`${label} failed with exit code ${exitCode}.${detail ? `\n${detail}` : ''}`);
    }
    return { stdout, stderr };
}

function parseCliJson(stdout, label) {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error(`${label} returned no JSON result.`);
    let payload;
    try {
        payload = JSON.parse(stdout.slice(start, end + 1));
    } catch {
        throw new Error(`${label} returned unreadable JSON.`);
    }
    if (payload.status !== 0) {
        const message = String(payload.message ?? payload.name ?? 'Salesforce CLI reported a failure.')
            .replace(/(access[_ -]?token|refresh[_ -]?token|authorization)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
            .replace(/\b00D[A-Za-z0-9]{12}![A-Za-z0-9._-]+\b/g, '[redacted Salesforce session]');
        throw new Error(`${label} failed: ${message.slice(0, 500)}`);
    }
    return payload.result;
}

async function sfJson(args, label) {
    const { stdout } = await run('sf', [...args, '--json'], { label });
    return parseCliJson(stdout, label);
}

function createIgnoreMatcher(contents) {
    const rules = contents.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
            const negated = line.startsWith('!');
            let pattern = negated ? line.slice(1) : line;
            pattern = pattern.replace(/^\//, '').replace(/\/$/, '');
            return { negated, glob: new Bun.Glob(pattern) };
        });

    return path => {
        const segments = path.split('/');
        const candidates = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
        let ignored = false;
        for (const rule of rules) {
            if (candidates.some(candidate => rule.glob.match(candidate))) ignored = !rule.negated;
        }
        return ignored;
    };
}

async function listSourceFiles(root, packageRelativePath, isIgnored) {
    const files = [];
    async function visit(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
        for (const entry of entries) {
            const fullPath = resolve(directory, entry.name);
            const packagePath = relative(root, fullPath).split(sep).join('/');
            const projectPath = `${packageRelativePath}/${packagePath}`;
            if (entry.isSymbolicLink()) {
                throw new Error(`Package source contains a symbolic link that cannot be fingerprinted safely: ${projectPath}`);
            }
            if (isIgnored(projectPath)) continue;
            if (entry.isDirectory()) {
                await visit(fullPath);
            } else if (entry.isFile()) {
                files.push({ name: projectPath, fullPath });
            }
        }
    }
    await visit(root);
    return files;
}

async function packageFingerprint() {
    const projectConfigPath = resolve(projectDir, 'sfdx-project.json');
    const project = JSON.parse(await readFile(projectConfigPath, 'utf8'));
    const defaults = (project.packageDirectories ?? []).filter(directory => directory.default === true);
    if (defaults.length !== 1) throw new Error('sfdx-project.json must define exactly one default package directory.');
    const packageDirectory = defaults[0];
    const packageName = packageDirectory.package;
    if (typeof packageName !== 'string' || !packageName.trim()) {
        throw new Error('The default package directory must specify its package alias.');
    }
    const packageId = project.packageAliases?.[packageName];
    if (typeof packageId !== 'string' || !/^0Ho[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(packageId)) {
        throw new Error(`No valid 2GP package ID is configured for ${packageName} in packageAliases.`);
    }
    if (typeof packageDirectory.path !== 'string' || isAbsolute(packageDirectory.path)) {
        throw new Error('The default package path must be relative to the Salesforce project.');
    }
    const sourceRoot = resolve(projectDir, packageDirectory.path);
    if (!sourceRoot.startsWith(`${projectDir}${sep}`)) throw new Error('The package source path escapes the Salesforce project.');
    const sourceStat = await lstat(sourceRoot).catch(() => null);
    if (!sourceStat?.isDirectory()) throw new Error(`Package source directory does not exist: ${packageDirectory.path}`);

    const forceIgnorePath = resolve(projectDir, '.forceignore');
    const forceIgnoreContents = await readFile(forceIgnorePath, 'utf8').catch(() => '');
    const isIgnored = createIgnoreMatcher(forceIgnoreContents);
    const sourceFiles = await listSourceFiles(sourceRoot, packageDirectory.path, isIgnored);
    const files = [
        { name: '.forceignore', fullPath: forceIgnorePath },
        ...sourceFiles
    ];

    if (packageDirectory.definitionFile) {
        const definitionPath = resolve(projectDir, packageDirectory.definitionFile);
        if (!definitionPath.startsWith(`${projectDir}${sep}`)) throw new Error('The package definition file escapes the Salesforce project.');
        const definitionStat = await lstat(definitionPath).catch(() => null);
        if (!definitionStat?.isFile()) throw new Error(`Package definition file does not exist: ${packageDirectory.definitionFile}`);
        files.push({ name: packageDirectory.definitionFile.split(sep).join('/'), fullPath: definitionPath });
    }

    const metadata = {
        format: 'tubot-package-source-v1',
        packageName,
        packageId,
        namespace: project.namespace ?? null,
        sourceApiVersion: project.sourceApiVersion ?? null,
        packageDirectory: Object.fromEntries(
            Object.entries(packageDirectory).filter(([key]) => !['versionName', 'versionNumber', 'versionDescription'].includes(key))
        )
    };
    const digest = createHash('sha256');
    digest.update(stableJson(metadata));
    digest.update('\0');
    files.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const file of files) {
        digest.update(file.name);
        digest.update('\0');
        digest.update(await readFile(file.fullPath));
        digest.update('\0');
    }
    return {
        fingerprint: digest.digest('hex'),
        packageName,
        packageId,
        configuredVersionNumber: packageDirectory.versionNumber,
        configuredVersionName: packageDirectory.versionName
    };
}

function compareVersions(left, right) {
    for (const key of ['MajorVersion', 'MinorVersion', 'PatchVersion', 'BuildNumber']) {
        const difference = Number(left[key] ?? 0) - Number(right[key] ?? 0);
        if (difference !== 0) return difference;
    }
    const byCreatedDate = String(left.CreatedDate ?? '').localeCompare(String(right.CreatedDate ?? ''));
    if (byCreatedDate !== 0) return byCreatedDate;
    return String(left.SubscriberPackageVersionId ?? '').localeCompare(String(right.SubscriberPackageVersionId ?? ''));
}

function compareVersionBases(left, right) {
    for (let index = 0; index < 3; index += 1) {
        const difference = left[index] - right[index];
        if (difference !== 0) return difference;
    }
    return 0;
}

function versionBase(version) {
    const parts = [version.MajorVersion, version.MinorVersion, version.PatchVersion].map(Number);
    return parts.every(Number.isInteger) ? parts : null;
}

function nextVersionNumber(configuredVersionNumber, versions) {
    const match = /^(\d+)\.(\d+)\.(\d+)\.(?:NEXT|\d+)$/i.exec(String(configuredVersionNumber ?? ''));
    if (!match) {
        throw new Error(`Unsupported package version format in sfdx-project.json: ${configuredVersionNumber}`);
    }
    let candidate = match.slice(1, 4).map(Number);
    const latestAnyBase = versions.map(versionBase).filter(Boolean).sort(compareVersionBases).at(-1);
    if (latestAnyBase && compareVersionBases(latestAnyBase, candidate) > 0) candidate = latestAnyBase;

    const latestReleasedBase = versions
        .filter(version => version.IsReleased === true)
        .map(versionBase)
        .filter(Boolean)
        .sort(compareVersionBases)
        .at(-1);
    if (latestReleasedBase && compareVersionBases(candidate, latestReleasedBase) <= 0) {
        candidate = latestReleasedBase[1] < 999
            ? [latestReleasedBase[0], latestReleasedBase[1] + 1, 0]
            : [latestReleasedBase[0] + 1, 0, 0];
    }
    return `${candidate.join('.')}.NEXT`;
}

function versionNameFor(configuredName, versionNumber) {
    if (typeof configuredName !== 'string') return undefined;
    const version = /^(\d+)\.(\d+)\./.exec(versionNumber);
    if (!version) return configuredName;
    const suffix = /^(.*?)(\d+\.\d+(?:\.\d+)?)$/.exec(configuredName);
    return suffix ? `${suffix[1]}${version[1]}.${version[2]}` : configuredName;
}

async function listVersions(packageId, targetDevHub) {
    const result = await sfJson([
        'package', 'version', 'list',
        '--packages', packageId,
        '--target-dev-hub', targetDevHub,
        '--verbose'
    ], 'List package versions');
    if (!Array.isArray(result)) throw new Error('Salesforce returned an invalid package version list.');
    return result.filter(version => version.Package2Id === packageId);
}

async function reportVersion(versionId, targetDevHub) {
    const result = await sfJson([
        'package', 'version', 'report',
        '--package', versionId,
        '--target-dev-hub', targetDevHub,
        '--verbose'
    ], `Report package version ${versionId}`);
    if (!result || result.SubscriberPackageVersionId !== versionId) {
        throw new Error(`Salesforce did not return the expected package version report for ${versionId}.`);
    }
    return result;
}

function assertVersionMatches(version, { versionId, packageId, fingerprint }) {
    if (version.SubscriberPackageVersionId !== versionId || version.Package2Id !== packageId || version.Tag !== fingerprint) {
        throw new Error(`Package version ${versionId} did not verify against the current source fingerprint.`);
    }
}

function assertCoverage(version, versionId) {
    const coverage = Number(version.CodeCoverage?.apexCodeCoveragePercentage);
    if (version.HasPassedCodeCoverageCheck !== true || !Number.isFinite(coverage) || coverage < 75) {
        throw new Error(`Package version ${versionId} has not passed the 75% package coverage target; refusing promotion.`);
    }
}

async function verifyAndMaybePromote(versionId, options, fingerprintInfo) {
    let report = await reportVersion(versionId, options.targetDevHub);
    assertVersionMatches(report, { versionId, ...fingerprintInfo });
    if (options.promote && report.IsReleased !== true && !options.checkOnly) {
        assertCoverage(report, versionId);
        await sfJson([
            'package', 'version', 'promote',
            '--package', versionId,
            '--target-dev-hub', options.targetDevHub,
            '--no-prompt'
        ], `Promote package version ${versionId}`);
        report = await reportVersion(versionId, options.targetDevHub);
        if (report.IsReleased !== true) throw new Error(`Salesforce did not confirm package version ${versionId} as released.`);
    }

    const versionsAfterAction = await listVersions(fingerprintInfo.packageId, options.targetDevHub);
    const listedVersion = versionsAfterAction.find(version => version.SubscriberPackageVersionId === versionId);
    if (!listedVersion || listedVersion.Tag !== fingerprintInfo.fingerprint || listedVersion.Package2Id !== fingerprintInfo.packageId) {
        throw new Error(`Independent Dev Hub list verification failed for package version ${versionId}.`);
    }
    if (options.promote && !options.checkOnly && listedVersion.IsReleased !== true) {
        throw new Error(`Independent Dev Hub list verification did not find released package version ${versionId}.`);
    }
    return listedVersion;
}

function printInstallUrl(version, fingerprint) {
    const versionId = version.SubscriberPackageVersionId;
    console.log(`STATUS=${version.IsReleased === true ? 'released' : 'beta'}`);
    console.log(`PACKAGE_VERSION_ID=${versionId}`);
    console.log(`SOURCE_SHA256=${fingerprint}`);
    console.log(`INSTALL_URL=${installUrlPrefix}${versionId}`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        usage();
        return;
    }

    const fingerprintInfo = await packageFingerprint();
    const versions = await listVersions(fingerprintInfo.packageId, options.targetDevHub);
    const matchingVersions = versions
        .filter(version => version.Tag === fingerprintInfo.fingerprint)
        .sort(compareVersions);

    if (matchingVersions.length > 0) {
        const selected = matchingVersions.at(-1);
        const verified = await verifyAndMaybePromote(
            selected.SubscriberPackageVersionId,
            options,
            fingerprintInfo
        );
        if (options.promote && options.checkOnly && verified.IsReleased !== true) {
            console.log('CHECK_ONLY=would-promote');
        } else {
            console.log('SOURCE_MATCH=up-to-date');
        }
        printInstallUrl(verified, fingerprintInfo.fingerprint);
        return;
    }

    if (options.checkOnly) {
        console.log(`SOURCE_MATCH=stale`);
        console.log(`SOURCE_SHA256=${fingerprintInfo.fingerprint}`);
        console.error(`No package version in Dev Hub ${options.targetDevHub} carries this source fingerprint; no version was created.`);
        process.exitCode = 2;
        return;
    }
    console.log(`Source differs from package versions in Dev Hub ${options.targetDevHub}; creating a validated version from the local package source.`);
    if (options.verificationOrg) {
        const coverageCheck = await run('bun', [
            'scripts/check-release-coverage.mjs',
            '--target-org', options.verificationOrg,
            '--wait', options.wait
        ], { cwd: projectDir, label: `Release coverage gate for ${options.verificationOrg}` });
        if (coverageCheck.stdout.trim()) process.stdout.write(coverageCheck.stdout);
        if (coverageCheck.stderr.trim()) process.stderr.write(coverageCheck.stderr);
    }

    const versionNumber = nextVersionNumber(fingerprintInfo.configuredVersionNumber, versions);
    const versionName = versionNameFor(fingerprintInfo.configuredVersionName, versionNumber);
    console.log(`Creating ${options.promote ? 'and promoting' : 'beta'} package version for source ${fingerprintInfo.fingerprint}.`);
    console.log(`Using package version number ${versionNumber}.`);
    const createArgs = [
        'package', 'version', 'create',
        '--package', fingerprintInfo.packageName,
        '--target-dev-hub', options.targetDevHub,
        '--installation-key-bypass',
        '--code-coverage',
        '--tag', fingerprintInfo.fingerprint,
        '--version-number', versionNumber,
        '--wait', options.wait
    ];
    if (versionName) createArgs.push('--version-name', versionName);
    const createResult = await sfJson(createArgs, 'Create package version');
    const versionId = createResult?.SubscriberPackageVersionId;
    if (typeof versionId !== 'string' || !/^04t[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(versionId)) {
        throw new Error('Package version creation returned no valid SubscriberPackageVersionId.');
    }

    let report = await reportVersion(versionId, options.targetDevHub);
    assertVersionMatches(report, { versionId, ...fingerprintInfo });
    assertCoverage(report, versionId);
    if (report.IsReleased === true) throw new Error(`New package version ${versionId} unexpectedly reports released before promotion.`);

    if (options.promote) {
        await sfJson([
            'package', 'version', 'promote',
            '--package', versionId,
            '--target-dev-hub', options.targetDevHub,
            '--no-prompt'
        ], `Promote package version ${versionId}`);
        report = await reportVersion(versionId, options.targetDevHub);
        if (report.IsReleased !== true) throw new Error(`Salesforce did not confirm package version ${versionId} as released.`);
    }

    const versionsAfterCreate = await listVersions(fingerprintInfo.packageId, options.targetDevHub);
    const listedVersion = versionsAfterCreate.find(version => version.SubscriberPackageVersionId === versionId);
    if (!listedVersion || listedVersion.Tag !== fingerprintInfo.fingerprint || listedVersion.Package2Id !== fingerprintInfo.packageId) {
        throw new Error(`Independent Dev Hub list verification failed for newly created package version ${versionId}.`);
    }
    if (listedVersion.IsReleased !== options.promote) {
        throw new Error(`Independent Dev Hub list verification returned unexpected release state for package version ${versionId}.`);
    }
    printInstallUrl(listedVersion, fingerprintInfo.fingerprint);
}

try {
    await main();
} catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
