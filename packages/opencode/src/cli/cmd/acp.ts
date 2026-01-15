import { Log } from "@/util/log"
import { bootstrap } from "../bootstrap"
import { cmd } from "./cmd"
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { ACP } from "@/acp/agent"
import { Server } from "@/server/server"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { withNetworkOptions, resolveNetworkOptions } from "../network"

const log = Log.create({ service: "acp-command" })

export const AcpCommand = cmd({
  command: "acp",
  describe: "start ACP (Agent Client Protocol) server",
  builder: (yargs) => {
    return withNetworkOptions(yargs).option("cwd", {
      describe: "working directory",
      type: "string",
      default: process.cwd(),
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      const opts = await resolveNetworkOptions(args)
      const server = Server.listen(opts)

      const sdk = createOpencodeClient({
        baseUrl: `http://${server.hostname}:${server.port}`,
      })

      const input = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (err) => {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        },
      })
      const output = new ReadableStream<Uint8Array>({
        start(controller) {
          process.stdin.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          process.stdin.on("end", () => controller.close())
          process.stdin.on("error", (err) => controller.error(err))
        },
      })

      const stream = ndJsonStream(input, output)
      const agent = await ACP.init({ sdk })

      let agentInstance: Awaited<ReturnType<typeof agent.create>> | undefined

      new AgentSideConnection((conn) => {
        agentInstance = agent.create(conn, { sdk })
        return agentInstance
      }, stream)

      log.info("setup connection")
      process.stdin.resume()

      const cleanup = async () => {
        log.info("cleaning up agent", { hasAgent: !!agentInstance })
        if (agentInstance && typeof agentInstance.dispose === "function") {
          await agentInstance.dispose()
        }
      }

      // Setup shutdown handlers
      const shutdown = async () => {
        await cleanup()
        process.exit(0)
      }

      process.on("SIGINT", shutdown)
      process.on("SIGTERM", shutdown)
      process.on("beforeExit", cleanup)

      await new Promise<void>((resolve, reject) => {
        process.stdin.on("end", async () => {
          await cleanup()
          resolve()
        })
        process.stdin.on("error", async (err) => {
          await cleanup()
          reject(err)
        })
      })
    })
  },
})
