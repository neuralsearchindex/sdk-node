/**
 * @local-llm/schemas — the chat/search wire contract shared by TypeScript
 * clients (apps/web, apps/mobile). Pure types + tiny enum/const maps and a few
 * guards; no browser or Node built-ins, so it is safe to consume from React
 * Native / Metro as raw TypeScript source.
 *
 * The engine/agents remain the source of truth for the enum VALUES; this package
 * mirrors them so web and mobile can't drift from each other.
 */
export * from "./listing";
export * from "./scored-listing";
export * from "./search-intent";
export * from "./search-event";
export * from "./domain";
