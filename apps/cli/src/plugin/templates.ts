/**
 * Every kind's template files, by the path each takes in the package (with
 * its placeholders: `skills/__NAME__/SKILL.md`), imported as text so they
 * travel in the CLI's bundle instead of being read from disk at run time.
 */
import toolReadmeMd from "./templates/tool/README.md.tpl" with { type: "text" };
import toolSkillMd from "./templates/tool/SKILL.md.tpl" with { type: "text" };
import toolIndexTestTs from "./templates/tool/index.test.ts.tpl" with { type: "text" };
import toolIndexTs from "./templates/tool/index.ts.tpl" with { type: "text" };
import toolMessagesTs from "./templates/tool/messages.ts.tpl" with { type: "text" };
import toolToolsTestTs from "./templates/tool/tools.test.ts.tpl" with { type: "text" };
import toolToolsTs from "./templates/tool/tools.ts.tpl" with { type: "text" };
import cliReadmeMd from "./templates/cli/README.md.tpl" with { type: "text" };
import cliBinaryJson from "./templates/cli/__BINARY__.json.tpl" with { type: "text" };
import cliAllowlistTestTs from "./templates/cli/allowlist.test.ts.tpl" with { type: "text" };
import cliCliCredentialsTestTs from "./templates/cli/cli-credentials.test.ts.tpl" with { type: "text" };
import cliIndexTestTs from "./templates/cli/index.test.ts.tpl" with { type: "text" };
import cliIndexTs from "./templates/cli/index.ts.tpl" with { type: "text" };
import cliScriptsInstallBinaryCliTs from "./templates/cli/scripts/install-__BINARY__-cli.ts.tpl" with { type: "text" };
import memoryReadmeMd from "./templates/memory/README.md.tpl" with { type: "text" };
import memoryIndexTestTs from "./templates/memory/index.test.ts.tpl" with { type: "text" };
import memoryIndexTs from "./templates/memory/index.ts.tpl" with { type: "text" };
import contextStrategyReadmeMd from "./templates/context-strategy/README.md.tpl" with { type: "text" };
import contextStrategyIndexTestTs from "./templates/context-strategy/index.test.ts.tpl" with { type: "text" };
import contextStrategyIndexTs from "./templates/context-strategy/index.ts.tpl" with { type: "text" };
import contextStrategyWindowTestTs from "./templates/context-strategy/window.test.ts.tpl" with { type: "text" };
import contextStrategyWindowTs from "./templates/context-strategy/window.ts.tpl" with { type: "text" };
import channelReadmeMd from "./templates/channel/README.md.tpl" with { type: "text" };
import channelIndexTestTs from "./templates/channel/index.test.ts.tpl" with { type: "text" };
import channelIndexTs from "./templates/channel/index.ts.tpl" with { type: "text" };
import channelMessagesTs from "./templates/channel/messages.ts.tpl" with { type: "text" };
import authReadmeMd from "./templates/auth/README.md.tpl" with { type: "text" };
import authIndexTestTs from "./templates/auth/index.test.ts.tpl" with { type: "text" };
import authIndexTs from "./templates/auth/index.ts.tpl" with { type: "text" };
import directoryReadmeMd from "./templates/directory/README.md.tpl" with { type: "text" };
import directoryIndexTestTs from "./templates/directory/index.test.ts.tpl" with { type: "text" };
import directoryIndexTs from "./templates/directory/index.ts.tpl" with { type: "text" };
import traceSinkReadmeMd from "./templates/trace-sink/README.md.tpl" with { type: "text" };
import traceSinkIndexTestTs from "./templates/trace-sink/index.test.ts.tpl" with { type: "text" };
import traceSinkIndexTs from "./templates/trace-sink/index.ts.tpl" with { type: "text" };
import vectorIndexReadmeMd from "./templates/vector-index/README.md.tpl" with { type: "text" };
import vectorIndexIndexTestTs from "./templates/vector-index/index.test.ts.tpl" with { type: "text" };
import vectorIndexIndexTs from "./templates/vector-index/index.ts.tpl" with { type: "text" };
import conversationStoreReadmeMd from "./templates/conversation-store/README.md.tpl" with { type: "text" };
import conversationStoreIndexTestTs from "./templates/conversation-store/index.test.ts.tpl" with { type: "text" };
import conversationStoreIndexTs from "./templates/conversation-store/index.ts.tpl" with { type: "text" };
import type { PluginKind } from "./kinds.ts";

export const TEMPLATES: Record<PluginKind, Record<string, string>> = {
  "tool": {
    "README.md": toolReadmeMd,
    "skills/__NAME__/SKILL.md": toolSkillMd,
    "index.test.ts": toolIndexTestTs,
    "index.ts": toolIndexTs,
    "messages.ts": toolMessagesTs,
    "tools.test.ts": toolToolsTestTs,
    "tools.ts": toolToolsTs,
  },
  "cli": {
    "README.md": cliReadmeMd,
    "__BINARY__.json": cliBinaryJson,
    "allowlist.test.ts": cliAllowlistTestTs,
    "cli-credentials.test.ts": cliCliCredentialsTestTs,
    "index.test.ts": cliIndexTestTs,
    "index.ts": cliIndexTs,
    "scripts/install-__BINARY__-cli.ts": cliScriptsInstallBinaryCliTs,
  },
  "memory": {
    "README.md": memoryReadmeMd,
    "index.test.ts": memoryIndexTestTs,
    "index.ts": memoryIndexTs,
  },
  "context-strategy": {
    "README.md": contextStrategyReadmeMd,
    "index.test.ts": contextStrategyIndexTestTs,
    "index.ts": contextStrategyIndexTs,
    "window.test.ts": contextStrategyWindowTestTs,
    "window.ts": contextStrategyWindowTs,
  },
  "channel": {
    "README.md": channelReadmeMd,
    "index.test.ts": channelIndexTestTs,
    "index.ts": channelIndexTs,
    "messages.ts": channelMessagesTs,
  },
  "auth": {
    "README.md": authReadmeMd,
    "index.test.ts": authIndexTestTs,
    "index.ts": authIndexTs,
  },
  "directory": {
    "README.md": directoryReadmeMd,
    "index.test.ts": directoryIndexTestTs,
    "index.ts": directoryIndexTs,
  },
  "trace-sink": {
    "README.md": traceSinkReadmeMd,
    "index.test.ts": traceSinkIndexTestTs,
    "index.ts": traceSinkIndexTs,
  },
  "vector-index": {
    "README.md": vectorIndexReadmeMd,
    "index.test.ts": vectorIndexIndexTestTs,
    "index.ts": vectorIndexIndexTs,
  },
  "conversation-store": {
    "README.md": conversationStoreReadmeMd,
    "index.test.ts": conversationStoreIndexTestTs,
    "index.ts": conversationStoreIndexTs,
  },
};
