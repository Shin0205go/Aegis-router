// ============================================================================
// AEGIS Router - Remote Prompt Fetcher
// Fetches system instructions from remote MCP servers via prompts/get
// ============================================================================

import { Logger } from '../utils/logger.js';
import type { RemoteInstruction } from '../types/router-types.js';

/**
 * Cache entry for remote prompts
 */
interface PromptCacheEntry {
  content: string;
  fetchedAt: Date;
  expiresAt: Date;
}

/**
 * Interface for MCP request routing
 */
export interface PromptRouter {
  routeRequest(request: any): Promise<any>;
}

/**
 * Result of fetching a remote prompt
 */
export interface FetchPromptResult {
  success: boolean;
  content: string;
  source: 'remote' | 'cache' | 'fallback';
  error?: string;
}

/**
 * RemotePromptFetcher - Fetches prompts from MCP servers
 *
 * Uses the MCP prompts/get protocol to retrieve system instructions
 * from backend servers. Supports caching and fallbacks.
 */
export class RemotePromptFetcher {
  private logger: Logger;
  private router?: PromptRouter;
  private cache: Map<string, PromptCacheEntry> = new Map();
  private defaultCacheTtl: number = 300; // 5 minutes

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Set the router for sending MCP requests
   * This is called by AegisRouterCore after initialization
   */
  setRouter(router: PromptRouter): void {
    this.router = router;
    this.logger.debug('PromptRouter set for remote fetching');
  }

  /**
   * Fetch a prompt from a remote MCP server
   */
  async fetchPrompt(config: RemoteInstruction): Promise<FetchPromptResult> {
    const cacheKey = this.getCacheKey(config);

    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      this.logger.debug(`Using cached prompt for ${config.backend}:${config.promptName}`);
      return {
        success: true,
        content: cached,
        source: 'cache'
      };
    }

    // No router = can't fetch remotely
    if (!this.router) {
      this.logger.warn('No router available for remote prompt fetching');
      return this.handleFallback(config, 'No router available');
    }

    try {
      this.logger.info(`Fetching remote prompt: ${config.backend}:${config.promptName}`);

      // Build the prompts/get request
      // The request needs to be routed to the specific backend server
      const request = {
        jsonrpc: '2.0' as const,
        id: Date.now(),
        method: 'prompts/get',
        params: {
          name: config.promptName,
          arguments: config.arguments || {}
        }
      };

      // Route through the specific backend
      // We prefix the request to indicate which server should handle it
      const routedRequest = {
        ...request,
        _aegis_target_server: config.backend
      };

      const response = await this.router.routeRequest(routedRequest);

      if (response.error) {
        this.logger.error(`Error fetching prompt from ${config.backend}:`, response.error);
        return this.handleFallback(config, response.error.message || 'Unknown error');
      }

      // Extract the prompt content from the response
      const content = this.extractPromptContent(response.result);

      if (!content) {
        this.logger.warn(`Empty prompt returned from ${config.backend}:${config.promptName}`);
        return this.handleFallback(config, 'Empty prompt returned');
      }

      // Cache the result
      const ttl = config.cacheTtl ?? this.defaultCacheTtl;
      if (ttl > 0) {
        this.addToCache(cacheKey, content, ttl);
      }

      this.logger.info(`Successfully fetched prompt from ${config.backend}:${config.promptName}`);

      return {
        success: true,
        content,
        source: 'remote'
      };

    } catch (error) {
      this.logger.error(`Failed to fetch prompt from ${config.backend}:`, error);
      return this.handleFallback(
        config,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Extract prompt content from MCP prompts/get response
   */
  private extractPromptContent(result: any): string | null {
    if (!result) return null;

    // MCP prompts/get returns messages array
    // Each message has role and content
    if (result.messages && Array.isArray(result.messages)) {
      // Concatenate all message contents
      const contents: string[] = [];

      for (const message of result.messages) {
        if (message.content) {
          if (typeof message.content === 'string') {
            contents.push(message.content);
          } else if (message.content.type === 'text' && message.content.text) {
            contents.push(message.content.text);
          }
        }
      }

      if (contents.length > 0) {
        return contents.join('\n\n');
      }
    }

    // Fallback: check for direct content
    if (typeof result === 'string') {
      return result;
    }

    if (result.content) {
      return typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content);
    }

    return null;
  }

  /**
   * Handle fallback when remote fetch fails
   */
  private handleFallback(config: RemoteInstruction, error: string): FetchPromptResult {
    if (config.fallback) {
      this.logger.info(`Using fallback instruction for ${config.backend}:${config.promptName}`);
      return {
        success: true,
        content: config.fallback,
        source: 'fallback',
        error
      };
    }

    return {
      success: false,
      content: `# Remote Prompt Unavailable\n\nFailed to fetch prompt from ${config.backend}:${config.promptName}\n\nError: ${error}`,
      source: 'fallback',
      error
    };
  }

  /**
   * Get cache key for a remote instruction
   */
  private getCacheKey(config: RemoteInstruction): string {
    const argsKey = config.arguments
      ? JSON.stringify(config.arguments)
      : '';
    return `${config.backend}:${config.promptName}:${argsKey}`;
  }

  /**
   * Get prompt from cache if not expired
   */
  private getFromCache(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (new Date() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.content;
  }

  /**
   * Add prompt to cache
   */
  private addToCache(key: string, content: string, ttlSeconds: number): void {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    this.cache.set(key, {
      content,
      fetchedAt: now,
      expiresAt
    });

    this.logger.debug(`Cached prompt for ${key}, expires at ${expiresAt.toISOString()}`);
  }

  /**
   * Clear prompt cache
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.debug('Prompt cache cleared');
  }

  /**
   * Invalidate a specific cache entry
   */
  invalidateCache(config: RemoteInstruction): void {
    const key = this.getCacheKey(config);
    this.cache.delete(key);
    this.logger.debug(`Invalidated cache for ${key}`);
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys())
    };
  }
}

/**
 * Create a RemotePromptFetcher instance
 */
export function createRemotePromptFetcher(logger: Logger): RemotePromptFetcher {
  return new RemotePromptFetcher(logger);
}
