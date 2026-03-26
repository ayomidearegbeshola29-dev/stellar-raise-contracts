# Attestation Indexer – GraphQL API

GraphQL endpoint for querying and subscribing to attestation data indexed from the TrustLink smart contract.

## Endpoint

| Method | Path | Description |
|---|---|---|
| `GET` | `/graphql` | GraphQL Playground (development only) |
| `POST` | `/graphql` | Execute query or mutation |
| `WS` | `/graphql` | Subscriptions (`onAttestationCreated`) |

## Schema

```graphql
enum Status {
  ACTIVE
  REVOKED
  EXPIRED
}

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

type IssuerStats {
  issuer: String!
  totalAttestations: Int!
  activeCount: Int!
  revokedCount: Int!
  expiredCount: Int!
}

type Query {
  attestations(subject: String, claimType: String, status: Status): [Attestation!]!
  issuerStats(issuer: String!): IssuerStats
}

type Subscription {
  onAttestationCreated(subject: String): Attestation!
}
```

## Queries

### `attestations`

Filter attestations by subject address, claim type, and/or status. All filters are optional and ANDed together.

```graphql
{
  attestations(subject: "GAAA...", claimType: "KYC", status: ACTIVE) {
    id
    subject
    issuer
    claimType
    status
    createdAt
    expiresAt
    metadata
  }
}
```

### `issuerStats`

Aggregated statistics for a given issuer address.

```graphql
{
  issuerStats(issuer: "GBBB...") {
    issuer
    totalAttestations
    activeCount
    revokedCount
    expiredCount
  }
}
```

Returns `null` if the issuer has no attestations.

## Subscriptions

### `onAttestationCreated`

Real-time stream of newly created attestations, optionally filtered by subject.

```graphql
subscription {
  onAttestationCreated(subject: "GAAA...") {
    id
    subject
    issuer
    claimType
    status
    createdAt
  }
}
```

Omit `subject` to receive all new attestations.

## Variables

All queries support GraphQL variables:

```json
{
  "query": "query Q($s: String) { attestations(subject: $s) { id } }",
  "variables": { "s": "GAAA..." }
}
```

## Playground

In development (`NODE_ENV !== 'production'`), a built-in GraphQL Playground is served at `GET /graphql`. It provides an interactive query editor with live results.

The Playground is **disabled in production** to prevent schema exposure.

## Security

| Threat | Mitigation |
|---|---|
| Invalid address inputs | Validated against Stellar (`G[A-Z2-7]{55}`) and EVM (`0x[0-9a-fA-F]{40}`) formats |
| Invalid enum inputs | `status` and `claimType` validated against allowlists before store access |
| Cross-subject subscription leakage | Subject filters enforced server-side; subscribers only receive matching events |
| Schema exposure in production | Playground returns 404 when `NODE_ENV === 'production'` |
| Malformed JSON body | Caught and returned as a structured GraphQL error |

## API Reference

### `AttestationStore`

In-memory backing store for the indexer.

| Method | Description |
|---|---|
| `upsert(attestation)` | Insert or replace an attestation record |
| `getById(id)` | Retrieve by ID |
| `filter(args)` | Filter by subject, claimType, status |
| `issuerStats(issuer)` | Compute aggregated stats for an issuer |
| `clear()` | Remove all records |

### `SubscriptionBus`

Pub/sub bus for real-time subscriptions.

| Method | Description |
|---|---|
| `subscribe(callback, subject?)` | Register a subscriber; returns `SubscriptionHandle` |
| `publish(attestation)` | Deliver event to all matching subscribers |

### `GraphQLExecutor`

| Method | Description |
|---|---|
| `execute(query, variables?)` | Execute a query; returns `GraphQLResult` |
| `executeSubscription(query, callback, variables?)` | Register a subscription; returns `SubscriptionHandle` |

### `AttestationGraphQLHandler`

Framework-agnostic HTTP handler.

| Method | Description |
|---|---|
| `handle(req)` | Handle a GET or POST request; returns `HttpResponse` |

### `createAttestationGraphQLAPI(isDev?)`

Factory that wires all components together and returns `{ store, bus, resolvers, executor, handler }`.

## Running Tests

```bash
node node_modules/jest/bin/jest.js src/indexer/attestation_graphql.test.ts --coverage --forceExit
```

Expected: ≥ 95% coverage across statements, branches, functions, and lines.

## Valid Claim Types

`KYC` · `AML` · `ACCREDITED_INVESTOR` · `IDENTITY` · `CREDIT_SCORE`
