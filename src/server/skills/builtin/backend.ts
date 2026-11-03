import type { BuiltinSkill } from "./types";

/** APIs, data and running in production. */
export const BACKEND_SKILLS: readonly BuiltinSkill[] = [
  {
    name: "carbon-api-contract",
    description: "Use when creating or changing an HTTP endpoint: keep the contract consistent, validated, documented and backward compatible.",
    personas: ["engineering"],
    body: `# API contract

Follow the conventions the repo already uses; when there are none:

- Resources are plural nouns (/appointments/{id}); actions that are not CRUD become sub-resources or explicit verbs.
- Status codes: 200 read, 201 created, 204 no content, 400 invalid input, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 422 semantic validation, 429 rate limited. Never 200 with an error inside.
- Same envelope as the rest of the API (e.g. { success, data, error } or the existing pattern) and the same error shape.
- Validate body, query and params at the edge with a schema; return which field failed.
- Lists are paginated (cursor or page/limit with a max) — never unbounded.
- Backward compatibility: add fields, do not rename or remove them; breaking changes need a new version or an explicit decision (CARBON_QUESTION).
- Idempotency for retried writes (payments, webhooks, jobs): idempotency key or natural key.
- Update the API docs (OpenAPI/Swagger) and add an integration test per endpoint: happy path, invalid input, unauthorized.`,
  },
  {
    name: "carbon-db-migration-safety",
    description: "Use for any schema or data migration: make it reversible, zero-downtime and safe on large tables.",
    personas: ["engineering", "data"],
    body: `# Migration safety

- Use the project's migration tool (Prisma, TypeORM, Knex, Django, Alembic, goose...). Never edit an already-applied migration; create a new one.
- Expand / contract: add new nullable column or table → deploy code that writes both → backfill → switch reads → remove the old one in a later migration.
- Never in the same step: drop a column the running code still reads, rename a column, or add NOT NULL without a default on a big table.
- Large tables: create indexes concurrently where supported; backfill in batches; avoid long locks.
- Every migration has a down/rollback path, or the summary explains why it is irreversible.
- Data migrations are idempotent (safe to run twice).
- Test the migration up and down locally (or on a copy) and run the test suite after it.

Destructive changes (dropping data) require a CARBON_QUESTION with options before you write them.`,
  },
  {
    name: "carbon-error-handling",
    description: "Use when writing code that can fail (I/O, network, parsing, external APIs): handle errors explicitly with clear messages and safe retries.",
    personas: ["engineering"],
    body: `# Error handling

- Fail fast at boundaries: validate input and configuration at startup / at the edge, with a clear message.
- Typed errors: distinguish expected domain errors (not found, invalid state) from unexpected ones; map them to the right status code or user message in one place.
- Never swallow: every catch either handles, rethrows with context (cause), or converts to a typed result.
- External calls: always a timeout; retry only idempotent operations, with exponential backoff, jitter and a max attempts limit.
- User-facing messages: say what happened and what to do, in the product's language, without stack traces or internal details.
- Server logs: include the operation, the ids involved and the error — never secrets or personal data.
- Clean up resources in finally/defer (files, connections, locks, temp dirs).

Add a test for at least one failure path you introduced.`,
  },
  {
    name: "carbon-observability",
    description: "Use when adding a feature that runs in production (endpoints, jobs, consumers, integrations): make it observable with structured logs and useful signals.",
    personas: ["engineering"],
    body: `# Observability

- Use the logger the project already has (pino, winston, zap, structlog, Datadog...). No console.log/print in production code.
- Structured logs with a stable message and fields: operation, outcome, duration_ms, ids (request/correlation/trace id, entity id). No personal data, tokens or full payloads.
- Log level discipline: error = needs action, warn = degraded but handled, info = business events, debug = details off by default.
- Propagate the correlation/trace id across HTTP calls, queues and jobs when the project supports it.
- For jobs and consumers: log start/finish/failure with counts, and make failures visible (metric, alert or dead-letter) instead of silent.
- If the repo defines metrics or tracing helpers, add the obvious ones (count, error count, latency) for the new path.

Mention in the summary what someone on call would search for to debug this feature.`,
  },
  {
    name: "carbon-production-audit",
    description: "Use before delivering anything that changes runtime behavior: ask what breaks in production, and check config, limits and rollback.",
    personas: ["engineering"],
    body: `# Production audit

Walk through your change with these lenses and report real risks as CARBON_FINDING:

- Configuration: new env vars exist in every environment? Safe defaults? Documented in .env.example?
- Limits: timeouts, payload sizes, pagination, rate limits, memory for large inputs, concurrency.
- Data: works with existing production data shapes (nulls, legacy values, large volumes)? Migration order vs deploy order?
- Dependencies: what happens when an external service is slow or down? Is there a fallback or a clear error?
- Rollout: can it be turned off (feature flag) or rolled back without data loss?
- Backward compatibility with clients already deployed (mobile apps, other services, old queue messages).
- Cost: new calls per request, new queries in loops, new cron frequency.

Finish with a one-paragraph "Riscos em produção" in the summary. Do not invent infrastructure you cannot see in the repo; say what needs validation.`,
  },
];
