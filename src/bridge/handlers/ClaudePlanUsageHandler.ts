import { BridgeContext, BridgeHandler, BridgeMessage } from '../types';
import { postRaw } from './helpers';
import { ClaudePlanUsageService } from '../services/ClaudePlanUsageService';

/**
 * Bridges the webview's {@code get_claude_plan_usage} poll to
 * {@link ClaudePlanUsageService} and pushes the snapshot back via
 * {@code window.updateClaudePlanUsage} (TYPE_TO_FN: update_claude_plan_usage).
 */
export class ClaudePlanUsageHandler implements BridgeHandler {
  readonly supportedEvents = ['get_claude_plan_usage'] as const;

  constructor(
    private readonly context: BridgeContext,
    private readonly planUsage: ClaudePlanUsageService,
  ) {}

  async handle({ event, webview }: BridgeMessage): Promise<boolean> {
    if (event !== 'get_claude_plan_usage') return false;
    try {
      const usage = await this.planUsage.resolvePlanUsagePayload();
      postRaw(webview, 'update_claude_plan_usage', JSON.stringify(usage));
    } catch (error) {
      this.context.log.appendLine(
        `[ClaudePlanUsage] Poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      postRaw(webview, 'update_claude_plan_usage', JSON.stringify({
        error: true,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    return true;
  }
}
