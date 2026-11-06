/**
 * Executor core shared by the panel and the standalone worker: command building, spawning,
 * JSONL parsers and the CARBON_* protocol. Must stay free of `server-only`, DB and Next.js
 * imports (guarded by boundary.test.ts).
 */
export * from "./events";
export * from "./claude-parse";
export * from "./codex-parse";
export * from "./protocol";
export * from "./spawn";
export * from "./resolve";
