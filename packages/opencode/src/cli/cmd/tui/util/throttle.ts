import { createSignal, type Accessor } from "solid-js"
import { throttle, type Scheduled } from "@solid-primitives/scheduled"

/**
 * Creates a throttled signal that only updates at most once per specified duration.
 * Useful for reducing update frequency during high-frequency events like streaming.
 *
 * @param value - Initial value
 * @param ms - Minimum milliseconds between updates
 * @returns [getter, setter] - The setter is throttled
 */
export function createThrottledSignal<T>(value: T, ms: number): [Accessor<T>, Scheduled<[value: T]>] {
  const [get, set] = createSignal(value)
  return [get, throttle((v: T) => set(() => v), ms)]
}
