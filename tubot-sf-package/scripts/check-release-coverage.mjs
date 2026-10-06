import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const targetIndex = args.indexOf('--target-org');
const waitIndex = args.indexOf('--wait');
const targetOrg = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
const waitMinutes = waitIndex >= 0 ? args[waitIndex + 1] : '30';
if (!targetOrg || targetOrg.startsWith('--') || !/^\d+$/.test(waitMinutes)) {
    throw new Error('Usage: bun scripts/check-release-coverage.mjs --target-org <org-alias> [--wait <minutes>]');
}
const project = JSON.parse(await readFile(join(projectDir, 'sfdx-project.json'), 'utf8'));
const packageNamespace = typeof project.namespace === 'string' && project.namespace.trim()
    ? project.namespace.trim()
    : null;
const forceIgnoreRules = (await readFile(join(projectDir, '.forceignore'), 'utf8'))
    .split(/\r?\n/)
    .map(rule => rule.trim())
    .filter(rule => rule && !rule.startsWith('#') && !rule.startsWith('!'));
const classIgnoreGlobs = forceIgnoreRules
    .filter(rule => rule.startsWith('force-app/main/default/classes/'))
    .map(rule => new Bun.Glob(rule));

function isIgnoredClass(fileName) {
    const sourcePath = `force-app/main/default/classes/${fileName}`;
    return classIgnoreGlobs.some(glob => glob.match(sourcePath));
}

async function sf(commandArgs) {
    const child = Bun.spawn(['sf', ...commandArgs, '--json'], {
        cwd: projectDir,
        stdout: 'pipe',
        stderr: 'pipe'
    });
    const [stdout, , exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited
    ]);
    let payload;
    try {
        payload = JSON.parse(stdout);
    } catch {
        throw new Error(`Salesforce CLI returned an unreadable result for ${commandArgs.slice(0, 3).join(' ')}.`);
    }
    if (exitCode !== 0 || payload.status !== 0) {
        throw new Error(`Salesforce CLI failed for ${commandArgs.slice(0, 3).join(' ')}.`);
    }
    return payload.result;
}

const workspace = await mkdtemp(join(tmpdir(), 'tubot-apex-release-coverage-'));
try {
    await sf(['project', 'convert', 'source', '--root-dir', 'force-app', '--output-dir', workspace]);

    const classesDir = join(workspace, 'classes');
    const testNames = [];
    const packageClassNames = [];
    for (const fileName of await readdir(classesDir)) {
        if (!fileName.endsWith('.cls') || fileName.startsWith('IGNORE_') || isIgnoredClass(fileName)) { continue; }
        const source = await readFile(join(classesDir, fileName), 'utf8');
        const declaration = source.match(/\bclass\s+([A-Za-z][A-Za-z0-9_]*)/i);
        if (!declaration) { continue; }
        if (/@IsTest\b/i.test(source)) { testNames.push(declaration[1]); }
        else { packageClassNames.push(declaration[1]); }
    }
    if (testNames.length === 0) {
        throw new Error('The distributable package contains no active Apex test classes.');
    }

    const testNameQuery = testNames.map(name => `'${name}'`).join(', ');
    const testClassResult = await sf([
        'data', 'query', '--target-org', targetOrg, '--use-tooling-api',
        '--query', `SELECT Name, NamespacePrefix FROM ApexClass WHERE Name IN (${testNameQuery})`
    ]);
    const testClassRows = Array.isArray(testClassResult?.records) ? testClassResult.records : [];
    const namespacedRows = packageNamespace
        ? testClassRows.filter(record => record.NamespacePrefix === packageNamespace)
        : [];
    const selectedTestRows = namespacedRows.length > 0
        ? namespacedRows
        : testClassRows.filter(record => !record.NamespacePrefix);
    const availableTestNames = new Map(
        selectedTestRows.map(record => [record.Name, record.NamespacePrefix || ''])
    );
    const missingTestNames = testNames.filter(name => !availableTestNames.has(name));
    if (missingTestNames.length > 0) {
        throw new Error(`The verification org is missing package test classes: ${missingTestNames.join(', ')}. Install or deploy the candidate package first.`);
    }
    const testNamespaces = new Set(availableTestNames.values());
    if (testNamespaces.size !== 1) {
        throw new Error('The verification org contains package tests from multiple namespaces.');
    }
    const testNamespace = [...testNamespaces][0] || packageNamespace;

    const triggerDir = join(workspace, 'triggers');
    let triggerNames = [];
    try {
        triggerNames = (await readdir(triggerDir))
            .filter(fileName => fileName.endsWith('.trigger') && !fileName.startsWith('IGNORE_'))
            .map(fileName => fileName.slice(0, -'.trigger'.length));
    } catch (error) {
        if (error.code !== 'ENOENT') { throw error; }
    }

    const testArgs = [
        'apex', 'run', 'test', '--target-org', targetOrg,
        '--test-level', 'RunSpecifiedTests', '--code-coverage',
        '--result-format', 'json', '--wait', waitMinutes
    ];
    for (const testName of testNames) {
        testArgs.push('--class-names', testNamespace ? `${testNamespace}.${testName}` : testName);
    }
    const result = await sf(testArgs);
    const summary = result?.summary ?? result?.coverage?.summary;
    const coverageResult = await sf([
        'data', 'query', '--target-org', targetOrg, '--use-tooling-api',
        '--query', 'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate'
    ]);
    const aggregateRows = Array.isArray(coverageResult?.records) ? coverageResult.records : [];
    const aggregateByName = new Map(aggregateRows.map(row => [row.ApexClassOrTrigger?.Name, row]));
    const classCoverage = packageClassNames
        .map(name => {
            const row = aggregateByName.get(name);
            const total = Number(row?.NumLinesCovered ?? 0) + Number(row?.NumLinesUncovered ?? 0);
            const covered = Number(row?.NumLinesCovered ?? 0);
            return { name, totalLines: total, coveredLines: covered, percent: total > 0 ? Math.floor(covered * 100 / total) : 0 };
        })
        .sort((left, right) => left.percent - right.percent || left.name.localeCompare(right.name));
    const packageTotalLines = classCoverage.reduce((total, item) => total + item.totalLines, 0);
    const packageCoveredLines = classCoverage.reduce((total, item) => total + item.coveredLines, 0);
    const coveragePercent = packageTotalLines > 0
        ? Math.floor(packageCoveredLines * 100 / packageTotalLines)
        : Number.NaN;
    const triggerCoverage = triggerNames.map(name => {
        const row = aggregateByName.get(name);
        const total = Number(row?.NumLinesCovered ?? 0) + Number(row?.NumLinesUncovered ?? 0);
        const covered = Number(row?.NumLinesCovered ?? 0);
        return { name, totalLines: total, coveredLines: covered, percent: total > 0 ? Math.floor(covered * 100 / total) : 0 };
    });
    const report = {
        outcome: summary?.outcome ?? 'Unknown',
        testsRun: Number(summary?.testsRan ?? 0),
        testClasses: testNames.sort(),
        packageCoveragePercent: Number.isFinite(coveragePercent) ? coveragePercent : null,
        coverageMetric: 'Weighted coverage of distributable package Apex classes',
        classCoverage,
        requiredPackageCoveragePercent: 75,
        packagedTriggers: triggerCoverage,
        requiredTriggerCoveragePercent: 100
    };
    console.log(JSON.stringify(report, null, 2));

    const hasFailedTests = report.outcome !== 'Passed' || Number(summary?.failing ?? 0) > 0 || report.testsRun === 0;
    const hasCoverageFailure = !Number.isFinite(coveragePercent) || coveragePercent < 75;
    const hasTriggerFailure = triggerCoverage.some(item => item.totalLines === 0 || item.coveredLines !== item.totalLines);
    if (hasFailedTests || hasCoverageFailure || hasTriggerFailure) {
        console.error('Apex release coverage gates failed.');
        process.exitCode = 1;
    }
} finally {
    await rm(workspace, { recursive: true, force: true });
}
