import z from "zod"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    let searchPath = params.path ?? Instance.directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    const rgPath = await Ripgrep.filepath()
    const args = ["-nH", "--hidden", "--follow", "--field-match-separator=|", "--regexp", params.pattern]
    if (params.include) {
      args.push("--glob", params.include)
    }
    args.push(searchPath)

    const proc = Bun.spawn([rgPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })

    // Stream the output to avoid reading entire result set into memory
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    const matches = []
    let buffer = ""
    let byteCount = 0
    const MAX_BYTES = 10 * 1024 * 1024 // 10MB limit to prevent memory exhaustion

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        byteCount += value.length
        if (byteCount > MAX_BYTES) {
          reader.cancel()
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? "" // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line) continue

          const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
          if (!filePath || !lineNumStr || lineTextParts.length === 0) continue

          const lineNum = parseInt(lineNumStr, 10)
          const lineText = lineTextParts.join("|")

          // Defer file stat until after streaming to avoid blocking
          matches.push({
            path: filePath,
            lineNum,
            lineText,
          })
        }
      }
    } finally {
      reader.releaseLock()
    }

    // Get exit code and check for errors
    const errorOutput = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode === 1 && matches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    // Now get file stats in a batch (limit to avoid excessive I/O)
    const STAT_LIMIT = 1000 // Process at most 1000 matches for stats
    const statResults = []
    for (const match of matches.slice(0, STAT_LIMIT)) {
      const file = Bun.file(match.path)
      const stats = await file.stat().catch(() => null)
      if (stats) {
        statResults.push({
          ...match,
          modTime: stats.mtime.getTime(),
        })
      }
    }

    statResults.sort((a, b) => b.modTime - a.modTime)

    const DISPLAY_LIMIT = 100
    const truncated = statResults.length > DISPLAY_LIMIT
    const finalMatches = truncated ? statResults.slice(0, DISPLAY_LIMIT) : statResults

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    const outputLines = [`Found ${finalMatches.length} matches`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: finalMatches.length,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})
