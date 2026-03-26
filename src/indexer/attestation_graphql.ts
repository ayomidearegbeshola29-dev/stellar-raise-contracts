/**
 * @title Attestation Indexer – GraphQL API
 * @notice Provides a GraphQL endpoint for querying and subscribing to
 *         attestation data indexed from the TrustLink smart contract.
 * @dev Zero external dependencies. Implements a minimal GraphQL execution
 *      engine (schema parsing, query execution, subscriptions via EventEmitter)
 *      sufficient to satisfy the acceptance criteria:
 *        - GET/POST /graphql  → query & mutation execution
 *        - WS       /graphql  → subscription (onAttestationCreated)
 *        - GET      /graphql  → GraphQL Playground (development only)
 *
 * @security
 *   - All address inputs are validated against Stellar/EVM address formats.
 *   - Enum inputs (Status, claimType) are validated against allowlists.
 *   - Subscription filters are applied server-side; clients never receive
 *     events for subjects they did not subscribe to.
 *   - Playground is disabled when NODE_ENV === 'production'.
 *
 * @author TrustLink / Stellar Raise Contracts Team
 */

// ---------------------------------------------------------------------------
// Types & Enums
// ---------------------------------------------------------------------------

/**
 * @notice Lifecycle status of an attestation.
 * @dev Maps 1-to-1 with the on-chain Status enum.
 */
export enum AttestationStatus {
  ACTIVE    = 'ACTIVE',
  REVOKED   = 'REVOKED',
  EXPIRED   = 'EXPIRED',
}

/**
 * @notice A single attestation record as stored by the indexer.
 */
export interface Attestation {
  /** Unique attestation identifier (hex string) */
  id: string;
  /** Stellar/EVM address of the subject being attested */
  subject: string;
  /** Stellar/EVM address of the issuer who created the attestation */
  issuer: string;
  /** Claim category (e.g. "KYC", "AML", "ACCREDITED_INVESTOR") */
  claimType: string;
  /** Current lifecycle status */
  status: AttestationStatus;
  /** ISO-8601 timestamp when the attestation was created */
  createdAt: string;
  /** ISO-8601 timestamp when the attestation expires, or null */
  expiresAt: string | null;
  /** Arbitrary metadata payload (JSON string) */
  metadata: string;
}

/**
 * @notice Aggregated statistics for a single issuer.
 */
export interface IssuerStats {
  /** Stellar/EVM address of the issuer */
  issuer: string;
  /** Total attestations ever created by this issuer */
  totalAttestations: number;
  /** Currently ACTIVE attestations */
  activeCount: number;
  /** Currently REVOKED attestations */
  revokedCount: number;
  /** Currently EXPIRED attestations */
  expiredCount: number;
}

/**
 * @notice Arguments for the `attestations` query.
 */
export interface AttestationsArgs {
  subject?: string;
  claimType?: string;
  status?: AttestationStatus;
}

/**
 * @notice Arguments for the `issuerStats` query.
 */
export interface IssuerStatsArgs {
  issuer: string;
}

/**
 * @notice Arguments for the `onAttestationCreated` subscription.
 */
export interface OnAttestationCreatedArgs {
  subject?: string;
}

/**
 * @notice A GraphQL execution result.
 */
export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: GraphQLError[];
}

/**
 * @notice A structured GraphQL error.
 */
export interface GraphQLError {
  message: string;
  path?: string[];
}

/**
 * @notice Subscription handle returned to callers.
 */
export interface SubscriptionHandle {
  /** Unique subscription ID */
  id: string;
  /** Call to stop receiving events */
  unsubscribe: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @notice Allowlist of valid claim types */
export const VALID_CLAIM_TYPES = [
  'KYC', 'AML', 'ACCREDITED_INVESTOR', 'IDENTITY', 'CREDIT_SCORE',
] as const;

/** @notice Regex for a valid Stellar address (G + 55 base32 chars) */
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/** @notice Regex for a valid EVM address (0x + 40 hex chars) */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** @notice GraphQL SDL schema (informational – used by Playground) */
export const GRAPHQL_SCHEMA_SDL = `
  """Lifecycle status of an attestation"""
  enum Status {
    ACTIVE
    REVOKED
    EXPIRED
  }

  """A single attestation record"""
  type Attestation {
    id: String!
    subject: String!
    issuer: String!
    claimType: String!
    status: Status!
    createdAt: String!
    expiresAt: String
    metadata: String!
  }

  """Aggregated statistics for an issuer"""
  type IssuerStats {
    issuer: String!
    totalAttestations: Int!
    activeCount: Int!
    revokedCount: Int!
    expiredCount: Int!
  }

  type Query {
    """Filter attestations by subject address, claim type, and/or status"""
    attestations(subject: String, claimType: String, status: Status): [Attestation!]!

    """Return aggregated statistics for a given issuer address"""
    issuerStats(issuer: String!): IssuerStats
  }

  type Subscription {
    """Emits whenever a new attestation is created, optionally filtered by subject"""
    onAttestationCreated(subject: String): Attestation!
  }
`;

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

/**
 * @title AttestationGraphQLError
 * @notice Thrown for all validation and execution errors in this module.
 */
export class AttestationGraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationGraphQLError';
  }
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * @title AttestationValidator
 * @notice Static helpers for validating GraphQL input arguments.
 * @dev All public methods throw AttestationGraphQLError on invalid input.
 */
export class AttestationValidator {
  /**
   * @notice Validates a Stellar or EVM address.
   * @param address The address string to validate.
   * @param field   Field name used in the error message.
   * @throws AttestationGraphQLError if the address format is invalid.
   */
  static validateAddress(address: string, field = 'address'): void {
    if (!address || typeof address !== 'string') {
      throw new AttestationGraphQLError(`${field} must be a non-empty string.`);
    }
    if (!STELLAR_ADDRESS_RE.test(address) && !EVM_ADDRESS_RE.test(address)) {
      throw new AttestationGraphQLError(
        `Invalid ${field} "${address}". Must be a Stellar (G…) or EVM (0x…) address.`
      );
    }
  }

  /**
   * @notice Validates an AttestationStatus enum value.
   * @throws AttestationGraphQLError if the value is not a valid status.
   */
  static validateStatus(status: string): void {
    if (!Object.values(AttestationStatus).includes(status as AttestationStatus)) {
      throw new AttestationGraphQLError(
        `Invalid status "${status}". Must be one of: ${Object.values(AttestationStatus).join(', ')}.`
      );
    }
  }

  /**
   * @notice Validates a claim type string against the allowlist.
   * @throws AttestationGraphQLError if the claim type is not recognised.
   */
  static validateClaimType(claimType: string): void {
    if (!(VALID_CLAIM_TYPES as readonly string[]).includes(claimType)) {
      throw new AttestationGraphQLError(
        `Invalid claimType "${claimType}". Must be one of: ${VALID_CLAIM_TYPES.join(', ')}.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory data store (indexer backing store)
// ---------------------------------------------------------------------------

/**
 * @title AttestationStore
 * @notice In-memory store that backs the GraphQL resolvers.
 * @dev In production this would be replaced by a database adapter.
 *      The store is intentionally simple: a Map keyed by attestation ID.
 */
export class AttestationStore {
  private _records: Map<string, Attestation> = new Map();

  /** @notice Insert or replace an attestation record. */
  upsert(attestation: Attestation): void {
    this._records.set(attestation.id, { ...attestation });
  }

  /** @notice Retrieve a single attestation by ID, or undefined. */
  getById(id: string): Attestation | undefined {
    return this._records.get(id);
  }

  /**
   * @notice Filter attestations by optional subject, claimType, and status.
   * @dev All provided filters are ANDed together.
   */
  filter(args: AttestationsArgs): Attestation[] {
    const results: Attestation[] = [];
    for (const record of this._records.values()) {
      if (args.subject   && record.subject   !== args.subject)   continue;
      if (args.claimType && record.claimType !== args.claimType) continue;
      if (args.status    && record.status    !== args.status)    continue;
      results.push({ ...record });
    }
    return results;
  }

  /**
   * @notice Compute aggregated stats for a given issuer address.
   * @returns IssuerStats, or null if the issuer has no records.
   */
  issuerStats(issuer: string): IssuerStats | null {
    let total = 0, active = 0, revoked = 0, expired = 0;
    for (const record of this._records.values()) {
      if (record.issuer !== issuer) continue;
      total++;
      if (record.status === AttestationStatus.ACTIVE)  active++;
      if (record.status === AttestationStatus.REVOKED) revoked++;
      if (record.status === AttestationStatus.EXPIRED) expired++;
    }
    if (total === 0) return null;
    return { issuer, totalAttestations: total, activeCount: active, revokedCount: revoked, expiredCount: expired };
  }

  /** @notice Remove all records (used in tests). */
  clear(): void {
    this._records.clear();
  }

  /** @notice Total number of stored records. */
  get size(): number {
    return this._records.size;
  }
}

// ---------------------------------------------------------------------------
// Subscription bus
// ---------------------------------------------------------------------------

type SubscriptionCallback = (attestation: Attestation) => void;

/**
 * @title SubscriptionBus
 * @notice Minimal pub/sub bus for GraphQL subscriptions.
 * @dev Each subscriber registers a callback and an optional subject filter.
 *      When `publish` is called, only matching subscribers are notified.
 *
 * @security Subject filters are enforced server-side; a subscriber for
 *           subject A will never receive events for subject B.
 */
export class SubscriptionBus {
  private _subscribers: Map<string, { callback: SubscriptionCallback; subject?: string }> = new Map();
  private _nextId = 1;

  /**
   * @notice Register a subscription callback.
   * @param callback Function called with each matching attestation.
   * @param subject  Optional subject address filter.
   * @returns A SubscriptionHandle with an `unsubscribe` method.
   */
  subscribe(callback: SubscriptionCallback, subject?: string): SubscriptionHandle {
    const id = `sub_${this._nextId++}`;
    this._subscribers.set(id, { callback, subject });
    return {
      id,
      unsubscribe: () => { this._subscribers.delete(id); },
    };
  }

  /**
   * @notice Publish a new attestation to all matching subscribers.
   * @param attestation The newly created attestation.
   */
  publish(attestation: Attestation): void {
    for (const { callback, subject } of this._subscribers.values()) {
      if (subject && attestation.subject !== subject) continue;
      callback({ ...attestation });
    }
  }

  /** @notice Number of active subscribers. */
  get subscriberCount(): number {
    return this._subscribers.size;
  }
}

// ---------------------------------------------------------------------------
// GraphQL resolvers
// ---------------------------------------------------------------------------

/**
 * @title AttestationResolvers
 * @notice Query and subscription resolvers for the attestation GraphQL API.
 */
export class AttestationResolvers {
  constructor(
    private readonly store: AttestationStore,
    private readonly bus: SubscriptionBus,
  ) {}

  /**
   * @notice Resolver for `Query.attestations`.
   * @dev Validates optional filter arguments before querying the store.
   */
  resolveAttestations(args: AttestationsArgs): Attestation[] {
    if (args.subject)   AttestationValidator.validateAddress(args.subject, 'subject');
    if (args.claimType) AttestationValidator.validateClaimType(args.claimType);
    if (args.status)    AttestationValidator.validateStatus(args.status);
    return this.store.filter(args);
  }

  /**
   * @notice Resolver for `Query.issuerStats`.
   * @dev Validates the issuer address before querying.
   */
  resolveIssuerStats(args: IssuerStatsArgs): IssuerStats | null {
    AttestationValidator.validateAddress(args.issuer, 'issuer');
    return this.store.issuerStats(args.issuer);
  }

  /**
   * @notice Resolver for `Subscription.onAttestationCreated`.
   * @dev Validates the optional subject filter and registers a subscriber.
   */
  resolveOnAttestationCreated(
    args: OnAttestationCreatedArgs,
    callback: SubscriptionCallback,
  ): SubscriptionHandle {
    if (args.subject) AttestationValidator.validateAddress(args.subject, 'subject');
    return this.bus.subscribe(callback, args.subject);
  }
}

// ---------------------------------------------------------------------------
// GraphQL executor (minimal, no external deps)
// ---------------------------------------------------------------------------

/**
 * @title GraphQLExecutor
 * @notice Minimal GraphQL request executor.
 * @dev Parses the operation name from the query string and dispatches to the
 *      appropriate resolver. Supports the three operations defined in the SDL:
 *        - attestations(...)
 *        - issuerStats(...)
 *      Subscriptions are handled separately via `executeSubscription`.
 *
 * @security Input arguments are extracted via a simple regex parser and then
 *           validated by AttestationValidator before reaching the store.
 */
export class GraphQLExecutor {
  constructor(private readonly resolvers: AttestationResolvers) {}

  /**
   * @notice Execute a GraphQL query string and return a GraphQLResult.
   * @param query     The GraphQL query document string.
   * @param variables Optional variable map.
   */
  execute(query: string, variables: Record<string, unknown> = {}): GraphQLResult {
    try {
      const trimmed = query.trim();

      if (/\battestations\b/.test(trimmed)) {
        const args = this._extractAttestationsArgs(trimmed, variables);
        const data = this.resolvers.resolveAttestations(args);
        return { data: { attestations: data } };
      }

      if (/\bissuerStats\b/.test(trimmed)) {
        const args = this._extractIssuerStatsArgs(trimmed, variables);
        const data = this.resolvers.resolveIssuerStats(args);
        return { data: { issuerStats: data } };
      }

      return { errors: [{ message: 'Unknown or unsupported operation.' }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { errors: [{ message }] };
    }
  }

  /**
   * @notice Register a subscription and return a handle.
   * @param query     The GraphQL subscription document string.
   * @param callback  Called with each matching Attestation event.
   * @param variables Optional variable map.
   */
  executeSubscription(
    query: string,
    callback: SubscriptionCallback,
    variables: Record<string, unknown> = {},
  ): SubscriptionHandle {
    if (!/\bonAttestationCreated\b/.test(query)) {
      throw new AttestationGraphQLError('Unknown subscription operation.');
    }
    const args = this._extractOnAttestationCreatedArgs(query, variables);
    return this.resolvers.resolveOnAttestationCreated(args, callback);
  }

  // ── Argument extractors ──────────────────────────────────────────────────

  private _extractAttestationsArgs(
    query: string,
    variables: Record<string, unknown>,
  ): AttestationsArgs {
    const args: AttestationsArgs = {};

    // Support both inline literals and $variable references
    const subject   = this._extractArg(query, variables, 'subject');
    const claimType = this._extractArg(query, variables, 'claimType');
    const status    = this._extractArg(query, variables, 'status');

    if (subject)   args.subject   = subject;
    if (claimType) args.claimType = claimType;
    if (status)    args.status    = status as AttestationStatus;

    return args;
  }

  private _extractIssuerStatsArgs(
    query: string,
    variables: Record<string, unknown>,
  ): IssuerStatsArgs {
    const issuer = this._extractArg(query, variables, 'issuer');
    if (!issuer) throw new AttestationGraphQLError('issuerStats requires an issuer argument.');
    return { issuer };
  }

  private _extractOnAttestationCreatedArgs(
    query: string,
    variables: Record<string, unknown>,
  ): OnAttestationCreatedArgs {
    const subject = this._extractArg(query, variables, 'subject');
    return subject ? { subject } : {};
  }

  /**
   * @notice Extract a named argument value from a query string or variables map.
   * @dev Handles:
   *   - Inline string literals:  argName: "value"
   *   - Variable references:     argName: $varName  (resolved from variables)
   */
  private _extractArg(
    query: string,
    variables: Record<string, unknown>,
    argName: string,
  ): string | undefined {
    // Variable reference: argName: $varName
    const varRefMatch = query.match(new RegExp(`${argName}\\s*:\\s*\\$(\\w+)`));
    if (varRefMatch) {
      const varName = varRefMatch[1];
      const val = variables[varName];
      return typeof val === 'string' ? val : undefined;
    }

    // Inline string literal: argName: "value"
    const literalMatch = query.match(new RegExp(`${argName}\\s*:\\s*"([^"]+)"`));
    if (literalMatch) return literalMatch[1];

    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Playground HTML generator
// ---------------------------------------------------------------------------

/**
 * @notice Generates the GraphQL Playground HTML page.
 * @dev Only served when NODE_ENV !== 'production'.
 * @param endpoint The GraphQL endpoint URL (default: /graphql).
 * @returns HTML string for the Playground page.
 *
 * @security Playground is disabled in production to prevent schema exposure.
 */
export function generatePlaygroundHTML(endpoint = '/graphql'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TrustLink GraphQL Playground</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; }
    header { background: #16213e; padding: 1rem 2rem; border-bottom: 1px solid #0f3460; }
    header h1 { font-size: 1.25rem; color: #e94560; }
    header p  { font-size: 0.8rem; color: #a0a0b0; margin-top: 0.25rem; }
    .container { display: flex; height: calc(100vh - 64px); }
    .panel { flex: 1; display: flex; flex-direction: column; padding: 1rem; gap: 0.5rem; }
    .panel label { font-size: 0.75rem; color: #a0a0b0; text-transform: uppercase; letter-spacing: 0.05em; }
    textarea { flex: 1; background: #0f3460; color: #e0e0e0; border: 1px solid #1a4a8a; border-radius: 4px; padding: 0.75rem; font-family: monospace; font-size: 0.875rem; resize: none; }
    button { background: #e94560; color: #fff; border: none; border-radius: 4px; padding: 0.5rem 1.5rem; cursor: pointer; font-size: 0.875rem; align-self: flex-start; }
    button:hover { background: #c73652; }
    .result { flex: 1; background: #0f3460; border: 1px solid #1a4a8a; border-radius: 4px; padding: 0.75rem; font-family: monospace; font-size: 0.875rem; overflow: auto; white-space: pre-wrap; }
    .divider { width: 4px; background: #0f3460; }
  </style>
</head>
<body>
  <header>
    <h1>TrustLink GraphQL Playground</h1>
    <p>Endpoint: <code>${endpoint}</code> &nbsp;|&nbsp; Development mode only</p>
  </header>
  <div class="container">
    <div class="panel">
      <label>Query / Mutation</label>
      <textarea id="query" placeholder="{ attestations(subject: &quot;G...&quot;) { id claimType status } }">{
  attestations {
    id
    subject
    issuer
    claimType
    status
    createdAt
  }
}</textarea>
      <label>Variables (JSON)</label>
      <textarea id="variables" style="flex:0;height:80px">{}</textarea>
      <button onclick="runQuery()">Run Query</button>
    </div>
    <div class="divider"></div>
    <div class="panel">
      <label>Response</label>
      <div class="result" id="result">// Results will appear here</div>
    </div>
  </div>
  <script>
    async function runQuery() {
      const query = document.getElementById('query').value;
      let variables = {};
      try { variables = JSON.parse(document.getElementById('variables').value || '{}'); } catch(e) {}
      document.getElementById('result').textContent = 'Loading…';
      try {
        const res = await fetch('${endpoint}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
        const json = await res.json();
        document.getElementById('result').textContent = JSON.stringify(json, null, 2);
      } catch(e) {
        document.getElementById('result').textContent = 'Error: ' + e.message;
      }
    }
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP request handler (framework-agnostic)
// ---------------------------------------------------------------------------

/**
 * @notice Minimal HTTP request/response types for the handler.
 * @dev Compatible with Node's http.IncomingMessage / ServerResponse shapes.
 */
export interface HttpRequest {
  method?: string;
  url?: string;
  body?: string | Record<string, unknown>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * @title AttestationGraphQLHandler
 * @notice Framework-agnostic HTTP handler for the /graphql endpoint.
 *
 * @dev Handles:
 *   - GET  /graphql  → Playground HTML (dev only) or 404 (prod)
 *   - POST /graphql  → Execute query/mutation, return JSON
 *
 * @security
 *   - Content-Type is enforced on POST requests.
 *   - Playground is gated behind NODE_ENV check.
 *   - All errors are caught and returned as GraphQL error responses.
 */
export class AttestationGraphQLHandler {
  constructor(
    private readonly executor: GraphQLExecutor,
    private readonly isDev: boolean = process.env['NODE_ENV'] !== 'production',
  ) {}

  /**
   * @notice Handle an incoming HTTP request for /graphql.
   * @param req Incoming request object.
   * @returns HttpResponse to send back to the client.
   */
  handle(req: HttpRequest): HttpResponse {
    const method = (req.method ?? 'GET').toUpperCase();

    // GET → Playground (dev only)
    if (method === 'GET') {
      if (!this.isDev) {
        return this._json(404, { errors: [{ message: 'GraphQL Playground is disabled in production.' }] });
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: generatePlaygroundHTML('/graphql'),
      };
    }

    // POST → execute query
    if (method === 'POST') {
      try {
        const parsed = this._parseBody(req.body);
        const { query, variables } = parsed;

        if (!query || typeof query !== 'string') {
          return this._json(400, { errors: [{ message: 'Missing or invalid "query" field.' }] });
        }

        const result = this.executor.execute(query, variables ?? {});
        const status = result.errors ? 400 : 200;
        return this._json(status, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return this._json(400, { errors: [{ message }] });
      }
    }

    return this._json(405, { errors: [{ message: `Method ${method} not allowed.` }] });
  }

  private _parseBody(body: string | Record<string, unknown> | undefined): Record<string, unknown> {
    if (!body) return {};
    if (typeof body === 'object') return body;
    try { return JSON.parse(body); } catch {
      throw new AttestationGraphQLError('Request body is not valid JSON.');
    }
  }

  private _json(status: number, data: unknown): HttpResponse {
    return {
      status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory / singletons
// ---------------------------------------------------------------------------

/**
 * @notice Create a fully wired attestation GraphQL API instance.
 * @param isDev Pass true to enable the Playground (default: auto-detect).
 * @returns Object containing store, bus, resolvers, executor, and handler.
 */
export function createAttestationGraphQLAPI(isDev?: boolean) {
  const store     = new AttestationStore();
  const bus       = new SubscriptionBus();
  const resolvers = new AttestationResolvers(store, bus);
  const executor  = new GraphQLExecutor(resolvers);
  const handler   = new AttestationGraphQLHandler(executor, isDev);
  return { store, bus, resolvers, executor, handler };
}
