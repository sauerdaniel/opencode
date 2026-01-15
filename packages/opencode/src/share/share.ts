import { Bus } from "../bus"
import { Installation } from "../installation"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Log } from "../util/log"
import { Instance } from "../project/instance"

export namespace Share {
  const log = Log.create({ service: "share" })

  const state = Instance.state(
    async () => {
      let queue: Promise<void> = Promise.resolve()
      const pending = new Map<string, any>()
      const unsubscribes: (() => void)[] = []

      async function sync(key: string, content: any) {
        const [root, ...splits] = key.split("/")
        if (root !== "session") return
        const [sub, sessionID] = splits
        if (sub === "share") return
        const share = await Session.getShare(sessionID).catch(() => {})
        if (!share) return
        const { secret } = share
        pending.set(key, content)
        queue = queue
          .then(async () => {
            const content = pending.get(key)
            if (content === undefined) return
            pending.delete(key)

            return fetch(`${URL}/share_sync`, {
              method: "POST",
              body: JSON.stringify({
                sessionID: sessionID,
                secret,
                key: key,
                content,
              }),
            })
          })
          .then((x) => {
            if (x) {
              log.info("synced", {
                key: key,
                status: x.status,
              })
            }
          })
      }

      return {
        sync,
        unsubscribes,
      }
    },
    async (state) => {
      for (const unsubscribe of state.unsubscribes) {
        unsubscribe()
      }
    },
  )

  export async function sync(key: string, content: any) {
    const s = await state()
    await s.sync(key, content)
  }

  export function init() {
    state().then((s) => {
      s.unsubscribes.push(
        Bus.subscribe(Session.Event.Updated, async (evt) => {
          await s.sync("session/info/" + evt.properties.info.id, evt.properties.info)
        }),
        Bus.subscribe(MessageV2.Event.Updated, async (evt) => {
          await s.sync("session/message/" + evt.properties.info.sessionID + "/" + evt.properties.info.id, evt.properties.info)
        }),
        Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
          await s.sync(
            "session/part/" +
              evt.properties.part.sessionID +
              "/" +
              evt.properties.part.messageID +
              "/" +
              evt.properties.part.id,
            evt.properties.part,
          )
        }),
      )
    })
  }

  export const URL =
    process.env["OPENCODE_API"] ??
    (Installation.isPreview() || Installation.isLocal() ? "https://api.dev.opencode.ai" : "https://api.opencode.ai")

  export async function create(sessionID: string) {
    return fetch(`${URL}/share_create`, {
      method: "POST",
      body: JSON.stringify({ sessionID: sessionID }),
    })
      .then((x) => x.json())
      .then((x) => x as { url: string; secret: string })
  }

  export async function remove(sessionID: string, secret: string) {
    return fetch(`${URL}/share_delete`, {
      method: "POST",
      body: JSON.stringify({ sessionID, secret }),
    }).then((x) => x.json())
  }
}
