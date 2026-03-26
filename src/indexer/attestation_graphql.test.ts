/**
 * @title Attestation GraphQL API – Test Suite
 * @notice Comprehensive tests for all resolvers, validators, store,
 *         subscription bus, executor, HTTP handler, and Playground.
 * @author TrustLink / Stellar Raise Contracts Team
 *
 * Run: node node_modules/jest/bin/jest.js src/indexer/attestation_graphql.test.ts --coverage --forceExit
 */

import {
  AttestationStatus,
  AttestationValidator,
  AttestationGraphQLError,
  AttestationStore,
  SubscriptionBus,
  AttestationResolvers,
  GraphQLExecutor,
  AttestationGraphQLHandler,
  generatePlaygroundHTML,
  createAttestationGraphQLAPI,
  GRAPHQL_SCHEMA_SDL,
  VALID_CLAIM_TYPES,
  type Attestation,
} from './attestation_graphql';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STELLAR_ADDR_A = 'G' + 'A'.repeat(55);
const STELLAR_ADDR_B = 'G' + 'B'.repeat(55);
const STELLAR_ADDR_C = 'G' + 'C'.repeat(55);
const EVM_ADDR       = '0x' + 'a'.repeat(40);

function makeAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id:        overrides.id        ?? 'att_001',
    subject:   overrides.subject   ?? STELLAR_ADDR_A,
    issuer:    overrides.issuer    ?? STELLAR_ADDR_B,
    claimType: overrides.claimType ?? 'KYC',
    status:    overrides.status    ?? AttestationStatus.ACTIVE,
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00Z',
    expiresAt: overrides.expiresAt ?? null,
    metadata:  overrides.metadata  ?? '{}',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AttestationValidator
// ---------------------------------------------------------------------------

describe('AttestationValidator', () => {
  describe('validateAddress', () => {
    it('accepts a valid Stellar address', () => {
      expect(() => AttestationValidator.validateAddress(STELLAR_ADDR_A)).not.toThrow();
    });
    it('accepts a valid EVM address', () => {
      expect(() => AttestationValidator.validateAddress(EVM_ADDR)).not.toThrow();
    });
    it('throws for empty string', () => {
      expect(() => AttestationValidator.validateAddress('')).toThrow(AttestationGraphQLError);
    });
    it('throws for invalid address', () => {
      expect(() => AttestationValidator.validateAddress('not-an-address')).toThrow(AttestationGraphQLError);
    });
    it('throws for Stellar address that is too short', () => {
      expect(() => AttestationValidator.validateAddress('GABC')).toThrow(AttestationGraphQLError);
    });
    it('throws for EVM address with wrong length', () => {
      expect(() => AttestationValidator.validateAddress('0xabc')).toThrow(AttestationGraphQLError);
    });
    it('includes field name in error message', () => {
      expect(() => AttestationValidator.validateAddress('bad', 'subject')).toThrow(/subject/);
    });
  });

  describe('validateStatus', () => {
    it.each(Object.values(AttestationStatus))('accepts %s', (s) => {
      expect(() => AttestationValidator.validateStatus(s)).not.toThrow();
    });
    it('throws for unknown status', () => {
      expect(() => AttestationValidator.validateStatus('PENDING')).toThrow(AttestationGraphQLError);
    });
    it('throws for empty string', () => {
      expect(() => AttestationValidator.validateStatus('')).toThrow(AttestationGraphQLError);
    });
  });

  describe('validateClaimType', () => {
    it.each([...VALID_CLAIM_TYPES])('accepts %s', (ct) => {
      expect(() => AttestationValidator.validateClaimType(ct)).not.toThrow();
    });
    it('throws for unknown claim type', () => {
      expect(() => AttestationValidator.validateClaimType('UNKNOWN')).toThrow(AttestationGraphQLError);
    });
    it('throws for empty string', () => {
      expect(() => AttestationValidator.validateClaimType('')).toThrow(AttestationGraphQLError);
    });
  });
});

// ---------------------------------------------------------------------------
// AttestationStore
// ---------------------------------------------------------------------------

describe('AttestationStore', () => {
  let store: AttestationStore;
  beforeEach(() => { store = new AttestationStore(); });

  it('starts empty', () => { expect(store.size).toBe(0); });

  it('upserts and retrieves by id', () => {
    const att = makeAttestation();
    store.upsert(att);
    expect(store.getById('att_001')).toMatchObject({ id: 'att_001' });
  });

  it('returns undefined for unknown id', () => {
    expect(store.getById('nope')).toBeUndefined();
  });

  it('overwrites on duplicate id', () => {
    store.upsert(makeAttestation({ status: AttestationStatus.ACTIVE }));
    store.upsert(makeAttestation({ status: AttestationStatus.REVOKED }));
    expect(store.getById('att_001')!.status).toBe(AttestationStatus.REVOKED);
    expect(store.size).toBe(1);
  });

  it('clears all records', () => {
    store.upsert(makeAttestation());
    store.clear();
    expect(store.size).toBe(0);
  });

  describe('filter', () => {
    beforeEach(() => {
      store.upsert(makeAttestation({ id: '1', subject: STELLAR_ADDR_A, claimType: 'KYC',  status: AttestationStatus.ACTIVE  }));
      store.upsert(makeAttestation({ id: '2', subject: STELLAR_ADDR_A, claimType: 'AML',  status: AttestationStatus.REVOKED }));
      store.upsert(makeAttestation({ id: '3', subject: STELLAR_ADDR_B, claimType: 'KYC',  status: AttestationStatus.ACTIVE  }));
      store.upsert(makeAttestation({ id: '4', subject: STELLAR_ADDR_B, claimType: 'KYC',  status: AttestationStatus.EXPIRED }));
    });

    it('returns all records when no filter', () => {
      expect(store.filter({})).toHaveLength(4);
    });
    it('filters by subject', () => {
      expect(store.filter({ subject: STELLAR_ADDR_A })).toHaveLength(2);
    });
    it('filters by claimType', () => {
      expect(store.filter({ claimType: 'KYC' })).toHaveLength(3);
    });
    it('filters by status', () => {
      expect(store.filter({ status: AttestationStatus.ACTIVE })).toHaveLength(2);
    });
    it('combines subject + claimType', () => {
      expect(store.filter({ subject: STELLAR_ADDR_A, claimType: 'KYC' })).toHaveLength(1);
    });
    it('combines subject + status', () => {
      expect(store.filter({ subject: STELLAR_ADDR_B, status: AttestationStatus.ACTIVE })).toHaveLength(1);
    });
    it('returns empty array when no match', () => {
      expect(store.filter({ subject: STELLAR_ADDR_C })).toHaveLength(0);
    });
  });

  describe('issuerStats', () => {
    it('returns null for unknown issuer', () => {
      expect(store.issuerStats(STELLAR_ADDR_C)).toBeNull();
    });
    it('returns correct counts', () => {
      store.upsert(makeAttestation({ id: '1', issuer: STELLAR_ADDR_B, status: AttestationStatus.ACTIVE  }));
      store.upsert(makeAttestation({ id: '2', issuer: STELLAR_ADDR_B, status: AttestationStatus.REVOKED }));
      store.upsert(makeAttestation({ id: '3', issuer: STELLAR_ADDR_B, status: AttestationStatus.EXPIRED }));
      store.upsert(makeAttestation({ id: '4', issuer: STELLAR_ADDR_C, status: AttestationStatus.ACTIVE  }));
      const stats = store.issuerStats(STELLAR_ADDR_B)!;
      expect(stats.totalAttestations).toBe(3);
      expect(stats.activeCount).toBe(1);
      expect(stats.revokedCount).toBe(1);
      expect(stats.expiredCount).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// SubscriptionBus
// ---------------------------------------------------------------------------

describe('SubscriptionBus', () => {
  let bus: SubscriptionBus;
  beforeEach(() => { bus = new SubscriptionBus(); });

  it('starts with zero subscribers', () => {
    expect(bus.subscriberCount).toBe(0);
  });

  it('increments subscriber count on subscribe', () => {
    bus.subscribe(jest.fn());
    expect(bus.subscriberCount).toBe(1);
  });

  it('decrements subscriber count on unsubscribe', () => {
    const handle = bus.subscribe(jest.fn());
    handle.unsubscribe();
    expect(bus.subscriberCount).toBe(0);
  });

  it('delivers event to all subscribers', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    bus.subscribe(cb1);
    bus.subscribe(cb2);
    const att = makeAttestation();
    bus.publish(att);
    expect(cb1).toHaveBeenCalledWith(att);
    expect(cb2).toHaveBeenCalledWith(att);
  });

  it('filters by subject — matching subscriber receives event', () => {
    const cb = jest.fn();
    bus.subscribe(cb, STELLAR_ADDR_A);
    bus.publish(makeAttestation({ subject: STELLAR_ADDR_A }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('filters by subject — non-matching subscriber does NOT receive event', () => {
    const cb = jest.fn();
    bus.subscribe(cb, STELLAR_ADDR_B);
    bus.publish(makeAttestation({ subject: STELLAR_ADDR_A }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('unfiltered subscriber receives all events', () => {
    const cb = jest.fn();
    bus.subscribe(cb);
    bus.publish(makeAttestation({ subject: STELLAR_ADDR_A }));
    bus.publish(makeAttestation({ subject: STELLAR_ADDR_B }));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('returns unique subscription IDs', () => {
    const h1 = bus.subscribe(jest.fn());
    const h2 = bus.subscribe(jest.fn());
    expect(h1.id).not.toBe(h2.id);
  });

  it('delivers a copy of the attestation (not the same reference)', () => {
    const received: Attestation[] = [];
    bus.subscribe((a) => received.push(a));
    const original = makeAttestation();
    bus.publish(original);
    expect(received[0]).toEqual(original);
    expect(received[0]).not.toBe(original);
  });
});

// ---------------------------------------------------------------------------
// AttestationResolvers
// ---------------------------------------------------------------------------

describe('AttestationResolvers', () => {
  let store: AttestationStore;
  let bus: SubscriptionBus;
  let resolvers: AttestationResolvers;

  beforeEach(() => {
    store = new AttestationStore();
    bus   = new SubscriptionBus();
    resolvers = new AttestationResolvers(store, bus);
    store.upsert(makeAttestation({ id: '1', subject: STELLAR_ADDR_A, claimType: 'KYC',  status: AttestationStatus.ACTIVE  }));
    store.upsert(makeAttestation({ id: '2', subject: STELLAR_ADDR_B, claimType: 'AML',  status: AttestationStatus.REVOKED, issuer: STELLAR_ADDR_C }));
  });

  describe('resolveAttestations', () => {
    it('returns all attestations with no args', () => {
      expect(resolvers.resolveAttestations({})).toHaveLength(2);
    });
    it('filters by subject', () => {
      const res = resolvers.resolveAttestations({ subject: STELLAR_ADDR_A });
      expect(res).toHaveLength(1);
      expect(res[0].subject).toBe(STELLAR_ADDR_A);
    });
    it('filters by claimType', () => {
      expect(resolvers.resolveAttestations({ claimType: 'AML' })).toHaveLength(1);
    });
    it('filters by status', () => {
      expect(resolvers.resolveAttestations({ status: AttestationStatus.REVOKED })).toHaveLength(1);
    });
    it('throws for invalid subject address', () => {
      expect(() => resolvers.resolveAttestations({ subject: 'bad' })).toThrow(AttestationGraphQLError);
    });
    it('throws for invalid claimType', () => {
      expect(() => resolvers.resolveAttestations({ claimType: 'UNKNOWN' })).toThrow(AttestationGraphQLError);
    });
    it('throws for invalid status', () => {
      expect(() => resolvers.resolveAttestations({ status: 'PENDING' as AttestationStatus })).toThrow(AttestationGraphQLError);
    });
  });

  describe('resolveIssuerStats', () => {
    it('returns stats for a known issuer', () => {
      const stats = resolvers.resolveIssuerStats({ issuer: STELLAR_ADDR_B });
      expect(stats).not.toBeNull();
      expect(stats!.totalAttestations).toBe(1);
    });
    it('returns null for unknown issuer', () => {
      expect(resolvers.resolveIssuerStats({ issuer: STELLAR_ADDR_A })).toBeNull();
    });
    it('throws for invalid issuer address', () => {
      expect(() => resolvers.resolveIssuerStats({ issuer: 'bad' })).toThrow(AttestationGraphQLError);
    });
  });

  describe('resolveOnAttestationCreated', () => {
    it('registers a subscription and returns a handle', () => {
      const handle = resolvers.resolveOnAttestationCreated({}, jest.fn());
      expect(handle.id).toBeTruthy();
      expect(typeof handle.unsubscribe).toBe('function');
      handle.unsubscribe();
    });
    it('delivers events to the callback', () => {
      const cb = jest.fn();
      resolvers.resolveOnAttestationCreated({}, cb);
      const att = makeAttestation({ id: 'new' });
      bus.publish(att);
      expect(cb).toHaveBeenCalledWith(att);
    });
    it('filters by subject when provided', () => {
      const cb = jest.fn();
      resolvers.resolveOnAttestationCreated({ subject: STELLAR_ADDR_A }, cb);
      bus.publish(makeAttestation({ subject: STELLAR_ADDR_B }));
      expect(cb).not.toHaveBeenCalled();
      bus.publish(makeAttestation({ subject: STELLAR_ADDR_A }));
      expect(cb).toHaveBeenCalledTimes(1);
    });
    it('throws for invalid subject address', () => {
      expect(() => resolvers.resolveOnAttestationCreated({ subject: 'bad' }, jest.fn())).toThrow(AttestationGraphQLError);
    });
  });
});

// ---------------------------------------------------------------------------
// GraphQLExecutor
// ---------------------------------------------------------------------------

describe('GraphQLExecutor', () => {
  let api: ReturnType<typeof createAttestationGraphQLAPI>;
  beforeEach(() => {
    api = createAttestationGraphQLAPI(true);
    api.store.upsert(makeAttestation({ id: '1', subject: STELLAR_ADDR_A, claimType: 'KYC', status: AttestationStatus.ACTIVE, issuer: STELLAR_ADDR_B }));
    api.store.upsert(makeAttestation({ id: '2', subject: STELLAR_ADDR_B, claimType: 'AML', status: AttestationStatus.REVOKED, issuer: STELLAR_ADDR_B }));
  });

  describe('attestations query', () => {
    it('returns all attestations with no filter', () => {
      const res = api.executor.execute('{ attestations { id } }');
      expect(res.errors).toBeUndefined();
      expect((res.data!.attestations as Attestation[])).toHaveLength(2);
    });

    it('filters by inline subject literal', () => {
      const res = api.executor.execute(`{ attestations(subject: "${STELLAR_ADDR_A}") { id } }`);
      expect(res.errors).toBeUndefined();
      expect((res.data!.attestations as Attestation[])).toHaveLength(1);
    });

    it('filters by subject via variable', () => {
      const res = api.executor.execute(
        'query Q($s: String) { attestations(subject: $s) { id } }',
        { s: STELLAR_ADDR_A },
      );
      expect(res.errors).toBeUndefined();
      expect((res.data!.attestations as Attestation[])).toHaveLength(1);
    });

    it('filters by claimType inline', () => {
      const res = api.executor.execute('{ attestations(claimType: "AML") { id } }');
      expect((res.data!.attestations as Attestation[])).toHaveLength(1);
    });

    it('filters by status inline', () => {
      const res = api.executor.execute('{ attestations(status: "ACTIVE") { id } }');
      expect((res.data!.attestations as Attestation[])).toHaveLength(1);
    });

    it('returns error for invalid subject', () => {
      const res = api.executor.execute('{ attestations(subject: "bad") { id } }');
      expect(res.errors).toBeDefined();
      expect(res.errors![0].message).toMatch(/subject/i);
    });

    it('returns error for invalid claimType', () => {
      const res = api.executor.execute('{ attestations(claimType: "UNKNOWN") { id } }');
      expect(res.errors).toBeDefined();
    });

    it('returns error for invalid status', () => {
      const res = api.executor.execute('{ attestations(status: "PENDING") { id } }');
      expect(res.errors).toBeDefined();
    });
  });

  describe('issuerStats query', () => {
    it('returns stats for known issuer', () => {
      const res = api.executor.execute(`{ issuerStats(issuer: "${STELLAR_ADDR_B}") { totalAttestations activeCount revokedCount expiredCount } }`);
      expect(res.errors).toBeUndefined();
      const stats = res.data!.issuerStats as { totalAttestations: number };
      expect(stats.totalAttestations).toBe(2);
    });

    it('returns null for unknown issuer', () => {
      const res = api.executor.execute(`{ issuerStats(issuer: "${STELLAR_ADDR_A}") { totalAttestations } }`);
      expect(res.errors).toBeUndefined();
      expect(res.data!.issuerStats).toBeNull();
    });

    it('returns error when issuer arg is missing', () => {
      const res = api.executor.execute('{ issuerStats { totalAttestations } }');
      expect(res.errors).toBeDefined();
    });

    it('returns error for invalid issuer address', () => {
      const res = api.executor.execute('{ issuerStats(issuer: "bad") { totalAttestations } }');
      expect(res.errors).toBeDefined();
    });

    it('resolves issuer via variable', () => {
      const res = api.executor.execute(
        'query Q($i: String!) { issuerStats(issuer: $i) { totalAttestations } }',
        { i: STELLAR_ADDR_B },
      );
      expect(res.errors).toBeUndefined();
    });
  });

  describe('unknown operation', () => {
    it('returns error for unrecognised query', () => {
      const res = api.executor.execute('{ unknownField }');
      expect(res.errors).toBeDefined();
      expect(res.errors![0].message).toMatch(/unknown/i);
    });
  });

  describe('executeSubscription', () => {
    it('registers subscription for onAttestationCreated', () => {
      const cb = jest.fn();
      const handle = api.executor.executeSubscription(
        'subscription { onAttestationCreated { id } }', cb,
      );
      expect(handle.id).toBeTruthy();
      api.bus.publish(makeAttestation({ id: 'new' }));
      expect(cb).toHaveBeenCalledTimes(1);
      handle.unsubscribe();
    });

    it('filters subscription by subject variable', () => {
      const cb = jest.fn();
      const handle = api.executor.executeSubscription(
        'subscription S($s: String) { onAttestationCreated(subject: $s) { id } }',
        cb,
        { s: STELLAR_ADDR_A },
      );
      api.bus.publish(makeAttestation({ subject: STELLAR_ADDR_B }));
      expect(cb).not.toHaveBeenCalled();
      api.bus.publish(makeAttestation({ subject: STELLAR_ADDR_A }));
      expect(cb).toHaveBeenCalledTimes(1);
      handle.unsubscribe();
    });

    it('throws for unknown subscription operation', () => {
      expect(() =>
        api.executor.executeSubscription('subscription { unknownEvent { id } }', jest.fn())
      ).toThrow(AttestationGraphQLError);
    });
  });
});

// ---------------------------------------------------------------------------
// AttestationGraphQLHandler (HTTP)
// ---------------------------------------------------------------------------

describe('AttestationGraphQLHandler', () => {
  let api: ReturnType<typeof createAttestationGraphQLAPI>;
  beforeEach(() => {
    api = createAttestationGraphQLAPI(true);
    api.store.upsert(makeAttestation({ id: '1', subject: STELLAR_ADDR_A, claimType: 'KYC', status: AttestationStatus.ACTIVE }));
  });

  describe('GET /graphql (Playground)', () => {
    it('returns 200 HTML in dev mode', () => {
      const res = api.handler.handle({ method: 'GET', url: '/graphql' });
      expect(res.status).toBe(200);
      expect(res.headers['Content-Type']).toMatch(/text\/html/);
      expect(res.body).toContain('TrustLink GraphQL Playground');
    });

    it('returns 404 in production mode', () => {
      const { handler } = createAttestationGraphQLAPI(false);
      const res = handler.handle({ method: 'GET', url: '/graphql' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /graphql (query execution)', () => {
    it('executes attestations query from JSON body string', () => {
      const res = api.handler.handle({
        method: 'POST',
        body: JSON.stringify({ query: '{ attestations { id } }' }),
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.data.attestations).toHaveLength(1);
    });

    it('executes attestations query from parsed body object', () => {
      const res = api.handler.handle({
        method: 'POST',
        body: { query: '{ attestations { id } }' },
      });
      expect(res.status).toBe(200);
    });

    it('returns 400 when query field is missing', () => {
      const res = api.handler.handle({ method: 'POST', body: '{}' });
      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.errors[0].message).toMatch(/query/i);
    });

    it('returns 400 for invalid JSON body', () => {
      const res = api.handler.handle({ method: 'POST', body: 'not-json' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for query with validation error', () => {
      const res = api.handler.handle({
        method: 'POST',
        body: { query: '{ attestations(subject: "bad") { id } }' },
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when body is empty', () => {
      const res = api.handler.handle({ method: 'POST', body: undefined });
      expect(res.status).toBe(400);
    });

    it('passes variables to executor', () => {
      const res = api.handler.handle({
        method: 'POST',
        body: {
          query: 'query Q($s: String) { attestations(subject: $s) { id } }',
          variables: { s: STELLAR_ADDR_A },
        },
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.data.attestations).toHaveLength(1);
    });
  });

  describe('unsupported methods', () => {
    it('returns 405 for PUT', () => {
      const res = api.handler.handle({ method: 'PUT' });
      expect(res.status).toBe(405);
    });
    it('returns 405 for DELETE', () => {
      const res = api.handler.handle({ method: 'DELETE' });
      expect(res.status).toBe(405);
    });
    it('defaults to GET when method is undefined', () => {
      const res = api.handler.handle({ url: '/graphql' });
      expect(res.status).toBe(200); // dev mode → playground
    });
  });
});

// ---------------------------------------------------------------------------
// generatePlaygroundHTML
// ---------------------------------------------------------------------------

describe('generatePlaygroundHTML', () => {
  it('contains the endpoint URL', () => {
    const html = generatePlaygroundHTML('/graphql');
    expect(html).toContain('/graphql');
  });
  it('contains the page title', () => {
    expect(generatePlaygroundHTML()).toContain('TrustLink GraphQL Playground');
  });
  it('uses custom endpoint when provided', () => {
    const html = generatePlaygroundHTML('/api/graphql');
    expect(html).toContain('/api/graphql');
  });
  it('is a valid HTML document', () => {
    const html = generatePlaygroundHTML();
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('</html>');
  });
});

// ---------------------------------------------------------------------------
// GRAPHQL_SCHEMA_SDL
// ---------------------------------------------------------------------------

describe('GRAPHQL_SCHEMA_SDL', () => {
  it('is a non-empty string', () => {
    expect(typeof GRAPHQL_SCHEMA_SDL).toBe('string');
    expect(GRAPHQL_SCHEMA_SDL.length).toBeGreaterThan(0);
  });
  it('contains the attestations query', () => {
    expect(GRAPHQL_SCHEMA_SDL).toContain('attestations');
  });
  it('contains the issuerStats query', () => {
    expect(GRAPHQL_SCHEMA_SDL).toContain('issuerStats');
  });
  it('contains the onAttestationCreated subscription', () => {
    expect(GRAPHQL_SCHEMA_SDL).toContain('onAttestationCreated');
  });
  it('defines the Status enum', () => {
    expect(GRAPHQL_SCHEMA_SDL).toContain('enum Status');
  });
  it('defines the Attestation type', () => {
    expect(GRAPHQL_SCHEMA_SDL).toContain('type Attestation');
  });
  it('defines the IssuerStats type', () => {
    expect(GRAPHQL_SCHEMA_SDL).toContain('type IssuerStats');
  });
});

// ---------------------------------------------------------------------------
// createAttestationGraphQLAPI factory
// ---------------------------------------------------------------------------

describe('createAttestationGraphQLAPI', () => {
  it('returns all expected parts', () => {
    const api = createAttestationGraphQLAPI(true);
    expect(api.store).toBeDefined();
    expect(api.bus).toBeDefined();
    expect(api.resolvers).toBeDefined();
    expect(api.executor).toBeDefined();
    expect(api.handler).toBeDefined();
  });

  it('store, bus, resolvers, executor are wired together end-to-end', () => {
    const api = createAttestationGraphQLAPI(true);
    api.store.upsert(makeAttestation({ id: 'e2e', subject: STELLAR_ADDR_A, claimType: 'KYC', status: AttestationStatus.ACTIVE }));

    // Query via executor
    const res = api.executor.execute(`{ attestations(subject: "${STELLAR_ADDR_A}") { id claimType status } }`);
    expect(res.errors).toBeUndefined();
    expect((res.data!.attestations as Attestation[])[0].id).toBe('e2e');

    // Subscription via executor
    const received: Attestation[] = [];
    const handle = api.executor.executeSubscription(
      'subscription { onAttestationCreated { id } }',
      (a) => received.push(a),
    );
    api.bus.publish(makeAttestation({ id: 'live' }));
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('live');
    handle.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Security edge cases
// ---------------------------------------------------------------------------

describe('Security edge cases', () => {
  let api: ReturnType<typeof createAttestationGraphQLAPI>;
  beforeEach(() => { api = createAttestationGraphQLAPI(true); });

  it('rejects SQL-injection-style subject', () => {
    const res = api.executor.execute("{ attestations(subject: \"'; DROP TABLE attestations;--\") { id } }");
    expect(res.errors).toBeDefined();
  });

  it('rejects XSS attempt in subject', () => {
    const res = api.executor.execute('{ attestations(subject: "<script>alert(1)</script>") { id } }');
    expect(res.errors).toBeDefined();
  });

  it('subscription subject filter prevents cross-subject leakage', () => {
    const cbA = jest.fn();
    const cbB = jest.fn();
    api.executor.executeSubscription(
      `subscription { onAttestationCreated(subject: "${STELLAR_ADDR_A}") { id } }`, cbA,
    );
    api.executor.executeSubscription(
      `subscription { onAttestationCreated(subject: "${STELLAR_ADDR_B}") { id } }`, cbB,
    );
    api.bus.publish(makeAttestation({ subject: STELLAR_ADDR_A }));
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).not.toHaveBeenCalled();
  });

  it('playground is disabled in production', () => {
    const { handler } = createAttestationGraphQLAPI(false);
    const res = handler.handle({ method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('<html');
  });

  it('unsubscribe stops event delivery', () => {
    const cb = jest.fn();
    const handle = api.bus.subscribe(cb);
    handle.unsubscribe();
    api.bus.publish(makeAttestation());
    expect(cb).not.toHaveBeenCalled();
  });
});
