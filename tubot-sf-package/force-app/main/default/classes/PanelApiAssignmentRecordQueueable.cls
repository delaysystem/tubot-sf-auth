/** Updates channel references after the API permission assignment is inserted. */
public with sharing class PanelApiAssignmentRecordQueueable implements Queueable {
    private List<PanelApiAssignmentQueueable.Request> requests;

    private class UpdateContext {
        private Set<String> userIds = new Set<String>();
        private Map<String, Id> assignmentIds = new Map<String, Id>();
        private List<Tubot_API_Channel__c> channels = new List<Tubot_API_Channel__c>();
        private Set<String> usersWithChannels = new Set<String>();
        private Set<Id> orphanedAssignments = new Set<Id>();
    }

    public PanelApiAssignmentRecordQueueable(List<PanelApiAssignmentQueueable.Request> requests) {
        this.requests = requests;
    }

    public void execute(QueueableContext queueableContext) {
        UpdateContext work = loadContext(requests);
        updateChannelReferences(work);
        collectOrphanedAssignments(work);
        if (work.orphanedAssignments.isEmpty()) {
            return;
        }
        if (!work.channels.isEmpty()) {
            // Mixed batch: channel updates (non-setup) already ran above, so
            // the assignment deletes (setup) must run in their own
            // transaction (mixed-DML rule) via a follow-up job. The follow-up
            // finds no channels for orphan-only requests and deletes inline.
            List<PanelApiAssignmentQueueable.Request> orphans =
                new List<PanelApiAssignmentQueueable.Request>();
            for (String userId : work.userIds) {
                if (!work.usersWithChannels.contains(userId)) {
                    orphans.add(new PanelApiAssignmentQueueable.Request(
                        (Id) userId, 'RECORD', work.assignmentIds.get(userId)
                    ));
                }
            }
            // Never chain from tests: mixed-batch tests assert the deferred
            // delete is pending (not flushed) and simulate the follow-up
            // with a second direct execute, so the enqueue would only ever
            // be unflushed litter. Production chaining is unaffected.
            if (!Test.isRunningTest()) {
                System.enqueueJob(new PanelApiAssignmentRecordQueueable(orphans));
            }
            return;
        }
        deleteOrphanedAssignments(work);
    }

    private static UpdateContext loadContext(List<PanelApiAssignmentQueueable.Request> requests) {
        UpdateContext work = new UpdateContext();
        collectAssignments(requests, work);
        work.channels = [
            SELECT Id, Integration_User_Id__c, Assignment_Id__c
            FROM Tubot_API_Channel__c
            WHERE Integration_User_Id__c IN :work.userIds AND Assignment_Owned__c = true
            WITH USER_MODE
        ];
        return work;
    }

    private static void collectAssignments(List<PanelApiAssignmentQueueable.Request> requests, UpdateContext work) {
        for (PanelApiAssignmentQueueable.Request request : requests) {
            String userId = String.valueOf(request.userId);
            work.userIds.add(userId);
            work.assignmentIds.put(userId, request.ownedAssignmentId);
        }
    }

    private static void updateChannelReferences(UpdateContext work) {
        for (Tubot_API_Channel__c channel : work.channels) {
            channel.Assignment_Id__c = String.valueOf(work.assignmentIds.get(channel.Integration_User_Id__c));
            work.usersWithChannels.add(channel.Integration_User_Id__c);
        }
        if (!work.channels.isEmpty()) {
            Database.update(work.channels, AccessLevel.USER_MODE);
        }
    }

    private static void deleteOrphanedAssignments(UpdateContext work) {
        if (work.orphanedAssignments.isEmpty()) {
            return;
        }
        List<PermissionSetAssignment> pending = [
            SELECT Id FROM PermissionSetAssignment
            WHERE Id IN :work.orphanedAssignments
            WITH USER_MODE
        ];
        if (!pending.isEmpty()) {
            Database.delete(pending, AccessLevel.USER_MODE);
        }
    }

    private static void collectOrphanedAssignments(UpdateContext work) {
        for (String userId : work.userIds) {
            if (!work.usersWithChannels.contains(userId)) {
                work.orphanedAssignments.add(work.assignmentIds.get(userId));
            }
        }
    }
}
