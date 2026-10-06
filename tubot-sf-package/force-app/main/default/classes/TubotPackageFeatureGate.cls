/**
 * @description Fail-fast gate for package features intentionally disabled in this release.
 */
public class TubotPackageFeatureGate {
    public static void reject(String featureName) {
        throw new AuraHandledException(featureName + ' is disabled in this package release.');
    }
}
