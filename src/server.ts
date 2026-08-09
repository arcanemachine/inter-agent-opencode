import type { PluginModule } from "@opencode-ai/plugin";

const server: PluginModule = {
  id: "inter-agent",
  async server(_input, _options) {
    return {};
  },
};

export default server;
