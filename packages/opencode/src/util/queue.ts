interface QueueNode<T> {
  value: T
  next: QueueNode<T> | null
}

interface QueueMetrics {
  enqueued: number
  dequeued: number
  dropped: number
  cacheHits: number
  cacheMisses: number
  currentSize: number
}

interface CacheEntry<T> {
  value: T
  expires: number
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private head: QueueNode<T> | null = null
  private tail: QueueNode<T> | null = null
  private size: number = 0
  private resolvers: ((value: T) => void)[] = []

  // Bounded queue settings
  private maxSize: number
  private dropStrategy: "oldest" | "newest" | "block"

  // Cache for deduplication (optional)
  private cache: Map<string, CacheEntry<T>> | null = null
  private cacheKeyFn: ((item: T) => string) | null = null
  private cacheTTL: number | null = null
  private readonly DEFAULT_CACHE_TTL = 5000 // 5 seconds

  // Metrics
  private metrics: QueueMetrics = {
    enqueued: 0,
    dequeued: 0,
    dropped: 0,
    cacheHits: 0,
    cacheMisses: 0,
    currentSize: 0,
  }

  constructor(options?: {
    maxSize?: number
    dropStrategy?: "oldest" | "newest" | "block"
    enableCache?: boolean
    cacheKeyFn?: (item: T) => string
    cacheTTL?: number
  }) {
    this.maxSize = options?.maxSize ?? Infinity
    this.dropStrategy = options?.dropStrategy ?? "oldest"

    if (options?.enableCache) {
      this.cache = new Map()
      this.cacheKeyFn = options.cacheKeyFn ?? ((item: any) => JSON.stringify(item))
      this.cacheTTL = options.cacheTTL ?? this.DEFAULT_CACHE_TTL
    }
  }

  push(item: T): boolean {
    // Check cache first if enabled
    if (this.cache && this.cacheKeyFn) {
      const key = this.cacheKeyFn(item)
      const cached = this.cache.get(key)
      if (cached && cached.expires > Date.now()) {
        this.metrics.cacheHits++
        const resolve = this.resolvers.shift()
        if (resolve) resolve(cached.value)
        else this.enqueueNode(cached.value)
        return true
      }
      this.metrics.cacheMisses++
    }

    // Handle bounded queue
    if (this.size >= this.maxSize) {
      if (this.dropStrategy === "newest") {
        this.metrics.dropped++
        return false
      } else if (this.dropStrategy === "oldest") {
        this.dequeueNode()
        this.metrics.dropped++
      } else {
        // block strategy - wait for space
        return this.pushWhenAvailable(item)
      }
    }

    // Store in cache if enabled
    if (this.cache && this.cacheKeyFn) {
      const key = this.cacheKeyFn(item)
      this.cache.set(key, {
        value: item,
        expires: Date.now() + (this.cacheTTL ?? this.DEFAULT_CACHE_TTL),
      })
      // Cleanup expired entries periodically
      this.cleanupCache()
    }

    this.enqueueNode(item)

    const resolve = this.resolvers.shift()
    if (resolve) resolve(item)

    return true
  }

  private enqueueNode(item: T): void {
    const node: QueueNode<T> = { value: item, next: null }
    if (!this.tail) {
      this.head = this.tail = node
    } else {
      this.tail.next = node
      this.tail = node
    }
    this.size++
    this.metrics.enqueued++
    this.metrics.currentSize = this.size
  }

  private dequeueNode(): T | null {
    if (!this.head) return null
    const value = this.head.value
    this.head = this.head.next
    if (!this.head) this.tail = null
    this.size--
    this.metrics.dequeued++
    this.metrics.currentSize = this.size
    return value
  }

  private async pushWhenAvailable(item: T): Promise<boolean> {
    return new Promise((resolve) => {
      const checkAndPush = () => {
        if (this.size < this.maxSize) {
          this.enqueueNode(item)
          const waiter = this.resolvers.shift()
          if (waiter) waiter(item)
          resolve(true)
        } else {
          // Retry after a short delay
          setTimeout(checkAndPush, 10)
        }
      }
      checkAndPush()
    })
  }

  async next(): Promise<T> {
    const item = this.dequeueNode()
    if (item) return item

    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  async *[Symbol.asyncIterator]() {
    while (true) yield await this.next()
  }

  // Public API for metrics and introspection
  getMetrics(): Readonly<QueueMetrics> {
    return { ...this.metrics }
  }

  clear(): void {
    this.head = this.tail = null
    this.size = 0
    this.metrics.currentSize = 0
  }

  get length(): number {
    return this.size
  }

  get pending(): number {
    return this.resolvers.length
  }

  private cleanupCache(): void {
    if (!this.cache) return
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expires <= now) {
        this.cache.delete(key)
      }
    }
  }

  clearCache(): void {
    this.cache?.clear()
  }
}

export interface WorkOptions<T> {
  concurrency?: number | { min: number; max: number }
  onProgress?: (completed: number, total: number) => void
  onError?: (error: Error, item: T) => void
  enableBatching?: boolean
  batchSize?: number
}

export interface WorkMetrics {
  completed: number
  failed: number
  total: number
  currentConcurrency: number
}

export async function work<T>(
  concurrency: number | { min: number; max: number },
  items: T[],
  fn: (item: T) => Promise<void>,
  options?: WorkOptions<T>
): Promise<WorkMetrics> {
  const pending = [...items]
  const total = items.length
  let completed = 0
  let failed = 0
  let activeWorkers = 0

  // Dynamic concurrency settings
  const minConcurrency = typeof concurrency === "number" ? concurrency : concurrency.min
  const maxConcurrency = typeof concurrency === "number" ? concurrency : concurrency.max

  // Batch processing for better throughput
  const batchSize = options?.batchSize ?? 1
  const enableBatching = options?.enableBatching ?? batchSize > 1

  // Result queue for worker coordination
  const resultQueue = new AsyncQueue<{ success: boolean; error?: Error }>()

  const processBatch = async (batch: T[]): Promise<void> => {
    const promises = batch.map(async (item) => {
      try {
        await fn(item)
        completed++
        resultQueue.push({ success: true })
      } catch (error) {
        failed++
        resultQueue.push({ success: false, error: error as Error })
        options?.onError?.(error as Error, item)
      }
      if (options?.onProgress) {
        options.onProgress(completed + failed, total)
      }
    })
    await Promise.all(promises)
  }

  const worker = async (): Promise<void> => {
    activeWorkers++
    while (pending.length > 0) {
      // Check if we should scale down
      if (activeWorkers > Math.ceil(pending.length / batchSize) && activeWorkers > minConcurrency) {
        activeWorkers--
        return
      }

      if (enableBatching) {
        const batch: T[] = []
        for (let i = 0; i < batchSize && pending.length > 0; i++) {
          batch.push(pending.pop()!)
        }
        if (batch.length > 0) {
          await processBatch(batch)
        }
      } else {
        const item = pending.pop()
        if (item !== undefined) {
          await processBatch([item])
        }
      }
    }
    activeWorkers--
  }

  // Start with minimum concurrency
  const initialWorkers = Math.min(minConcurrency, Math.ceil(total / batchSize))
  const workers = Array.from({ length: initialWorkers }, () => worker())

  // Dynamic scaling: add workers if there's a backlog
  const scaler = setInterval(() => {
    const needed = Math.min(
      maxConcurrency - activeWorkers,
      Math.ceil(pending.length / batchSize) - activeWorkers
    )
    if (needed > 0 && activeWorkers < maxConcurrency) {
      for (let i = 0; i < needed; i++) {
        workers.push(worker())
      }
    }
  }, 100) // Check every 100ms

  await Promise.all(workers)
  clearInterval(scaler)

  return {
    completed,
    failed,
    total,
    currentConcurrency: activeWorkers,
  }
}
