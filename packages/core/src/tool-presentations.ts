import { validatePresentationBatch } from './genui/registry.js';
import type { AiToolCtx, ToolHandler } from './spi/tool.js';

/** Presentation failures must never cause a successful side effect to be retried. */
export async function emitToolPresentations<I, O>(
  handler: ToolHandler<I, O>,
  output: O,
  ctx: AiToolCtx,
  toolName: string,
): Promise<void> {
  if (handler.present === undefined) return;
  try {
    const result = await handler.present(output, ctx);
    if (result === undefined) return;
    const batch = validatePresentationBatch(result);
    for (const presentation of batch) {
      await ctx.emitUi(presentation.component, presentation.props, {
        version: presentation.version,
        fallbackText: presentation.fallbackText,
      });
    }
  } catch (error) {
    if (ctx.onPresentationError !== undefined) {
      try {
        await ctx.onPresentationError(error, { toolName });
        return;
      } catch (reportError) {
        console.warn(`Tool "${toolName}" presentation error reporter failed`, reportError);
      }
    } else {
      console.warn(`Tool "${toolName}" presentation failed after successful execution`, error);
    }
  }
}
