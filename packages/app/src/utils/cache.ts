/**
 * LRU cache with TTL and size limits for preventing memory leaks
 */

export type CacheOpts = {
  maxEntries?: number
  ttlMs?: number
  maxBytes?: number
  sizeOf?: (value: unknown) => number
  onEvict?: (key: string, value: unknown) => void
}

type CacheEntry<T> = {
  value: T
  lastAccess: number
  createdAt: number
}

export function createLruCache<T>(opts: CacheOpts = {}) {
  const {
    maxEntries = Infinity,
    ttlMs = Infinity,
    maxBytes = Infinity,
    sizeOf = () => 0,
    onEvict,
  } = opts

  let currentBytes = 0
  const cache = new Map<string, CacheEntry<T>>()

  function evictExpired() {
    const now = Date.now()
    for (const [key, entry] of cache) {
      if (now - entry.createdAt > ttlMs) {
        delete_(key)
      }
    }
  }

  function evictOne() {
    let oldestKey: string | null = null
    let oldestAccess = Infinity

    for (const [key, entry] of cache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess
        oldestKey = key
      }
    }

    if (oldestKey) {
      delete_(oldestKey)
    }
  }

  function delete_(key: string): boolean {
    const entry = cache.get(key)
    if (!entry) return false

    currentBytes -= sizeOf(entry.value)
    onEvict?.(key, entry.value)
    return cache.delete(key)
  }

  function evictToMakeRoomFor(value: T) {
    evictExpired()

    const entrySize = sizeOf(value)
    while (cache.size >= maxEntries || currentBytes + entrySize > maxBytes) {
      if (cache.size === 0) break
      evictOne()
    }
  }

  return {
    get(key: string): T | undefined {
      const entry = cache.get(key)
      if (!entry) return undefined

      const now = Date.now()
      if (now - entry.createdAt > ttlMs) {
        delete_(key)
        return undefined
      }

      entry.lastAccess = now
      return entry.value
    },

    set(key: string, value: T): void {
      const existing = cache.get(key)
      if (existing) {
        currentBytes -= sizeOf(existing.value)
      }

      evictToMakeRoomFor(value)

      const now = Date.now()
      cache.set(key, { value, lastAccess: now, createdAt: now })
      currentBytes += sizeOf(value)
    },

    has(key: string): boolean {
      const entry = cache.get(key)
      if (!entry) return false

      const now = Date.now()
      if (now - entry.createdAt > ttlMs) {
        delete_(key)
        return false
      }

      return true
    },

    peek(key: string): T | undefined {
      return cache.get(key)?.value
    },

    delete(key: string): boolean {
      return delete_(key)
    },

    clear(): void {
      for (const [key, entry] of cache) {
        onEvict?.(key, entry.value)
      }
      cache.clear()
      currentBytes = 0
    },

    get size() {
      return cache.size
    },

    get byteSize() {
      return currentBytes
    },

    stats() {
      return {
        size: cache.size,
        byteSize: currentBytes,
        keys: Array.from(cache.keys()),
      }
    },
  }
}
