/** What the fake `bw` prints for one command. Objects are JSON-encoded to stdout. */
export interface FakeBwResponse {
  stdout?: string | object;
  stderr?: string;
  code?: number;
}
/** One recorded invocation of the fake `bw`. */
export interface FakeBwCall {
  args: string[];
  env: Record<string, string | undefined>;
  stdin: string;
}
export interface FakeBw {
  /** Path to the executable; pass it as `bwPath`. */
  path: string;
  /**
   * Sets the response for a command, keyed by its leading args, e.g. "status",
   * "list organizations", "get item <id>". The longest matching key wins.
   */
  respond(command: string, response: FakeBwResponse): Promise<void>;
  calls(): Promise<FakeBwCall[]>;
  cleanup(): Promise<void>;
}
/** Creates a scriptable stand-in for the `bw` CLI in a temp directory. */
export declare function createFakeBw(version?: string): Promise<FakeBw>;
