// ============================================================================
// AEGIS - 動的ツール発見システム（改善版）
// ============================================================================

import { Logger } from '../utils/logger.js';

export interface DynamicTool {
  name: string;
  description?: string;
  source: {
    type: 'proxy' | 'client' | 'builtin';  // より汎用的な分類
    origin: string;                         // 実際の提供元
    timestamp: Date;                        // 発見時刻
  };
  metadata?: {
    riskAssessment?: 'low' | 'medium' | 'high';
    category?: string;
    originalHandler?: Function;
  };
  policyConfig?: {
    enforced: boolean;
    customPolicy?: string;
    constraints?: string[];
    obligations?: string[];
  };
}

export interface ToolDiscoveryConfig {
  // ツール発見の設定
  discovery: {
    enableAutoDiscovery: boolean;        // 自動発見を有効化
    enableToolIntrospection: boolean;    // ツールの詳細分析
    refreshInterval?: number;            // 再発見の間隔（ms）
  };
  
  // ポリシー制御の設定
  policyControl: {
    defaultMode: 'allowlist' | 'denylist' | 'smart';
    smartRules?: {
      // パターンベースの自動判定
      highRiskPatterns: string[];        // 高リスクと判定するパターン
      lowRiskPatterns: string[];         // 低リスクと判定するパターン
      trustedOrigins: string[];          // 信頼できるソース
    };
    overrides?: {
      [toolNamePattern: string]: {
        enforced: boolean;
        policy?: string;
      };
    };
  };
}

export class DynamicToolDiscoveryService {
  private discoveredTools = new Map<string, DynamicTool>();
  private toolCategories = new Map<string, Set<string>>();
  private logger: Logger;
  private config: ToolDiscoveryConfig;
  
  // リスク評価のための動的パターン
  private riskPatterns = {
    high: [
      /^(bash|sh|shell|exec|cmd|powershell)/i,
      /^(system|os|process)/i,
      /^(web|http|fetch|request)/i,
      /^(agent|recursive|spawn)/i,
      /(delete|remove|destroy|drop)/i,
      /(admin|root|sudo)/i
    ],
    medium: [
      /(write|create|update|modify|edit)/i,
      /(move|rename|copy)/i,
      /(install|deploy)/i,
      /(config|setting)/i
    ],
    low: [
      /^(read|get|list|search|find)/i,
      /^(view|show|display)/i,
      /(info|status|stat)/i,
      /^(todo|task|note)/i
    ]
  };

  constructor(config: ToolDiscoveryConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    
    // 定期的な再発見を設定
    if (config.discovery.refreshInterval) {
      setInterval(() => this.refreshToolDiscovery(), config.discovery.refreshInterval);
    }
  }

  /**
   * MCPハンドシェイク時のツール発見
   */
  async discoverToolsFromHandshake(handshakeData: any): Promise<void> {
    if (!this.config.discovery.enableAutoDiscovery) return;
    
    this.logger.info('Discovering tools from MCP handshake', {
      capabilities: handshakeData.capabilities
    });
    
    // tools/list レスポンスからツールを発見
    if (handshakeData.tools) {
      for (const tool of handshakeData.tools) {
        this.registerDiscoveredTool(tool, 'mcp-handshake');
      }
    }
  }

  /**
   * ツールリストレスポンスからの発見
   */
  async discoverToolsFromListResponse(response: any, source: string): Promise<void> {
    if (!response.tools) return;
    
    for (const tool of response.tools) {
      this.registerDiscoveredTool(tool, source);
    }
  }

  /**
   * 実行時のツール呼び出しからの発見
   */
  async discoverToolFromExecution(toolCall: any, source: string): Promise<void> {
    if (!this.config.discovery.enableAutoDiscovery) return;
    
    const toolName = toolCall.name || toolCall.tool;
    if (!this.discoveredTools.has(toolName)) {
      this.logger.info(`Discovered new tool through execution: ${toolName}`);
      this.registerDiscoveredTool({
        name: toolName,
        description: 'Discovered through runtime execution'
      }, source);
    }
  }

  /**
   * ツールの動的登録
   */
  private registerDiscoveredTool(tool: any, source: string): void {
    const toolName = tool.name;
    
    // リスク評価
    const riskLevel = this.assessToolRisk(toolName, tool.description);
    
    // カテゴリ分類
    const category = this.categorizeToool(toolName, tool.description);
    
    // ポリシー設定の決定
    const policyConfig = this.determinePolicyConfig(toolName, source, riskLevel);
    
    const dynamicTool: DynamicTool = {
      name: toolName,
      description: tool.description,
      source: {
        type: this.classifySourceType(source),
        origin: source,
        timestamp: new Date()
      },
      metadata: {
        riskAssessment: riskLevel,
        category,
        originalHandler: tool.handler
      },
      policyConfig
    };
    
    this.discoveredTools.set(toolName, dynamicTool);
    
    // カテゴリ別インデックスの更新
    if (!this.toolCategories.has(category)) {
      this.toolCategories.set(category, new Set());
    }
    this.toolCategories.get(category)!.add(toolName);
    
    this.logger.info('Registered dynamic tool', {
      name: toolName,
      source: source,
      risk: riskLevel,
      category,
      policyEnforced: policyConfig.enforced
    });
  }

  /**
   * リスク評価（動的パターンマッチング）
   */
  private assessToolRisk(name: string, description?: string): 'low' | 'medium' | 'high' {
    const text = `${name} ${description || ''}`.toLowerCase();
    
    // カスタムルールの確認
    if (this.config.policyControl.smartRules) {
      const { highRiskPatterns, lowRiskPatterns } = this.config.policyControl.smartRules;
      
      if (highRiskPatterns.some(pattern => new RegExp(pattern).test(text))) {
        return 'high';
      }
      if (lowRiskPatterns.some(pattern => new RegExp(pattern).test(text))) {
        return 'low';
      }
    }
    
    // デフォルトパターンでの評価
    for (const pattern of this.riskPatterns.high) {
      if (pattern.test(text)) return 'high';
    }
    for (const pattern of this.riskPatterns.medium) {
      if (pattern.test(text)) return 'medium';
    }
    for (const pattern of this.riskPatterns.low) {
      if (pattern.test(text)) return 'low';
    }
    
    // デフォルトは中リスク
    return 'medium';
  }

  /**
   * ツールのカテゴリ分類
   */
  private categorizeToool(name: string, description?: string): string {
    const text = `${name} ${description || ''}`.toLowerCase();
    
    if (/file|directory|folder|path/.test(text)) return 'filesystem';
    if (/bash|shell|exec|cmd|command/.test(text)) return 'execution';
    if (/web|http|fetch|api|request/.test(text)) return 'network';
    if (/read|write|edit|create|delete/.test(text)) return 'data';
    if (/git|github|version|commit/.test(text)) return 'vcs';
    if (/docker|container|kubernetes/.test(text)) return 'container';
    if (/todo|task|note|plan/.test(text)) return 'productivity';
    
    return 'general';
  }

  /**
   * ソースタイプの分類
   */
  private classifySourceType(source: string): 'proxy' | 'client' | 'builtin' {
    if (source.includes('proxy') || source.includes('upstream')) return 'proxy';
    if (source.includes('claude') || source.includes('vscode')) return 'client';
    return 'builtin';
  }

  /**
   * ポリシー設定の決定
   */
  private determinePolicyConfig(
    toolName: string, 
    source: string, 
    riskLevel: 'low' | 'medium' | 'high'
  ): NonNullable<DynamicTool['policyConfig']> {
    const config = this.config.policyControl;
    
    // オーバーライドの確認
    if (config.overrides) {
      for (const [pattern, override] of Object.entries(config.overrides)) {
        if (new RegExp(pattern).test(toolName)) {
          return {
            enforced: override.enforced,
            customPolicy: override.policy
          };
        }
      }
    }
    
    // スマートモードの判定
    if (config.defaultMode === 'smart') {
      // 信頼できるソースの確認
      const isTrusted = config.smartRules?.trustedOrigins?.includes(source) || false;
      
      // リスクレベルと信頼度に基づく判定
      if (riskLevel === 'high' && !isTrusted) {
        return {
          enforced: true,
          constraints: ['詳細なログ記録', '管理者承認が必要な場合あり']
        };
      } else if (riskLevel === 'low' && isTrusted) {
        return { enforced: false };
      }
    }
    
    // デフォルトモードの適用
    return {
      enforced: config.defaultMode === 'denylist' ? false : true
    };
  }

  /**
   * ツール情報の取得
   */
  getTool(name: string): DynamicTool | undefined {
    return this.discoveredTools.get(name);
  }

  /**
   * カテゴリ別ツールの取得
   */
  getToolsByCategory(category: string): string[] {
    return Array.from(this.toolCategories.get(category) || []);
  }

  /**
   * リスクレベル別ツールの取得
   */
  getToolsByRiskLevel(level: 'low' | 'medium' | 'high'): DynamicTool[] {
    return Array.from(this.discoveredTools.values())
      .filter(tool => tool.metadata?.riskAssessment === level);
  }

  /**
   * ツール発見の再実行
   */
  private async refreshToolDiscovery(): Promise<void> {
    this.logger.debug('Refreshing tool discovery...');
    // 実装: 各ソースに再問い合わせ
  }

  /**
   * 統計情報
   */
  getStats(): {
    totalDiscovered: number;
    bySource: Record<string, number>;
    byCategory: Record<string, number>;
    byRiskLevel: Record<string, number>;
    policyEnforced: number;
    lastDiscovery: Date | null;
  } {
    const bySource: Record<string, number> = {};
    const byRiskLevel: Record<string, number> = { low: 0, medium: 0, high: 0 };
    let policyEnforced = 0;
    let lastDiscovery: Date | null = null;
    
    for (const tool of this.discoveredTools.values()) {
      // ソース別集計
      const origin = tool.source.origin;
      bySource[origin] = (bySource[origin] || 0) + 1;
      
      // リスクレベル別集計
      if (tool.metadata?.riskAssessment) {
        byRiskLevel[tool.metadata.riskAssessment]++;
      }
      
      // ポリシー適用数
      if (tool.policyConfig?.enforced) {
        policyEnforced++;
      }
      
      // 最新の発見時刻
      if (!lastDiscovery || tool.source.timestamp > lastDiscovery) {
        lastDiscovery = tool.source.timestamp;
      }
    }
    
    // カテゴリ別集計
    const byCategory: Record<string, number> = {};
    for (const [category, tools] of this.toolCategories) {
      byCategory[category] = tools.size;
    }
    
    return {
      totalDiscovered: this.discoveredTools.size,
      bySource,
      byCategory,
      byRiskLevel,
      policyEnforced,
      lastDiscovery
    };
  }
}