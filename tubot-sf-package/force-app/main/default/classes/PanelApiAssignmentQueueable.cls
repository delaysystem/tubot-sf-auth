/** Reconciles package API permission assignments in bulk after channel changes. */
public with sharing class PanelApiAssignmentQueueable implements Queueable {
    private List<Request> requests;

    public class Request {
        public Id userId;
        public String operation;
        public Id ownedAssignmentId;

        public Request(Id userId, String operation, Id ownedAssignmentId) {
            this.userId = userId;
            this.operation = operation;
            this.ownedAssignmentId = ownedAssignmentId;
        }
    }

    private class ReconciliationContext {
        private Set<Id> userIds = new Set<Id>();
        private Set<String> userIdStrings = new Set<String>();
        private Set<Id> usersWithChannels = new Set<Id>();
        private Map<Id, PermissionSetAssignment> assignmentByUser = new Map<Id, PermissionSetAssignment>();
        private List<PermissionSetAssignment> toInsert = new List<PermissionSetAssignment>();
        private List<PermissionSetAssignment> toDelete = new List<PermissionSetAssignment>();
        private List<Request> recordRequests = new List<Request>();
        private Id permissionSetId;
    }

    public PanelApiAssignmentQueueable(List<Request> requests) {
        this.requests = requests;
    }

    public void execute(QueueableContext context) {
        ReconciliationContext work = loadContext(requests);
        if (work.permissionSetId == null) {
            return;
        }
        classifyRequests(requests, work);
        applyAssignmentChanges(work);
        enqueueAssignmentRecordUpdates(work.recordRequests);
    }

    private static ReconciliationContext loadContext(List<Request> requests) {
        ReconciliationContext work = new ReconciliationContext();
        collectTargetUsers(requests, work);
        work.permissionSetId = findPermissionSetId();
        if (work.permissionSetId == null) {
            return work;
        }
        loadUsersWithChannels(work);
        loadExistingAssignments(work);
        return work;
    }

    private static void collectTargetUsers(List<Request> requests, ReconciliationContext work) {
        for (Request request : requests) {
            work.userIds.add(request.userId);
            work.userIdStrings.add(String.valueOf(request.userId));
        }
    }

    private static void loadUsersWithChannels(ReconciliationContext work) {
        for (Tubot_API_Channel__c channel : findChannelsForUsers(work.userIdStrings)) {
            work.usersWithChannels.add((Id) channel.Integration_User_Id__c);
        }
    }

    private static List<Tubot_API_Channel__c> findChannelsForUsers(Set<String> targetUserIds) {
        return [
            SELECT Integration_User_Id__c
            FROM Tubot_API_Channel__c
            WHERE Integration_User_Id__c IN :targetUserIds
            WITH USER_MODE
        ];
    }

    private static void loadExistingAssignments(ReconciliationContext work) {
        for (PermissionSetAssignment assignment : [
            SELECT Id, AssigneeId
            FROM PermissionSetAssignment
            WHERE AssigneeId IN :work.userIds AND PermissionSetId = :work.permissionSetId
            WITH USER_MODE
        ]) {
            work.assignmentByUser.put(assignment.AssigneeId, assignment);
        }
    }

    // Resolve the permission set matching this code's own namespace. Dev orgs
    // can hold both the packaged and unpackaged copies; a bare LIMIT 1 lookup
    // may insert one copy while connect checks the other, deadlocking setup
    // with "still being prepared". Mirrors resolveApiPermissionSetId.
    private static Id findPermissionSetId() {
        String here = PanelApiAssignmentQueueable.class.getName();
        String wantNs = here.contains('.') ? here.substringBefore('.') : null;
        List<PermissionSet> permissionSets = [
            SELECT Id, NamespacePrefix FROM PermissionSet
            WHERE Name = :PanelSalesforceChannelService.PERMISSION_SET
            WITH USER_MODE
        ];
        for (PermissionSet permissionSet : permissionSets) {
            if (permissionSet.NamespacePrefix == wantNs) {
                return permissionSet.Id;
            }
        }
        return permissionSets.isEmpty() ? null : permissionSets[0].Id;
    }

    private static void classifyRequests(List<Request> requests, ReconciliationContext work) {
        for (Request request : requests) {
            if (shouldSkipRequest(request, work.usersWithChannels)) {
                continue;
            }
            addAssignmentChange(request, work);
        }
    }

    private static Boolean shouldSkipRequest(Request request, Set<Id> usersWithChannels) {
        return (request.operation == 'ASSIGN' && !usersWithChannels.contains(request.userId)) ||
            (request.operation != 'ASSIGN' && usersWithChannels.contains(request.userId));
    }

    private static void addAssignmentChange(Request request, ReconciliationContext work) {
        Boolean shouldAssign = request.operation == 'ASSIGN';
        PermissionSetAssignment existing = work.assignmentByUser.get(request.userId);
        if (shouldAssign && existing == null) {
            work.toInsert.add(new PermissionSetAssignment(
                AssigneeId = request.userId,
                PermissionSetId = work.permissionSetId
            ));
        } else if (!shouldAssign && existing != null && existing.Id == request.ownedAssignmentId) {
            work.toDelete.add(existing);
        }
    }

    private static void applyAssignmentChanges(ReconciliationContext work) {
        if (!work.toInsert.isEmpty()) {
            Database.insert(work.toInsert, AccessLevel.USER_MODE);
            collectAssignmentRecordRequests(work);
        }
        if (!work.toDelete.isEmpty()) {
            Database.delete(work.toDelete, AccessLevel.USER_MODE);
        }
    }

    private static void collectAssignmentRecordRequests(ReconciliationContext work) {
        for (PermissionSetAssignment assignment : work.toInsert) {
            work.recordRequests.add(new Request(assignment.AssigneeId, 'RECORD', assignment.Id));
        }
    }

    private static void enqueueAssignmentRecordUpdates(List<Request> recordRequests) {
        // Never chain from tests: the async test context of packaging build
        // orgs lacks the channel FLS the record job's USER_MODE query needs,
        // failing validation. Record logic is covered by direct-execute tests.
        if (!recordRequests.isEmpty() && !Test.isRunningTest()) {
            System.enqueueJob(new PanelApiAssignmentRecordQueueable(recordRequests));
        }
    }
}
