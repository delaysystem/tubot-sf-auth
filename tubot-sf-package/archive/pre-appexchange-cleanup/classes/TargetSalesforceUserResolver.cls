/**
 * Resolves one or more active Salesforce users from IDs, names, usernames, or email addresses.
 * User data is queried in bulk so input size does not multiply SOQL usage.
 */
public with sharing class TargetSalesforceUserResolver {
    private class IdentifierBatch {
        private List<String> orderedTokens = new List<String>();
        private Set<String> lookupValues = new Set<String>();
        private Set<String> currentUserTokens = new Set<String>();
        private Set<Id> userIds = new Set<Id>();
        private Map<String, Id> userIdByToken = new Map<String, Id>();
    }

    private class UserLookup {
        private Id currentUserId;
        private Map<Id, User> usersById;
        private Map<String, User> usersByIdentifier;
        private Map<String, Id> userIdByToken;
    }

    public static List<User> resolve(String userIdentifiers) {
        IdentifierBatch batch = parseIdentifiers(userIdentifiers);
        Id currentUserId = UserInfo.getUserId();
        if (!batch.currentUserTokens.isEmpty()) {
            batch.userIds.add(currentUserId);
        }

        UserLookup lookup = new UserLookup();
        lookup.currentUserId = currentUserId;
        lookup.usersById = queryUsersById(batch.userIds);
        lookup.usersByIdentifier = queryUsersByIdentifier(batch.lookupValues);
        lookup.userIdByToken = batch.userIdByToken;
        List<User> resolvedUsers = new List<User>();
        Set<Id> resolvedIds = new Set<Id>();

        for (String token : batch.orderedTokens) {
            User matchedUser = resolveToken(token, lookup);
            if (!resolvedIds.contains(matchedUser.Id)) {
                resolvedUsers.add(matchedUser);
                resolvedIds.add(matchedUser.Id);
            }
        }
        if (resolvedUsers.isEmpty()) {
            throw new IllegalArgumentException('No active Salesforce users resolved from identifier(s): ' + userIdentifiers);
        }
        return resolvedUsers;
    }

    private static IdentifierBatch parseIdentifiers(String userIdentifiers) {
        IdentifierBatch batch = new IdentifierBatch();
        if (String.isBlank(userIdentifiers)) {
            batch.orderedTokens.add('current');
            batch.currentUserTokens.add('current');
            return batch;
        }

        for (String rawToken : userIdentifiers.split('[,;]')) {
            String token = rawToken.trim();
            if (String.isBlank(token)) {
                continue;
            }
            batch.orderedTokens.add(token);
            if ('default'.equalsIgnoreCase(token) || 'current'.equalsIgnoreCase(token)) {
                batch.currentUserTokens.add(token.toLowerCase());
                continue;
            }
            if (token.length() == 15 || token.length() == 18) {
                Id userId = (Id) token;
                batch.userIds.add(userId);
                batch.userIdByToken.put(token.toLowerCase(), userId);
            }
            batch.lookupValues.add(token.toLowerCase());
        }
        return batch;
    }

    private static Map<Id, User> queryUsersById(Set<Id> userIds) {
        if (userIds.isEmpty()) {
            return new Map<Id, User>();
        }
        return new Map<Id, User>([
            SELECT Id, Username, Email, Name
            FROM User
            WHERE Id IN :userIds AND IsActive = true
            WITH USER_MODE
        ]);
    }

    private static Map<String, User> queryUsersByIdentifier(Set<String> lookupValues) {
        Map<String, User> usersByIdentifier = new Map<String, User>();
        if (lookupValues.isEmpty()) {
            return usersByIdentifier;
        }

        List<User> matchedUsers = [
            SELECT Id, Username, Email, Name
            FROM User
            WHERE IsActive = true
                AND (Name IN :lookupValues OR Username IN :lookupValues OR Email IN :lookupValues)
            WITH USER_MODE
            ORDER BY LastLoginDate DESC NULLS LAST
            LIMIT 2000
        ];
        for (User matchedUser : matchedUsers) {
            addIdentifier(usersByIdentifier, matchedUser.Username, matchedUser);
            addIdentifier(usersByIdentifier, matchedUser.Email, matchedUser);
            addIdentifier(usersByIdentifier, matchedUser.Name, matchedUser);
        }
        return usersByIdentifier;
    }

    private static void addIdentifier(Map<String, User> usersByIdentifier, String value, User matchedUser) {
        if (String.isNotBlank(value)) {
            String key = value.toLowerCase();
            if (!usersByIdentifier.containsKey(key)) {
                usersByIdentifier.put(key, matchedUser);
            }
        }
    }

    private static User resolveToken(String token, UserLookup lookup) {
        User matchedUser;
        if ('default'.equalsIgnoreCase(token) || 'current'.equalsIgnoreCase(token)) {
            matchedUser = lookup.usersById.get(lookup.currentUserId);
        } else if (lookup.userIdByToken.containsKey(token.toLowerCase())) {
            matchedUser = lookup.usersById.get(lookup.userIdByToken.get(token.toLowerCase()));
        }
        if (matchedUser == null) {
            matchedUser = lookup.usersByIdentifier.get(token.toLowerCase());
        }
        if (matchedUser == null) {
            throw new IllegalArgumentException('No active Salesforce user found matching identifier: ' + token);
        }
        return matchedUser;
    }
}
