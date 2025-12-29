// ============================================================================
// AEGIS Router - Constants
// ============================================================================

export const TIMEOUTS = {
  // Upstream server timeouts
  UPSTREAM_REQUEST: 60000,       // 60 seconds
  UPSTREAM_SERVER_INIT: 30000,   // 30 seconds (startup)

  // Context operations
  CONTEXT_ENRICHMENT: 5000,      // 5 seconds

  // Cache operations
  CACHE_OPERATION: 1000,         // 1 second

  // Startup
  STARTUP_DELAY: 2000,           // 2 seconds
} as const;

export const SERVER = {
  DEFAULT_PORT: 3000,
} as const;
