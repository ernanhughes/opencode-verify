import { Plugin } from "@opencode/plugin";
import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { VerificationEngine } from "./engine";
import { VerifyCheckTool, VerifyExplainTool, VerifyGetTool, VerifyHealthTool } from "./tools";

const VerifyPlugin = Plugin.define({
  id: "opencode-verify",

  async setup(ctx) {
    const directory = ctx.location.directory;
    const engine = new VerificationEngine(directory);

    try {
      const health = engine.doctor();
      if (!health["ok"]) {
        console.warn(
          `[opencode-verify] store not ready: ${String(health["message"] ?? "see verify_health")}`,
        );
      }
    } catch (error) {
      console.warn(`[opencode-verify] unavailable at startup: ${String(error).slice(0, 300)}`);
    }

    const tools: ToolInfo[] = [
      VerifyCheckTool(engine),
      VerifyGetTool(engine),
      VerifyExplainTool(engine),
      VerifyHealthTool(engine),
    ];

    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });
  },
});

export default VerifyPlugin;
