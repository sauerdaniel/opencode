import { Plugin } from "../plugin"
import { Share } from "../share/share"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"

const commandSubscription = Instance.state(
  () => {
    const unsubscribe = Bus.subscribe(Command.Event.Executed, async (payload) => {
      if (payload.properties.name === Command.Default.INIT) {
        await Project.setInitialized(Instance.project.id)
      }
    })
    return { unsubscribe }
  },
  async (state) => {
    state.unsubscribe()
  },
)

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  Share.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  commandSubscription()
}
