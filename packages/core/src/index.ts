export {
  CONFIG_FILE,
  findConfig,
  loadConfig,
  parseConfig,
  resolveEnvironment,
  writeConfig,
  type EnvironmentRef,
  type EnvkitConfig,
  type LoadedConfig,
} from "./config.ts";
export { EnvkitError, isEnvkitError } from "./errors.ts";
export { envkitHome, type Env } from "./paths.ts";
export {
  environmentItemName,
  environmentItemNotes,
  ITEM_MARKER,
  parseEnvironmentItem,
  validateEnvironmentName,
  validateProjectName,
} from "./project.ts";
export { normalizeServerUrl } from "./server-url.ts";
export {
  canCreateCollections,
  FieldType,
  type ItemFilter,
  type OrganizationRole,
  type ApiKeyLoginOptions,
  type Collection,
  type LoginOptions,
  type NewVaultItem,
  type Organization,
  type VaultBackend,
  type VaultField,
  type VaultItem,
  type VaultState,
  type VaultStatus,
} from "./vault/backend.ts";
export {
  BW_INSTALL_HINT,
  BwCliBackend,
  BwError,
  compareVersions,
  CONFLICT_MESSAGE,
  MIN_BW_VERSION,
  toError,
  type BwCliOptions,
} from "./vault/bw-cli.ts";
export {
  DEFAULT_SESSION_IDLE_MINUTES,
  idleTimeoutFromEnv,
  SessionManager,
  type SessionManagerOptions,
} from "./session/manager.ts";
export {
  createSessionStore,
  KeyringSessionStore,
  MemorySessionStore,
  type SessionStore,
  type StoredSession,
} from "./session/store.ts";
export { DEFAULT_SYNC_INTERVAL_MINUTES, needsSync, syncIntervalFromEnv } from "./sync.ts";
export {
  applyVariableChanges,
  buildChildEnv,
  diffVariables,
  dotenvQuote,
  formatVariables,
  isValidVariableName,
  OUTPUT_FORMATS,
  parseDotenv,
  PRIVATE_ENV,
  readVariables,
  shellQuote,
  type OutputFormat,
  type ReadVariablesResult,
  type VariableChanges,
} from "./variables.ts";
export { githubMaskCommands, isGithubActions, MIN_MASKED_LENGTH } from "./ci.ts";
