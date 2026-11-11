export type VaultState = "unauthenticated" | "locked" | "unlocked";

export interface VaultStatus {
  state: VaultState;
  serverUrl: string | undefined;
  email: string | undefined;
  userId: string | undefined;
  lastSync: Date | undefined;
}

/** The current user's role in an organization. */
export type OrganizationRole = "owner" | "admin" | "user" | "manager" | "custom";

export interface Organization {
  id: string;
  name: string;
  role: OrganizationRole;
}

/**
 * Only owners and admins may create collections. Don't let anyone else try:
 * Vaultwarden answers with a 401 and `bw` then logs the user out.
 */
export function canCreateCollections(organization: Organization): boolean {
  return organization.role === "owner" || organization.role === "admin";
}

export interface ItemFilter {
  organizationId?: string;
  collectionId?: string;
  /** Free-text search, as `bw list items --search`. */
  search?: string;
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
  /** Allow prompting on the terminal for login verification. */
  interactive: boolean;
  /** Native login only; verification codes must never be persisted or logged. */
  askCode?: (kind: "authenticator" | "email" | "new-device") => Promise<string>;
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
  /** Requires owner or admin rights; check `canCreateCollections` first. */
  createCollection(session: string, organizationId: string, name: string): Promise<Collection>;
  /** Items the user can see, excluding the trash. */
  listItems(session: string, filter?: ItemFilter): Promise<VaultItem[]>;
  /** Throws "Item not found" for missing items and items in the trash. */
  getItem(session: string, id: string): Promise<VaultItem>;
  createItem(session: string, item: NewVaultItem): Promise<VaultItem>;
  updateItem(session: string, item: VaultItem): Promise<VaultItem>;
  /** Moves the item to the trash (restorable from the web vault). */
  deleteItem(session: string, id: string): Promise<void>;
}
