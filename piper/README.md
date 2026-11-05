# mcp-piper

Pipe large files between local disk and MCP tool calls without the bytes passing through the agent's context.

mcp-piper will ship as a Claude Code hook: when a tool call needs to send or receive a large file, the hook moves the bytes between disk and the MCP server directly, so the agent only ever sees a path.

**0.0.1 is a placeholder.** It reserves the npm name and only prints its version. The hook ships in 0.1.0.

Part of `skills-utils`: https://github.com/luutuankiet/skills-utils
