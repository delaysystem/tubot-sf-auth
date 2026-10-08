-- 0004: JWT bearer rows for the packaged execution client.
-- JWT rows carry no per-row client secret (the RSA private key lives in the
-- TUBOT_JWT_PRIVATE_KEY worker secret) and mint for the asserted integration
-- username instead. Legacy rows keep their encrypted secrets untouched.
-- SQLite cannot relax NOT NULL in place, so rebuild the table preserving
-- every row, then add the JWT mint columns.
CREATE TABLE `salesforce_auth_credential_new` (
  `team_id` text NOT NULL,
  `org_id` text NOT NULL,
  `channel_id` text NOT NULL,
  `instance_url` text NOT NULL,
  `client_id` text NOT NULL,
  `client_secret_cipher` text,
  `client_secret_iv` text,
  `integration_user_id` text NOT NULL,
  `integration_username` text,
  `is_sandbox` integer,
  `channel_secret_hash` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`team_id`, `org_id`, `channel_id`)
);
INSERT INTO `salesforce_auth_credential_new`
  (`team_id`, `org_id`, `channel_id`, `instance_url`, `client_id`,
   `client_secret_cipher`, `client_secret_iv`, `integration_user_id`,
   `channel_secret_hash`, `created_at`, `updated_at`)
  SELECT `team_id`, `org_id`, `channel_id`, `instance_url`, `client_id`,
   `client_secret_cipher`, `client_secret_iv`, `integration_user_id`,
   `channel_secret_hash`, `created_at`, `updated_at`
  FROM `salesforce_auth_credential`;
DROP TABLE `salesforce_auth_credential`;
ALTER TABLE `salesforce_auth_credential_new` RENAME TO `salesforce_auth_credential`;
