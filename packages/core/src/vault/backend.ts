export type VaultState = "unauthenticated" | "locked" | "unlocked";

export interface VaultStatus {
  state: VaultState;
  serverUrl: string | undefined;
  email: string | undefined;
  userId: string | undefined;
  lastSync: Date | undefined;
}

export interface Organization {
  id: string;
  name: string;
}

export interface Collection {
  id: string;
  organizationId: string;
  name: string;
}

export const FieldType = { Text: 0, Hidden: 1, Boolean: 2 } as const;
export type FieldType = (typeof FieldType)[keyof typeof FieldType];

export interface VaultField {
  name: string;
  value: string | null;
  type: FieldType;
}

/** The subset of a Bitwarden item envkit reads and writes. */
export interface VaultItem {
  id: string;
  organizationId: string | null;
  collectionIds: string[];
  name: string;
  notes: string | null;
  fields: VaultField[];
  revisionDate: string;
}

export type NewVaultItem = Omit<VaultItem, "id" | "revisionDate">;

export interface LoginOptions {
  email: string;
  password: string;
  /** Let `bw` prompt on the terminal for anything else it needs (2FA codes, new-device OTP). */
  interactive: boolean;
}

export interface ApiKeyLoginOptions {
  clientId: string;
  clientSecret: string;
}

/**
 * Everything envkit needs from a Bitwarden-compatible vault. Methods that read
 * or write vault data take the session key returned by `login` / `unlock`.
 */
export interface VaultBackend {
  status(session?: string): Promise<VaultStatus>;
  /** Point the backend at a server. Only allowed while logged out. */
  setServer(url: string): Promise<void>;
  /** Log in and unlock; resolves to a session key. */
  login(options: LoginOptions): Promise<string>;
  /** Log in with a personal API key. The vault stays locked; call `unlock` next. */
  loginWithApiKey(options: ApiKeyLoginOptions): Promise<void>;
  unlock(password: string): Promise<string>;
  lock(): Promise<void>;
  logout(): Promise<void>;
  sync(session: string): Promise<void>;
  listOrganizations(session: string): Promise<Organization[]>;
  listCollections(session: string, organizationId?: string): Promise<Collection[]>;
  getItem(session: string, id: string): Promise<VaultItem>;
  createItem(session: string, item: NewVaultItem): Promise<VaultItem>;
  updateItem(session: string, item: VaultItem): Promise<VaultItem>;
}
