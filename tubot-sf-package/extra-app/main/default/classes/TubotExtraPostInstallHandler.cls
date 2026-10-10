/** Creates the Omni-Channel setup records required by TuBot Extra. */
global without sharing class TubotExtraPostInstallHandler implements System.InstallHandler {
    global void onInstall(System.InstallContext context) {
        TubotExtraPostInstallProvisioner.provisionAfterInstall();
    }
}
