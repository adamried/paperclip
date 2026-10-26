export {
  createDb,
  closeRegisteredClients,
  getPostgresDataDirectory,
  ensurePostgresDatabase,
  resetPostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  type MigrationState,
  type MigrationHistoryReconcileResult,
  migratePostgresIfEmpty,
  type MigrationBootstrapResult,
  type Db,
} from "./client.js";
export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "./test-embedded-postgres.js";
export {
  runDatabaseBackup,
  runDatabaseRestore,
  formatDatabaseBackupResult,
  type BackupRetentionPolicy,
  type RunDatabaseBackupOptions,
  type RunDatabaseBackupResult,
  type RunDatabaseRestoreOptions,
} from "./backup-lib.js";
export {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
export {
  ensureLinuxSharedLibraryAliases,
  prepareEmbeddedPostgresNativeRuntime,
} from "./embedded-postgres-native.js";
export { loadWithoutEmbeddedPostgresExitHooks } from "./embedded-postgres-lifecycle.js";
export {
  LOCAL_BOARD_USER_ID,
  IDENTITY_RECONCILIATION_SUPPORTED_SOURCE_USER_IDS,
  IDENTITY_RECONCILED_ACTIVITY_ACTION,
  IdentityReconciliationError,
  resolveIdentityReconciliationTarget,
  previewIdentityReconciliation,
  applyIdentityReconciliation,
  formatIdentityReconciliationReport,
  type IdentityReconciliationAction,
  type IdentityReconciliationClass,
  type IdentityReconciliationEntry,
  type IdentityReconciliationErrorCode,
  type IdentityReconciliationInput,
  type IdentityReconciliationReauthorizeItem,
  type IdentityReconciliationReport,
  type IdentityReconciliationUser,
} from "./identity-reconciliation.js";
export { issueRelations } from "./schema/issue_relations.js";
export { issueReferenceMentions } from "./schema/issue_reference_mentions.js";
export * from "./schema/index.js";
