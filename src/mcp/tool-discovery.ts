// ============================================================================
// AEGIS - ツール発見・統合サービス
// ============================================================================

import { Logger } from '../utils/logger.js';

export interface ToolSource {
  type: 'configured' | 'discovered' | 'native';
  name: string;
  description?: string;
  policyControlled: boolean;
  prefix?: string;
}

export interface DiscoveredTool {
  name: string;
  description?: string;
  source: ToolSource;
  originalHandler?: Function;
  metadata?: Record<string, any>;
}

export interface PolicyControlConfig {
  defaultEnabled: boolean;
  exceptions: string[];
  toolPolicies?: {
    [toolName: string]: {
      enabled: boolean;
      customPolicy?: string;
      constraints?: string[];
      obligations?: string[];
    }
  };
  patterns?: {
    pattern: string;
    enabled: boolean;
    policy?: string;
  }[];
}

export class ToolDiscoveryService {
  private registeredTools = new Map<string, DiscoveredTool>();
  private logger: Logger;
  private config: {
    includeNativeTools: boolean;
    includeDiscoveredTools: boolean;
    policyControl: PolicyControlConfig;
    toolSources: ToolSource[];
  };

  // Claude Code内蔵ツール定義
  private static readonly NATIVE_TOOLS = {
    'Agent': { description: 'Runs a sub-agent to handle complex tasks', risk: 'high' },
    'Bash': { description: 'Executes shell commands', risk: 'high' },
    'Edit': { description: 'Makes targeted edits to files', risk: 'medium' },
    'MultiEdit': { description: 'Multiple edits on a single file', risk: 'medium' },
    'Read': { description: 'Reads file contents', risk: 'low' },
    'Write': { description: 'Creates or overwrites files', risk: 'medium' },
    'Glob': { description: 'Finds files by pattern', risk: 'low' },
    'Grep': { description: 'Searches in file contents', risk: 'low' },
    'LS': { description: 'Lists files and directories', risk: 'low' },
    'WebFetch': { description: 'Fetches web content', risk: 'high' },
    'WebSearch': { description: 'Performs web searches', risk: 'high' },
    'TodoRead': { description: 'Reads task list', risk: 'low' },
    'TodoWrite': { description: 'Manages task lists', risk: 'low' },
    'NotebookRead': { description: 'Reads Jupyter notebooks', risk: 'low' },
    'NotebookEdit': { description: 'Edits Jupyter notebooks', risk: 'medium' }
  };

  constructor(config: any, logger: Logger) {
    this.config = {
      includeNativeTools: config.includeNativeTools ?? true,
      includeDiscoveredTools: config.includeDiscoveredTools ?? true,
      policyControl: config.policyControl || {
        defaultEnabled: true,
        exceptions: ['TodoRead', 'TodoWrite', 'LS']
      },
      toolSources: config.toolSources || []
    };
    this.logger = logger;
    
    // ネイティブツールの初期登録
    if (this.config.includeNativeTools) {
      this.registerNativeTools();
    }
  }

  /**
   * Claude Code内蔵ツールを登録
   */
  private registerNativeTools(): void {
    const nativeSource = this.config.toolSources.find(s => s.type === 'native' && s.name === 'claude-code') || {
      type: 'native' as const,
      name: 'claude-code',
      policyControlled: true,
      prefix: 'native__'
    };

    Object.entries(ToolDiscoveryService.NATIVE_TOOLS).forEach(([name, info]) => {
      const fullName = nativeSource.prefix ? `${nativeSource.prefix}${name}` : name;
      
      this.registeredTools.set(fullName, {
        name: fullName,
        description: info.description,
        source: {
          ...nativeSource,
          policyControlled: this.shouldApplyPolicy(name, info.risk)
        },
        metadata: { risk: info.risk, originalName: name }
      });
      
      this.logger.info(`Registered native tool: ${fullName} (policy: ${this.shouldApplyPolicy(name, info.risk)})`);
    });
  }

  /**
   * MCPクライアントから受信したツールを登録
   */
  registerToolFromClient(tool: any, sourceName: string): void {
    if (!this.config.includeDiscoveredTools) {
      return;
    }

    const source = this.config.toolSources.find(s => s.name === sourceName) || {
      type: 'discovered' as const,
      name: sourceName,
      policyControlled: this.config.policyControl.defaultEnabled
    };

    const fullName = source.prefix ? `${source.prefix}${tool.name}` : tool.name;

    this.registeredTools.set(fullName, {
      name: fullName,
      description: tool.description,
      source: {
        ...source,
        policyControlled: this.shouldApplyPolicy(tool.name)
      },
      metadata: { 
        originalName: tool.name,
        discoveredAt: new Date().toISOString()
      }
    });

    this.logger.info(`Discovered tool: ${fullName} from ${sourceName}`);
  }

  /**
   * 設定済みMCPサーバーのツールを登録
   */
  registerConfiguredTool(tool: any, serverName: string): void {
    const source: ToolSource = {
      type: 'configured',
      name: serverName,
      policyControlled: this.shouldApplyPolicy(tool.name),
      prefix: `${serverName}__`
    };

    const fullName = `${source.prefix}${tool.name}`;

    this.registeredTools.set(fullName, {
      name: fullName,
      description: tool.description,
      source,
      metadata: { 
        originalName: tool.name,
        serverName 
      }
    });
  }

  /**
   * ポリシー適用判定
   */
  private shouldApplyPolicy(toolName: string, riskLevel?: string): boolean {
    // 高リスクツールは常にポリシー制御
    if (riskLevel === 'high') {
      return true;
    }

    // 例外リストのチェック
    if (this.config.policyControl.exceptions.includes(toolName)) {
      return false;
    }

    // ツール別設定のチェック
    const toolPolicy = this.config.policyControl.toolPolicies?.[toolName];
    if (toolPolicy !== undefined) {
      return toolPolicy.enabled;
    }

    // パターンマッチング
    if (this.config.policyControl.patterns) {
      for (const pattern of this.config.policyControl.patterns) {
        if (new RegExp(pattern.pattern).test(toolName)) {
          return pattern.enabled;
        }
      }
    }

    // デフォルト設定
    return this.config.policyControl.defaultEnabled;
  }

  /**
   * ツール情報の取得
   */
  getTool(toolName: string): DiscoveredTool | undefined {
    return this.registeredTools.get(toolName);
  }

  /**
   * 全ツールのリスト取得
   */
  getAllTools(): DiscoveredTool[] {
    return Array.from(this.registeredTools.values());
  }

  /**
   * ポリシー制御対象ツールのリスト取得
   */
  getPolicyControlledTools(): DiscoveredTool[] {
    return this.getAllTools().filter(tool => tool.source.policyControlled);
  }

  /**
   * ツールのリスク評価
   */
  assessToolRisk(toolName: string): 'low' | 'medium' | 'high' {
    const tool = this.getTool(toolName);
    if (!tool) return 'medium';

    // メタデータからリスクレベルを取得
    if (tool.metadata?.risk) {
      return tool.metadata.risk as 'low' | 'medium' | 'high';
    }

    // ツール名ベースの簡易判定
    const highRiskPatterns = ['bash', 'exec', 'shell', 'web', 'fetch', 'agent'];
    const mediumRiskPatterns = ['write', 'edit', 'create', 'delete', 'modify'];
    
    const lowerName = toolName.toLowerCase();
    
    if (highRiskPatterns.some(pattern => lowerName.includes(pattern))) {
      return 'high';
    }
    if (mediumRiskPatterns.some(pattern => lowerName.includes(pattern))) {
      return 'medium';
    }
    
    return 'low';
  }

  /**
   * 統計情報の取得
   */
  getStats(): {
    totalTools: number;
    bySource: Record<string, number>;
    policyControlled: number;
    riskDistribution: Record<string, number>;
  } {
    const tools = this.getAllTools();
    const bySource: Record<string, number> = {};
    const riskDistribution: Record<string, number> = { low: 0, medium: 0, high: 0 };

    tools.forEach(tool => {
      const sourceType = tool.source.type;
      bySource[sourceType] = (bySource[sourceType] || 0) + 1;
      
      const risk = this.assessToolRisk(tool.name);
      riskDistribution[risk]++;
    });

    return {
      totalTools: tools.length,
      bySource,
      policyControlled: this.getPolicyControlledTools().length,
      riskDistribution
    };
  }
}