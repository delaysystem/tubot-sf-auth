import { describe, expect, test } from 'bun:test';
import { buildPermissionSetXml, buildPoliciesXml, findPoliciesName, parseArgs } from './setup-eca-policies.mjs';

describe('setup-eca-policies args', () => {
    test('requires target org', () => {
        expect(() => parseArgs([])).toThrow('--target-org');
    });
    test('parses target org and defaults', () => {
        expect(parseArgs(['--target-org', 'my-org'])).toEqual({ targetOrg: 'my-org', apiVersion: '67.0', checkOnly: false, help: false });
    });
    test('rejects unknown options', () => {
        expect(() => parseArgs(['--target-org', 'x', '--bogus'])).toThrow('Unknown option');
    });
});

describe('setup-eca-policies metadata', () => {
    test('permission set is unpackaged-shaped and namespaced-free', () => {
        const xml = buildPermissionSetXml();
        expect(xml).toContain('Tubot JWT PreAuth');
        expect(xml).not.toContain('__');
    });
    test('policies lock the namespaced app to the pre-auth set', () => {
        const xml = buildPoliciesXml('tubot__Tubot_Channel_API', 'Tubot_Channel_API_OAuth_defaultPolicy');
        expect(xml).toContain('<externalClientApplication>tubot__Tubot_Channel_API</externalClientApplication>');
        expect(xml).toContain('<permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType>');
        expect(xml).toContain('<commaSeparatedPermissionSet>Tubot_JWT_PreAuth</commaSeparatedPermissionSet>');
    });
    test('finds the subscriber policies record by app reference', () => {
        const files = [
            { name: 'Other.ecaOauthPlcy-meta.xml', body: '<externalClientApplication>Other</externalClientApplication>' },
            { name: 'Tubot_Channel_API_OAuth_defaultPolicy.ecaOauthPlcy-meta.xml', body: '<externalClientApplication>tubot__Tubot_Channel_API</externalClientApplication>' }
        ];
        expect(findPoliciesName(files, 'tubot__Tubot_Channel_API')).toBe('Tubot_Channel_API_OAuth_defaultPolicy');
        expect(findPoliciesName(files, 'tubot__Missing')).toBeNull();
    });
});
