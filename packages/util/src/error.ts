import z from "zod"

export abstract class NamedError extends Error {
  abstract schema(): z.core.$ZodType
  abstract toObject(): { name: string; data: any }

  static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data) {
    const schema = z
      .object({
        name: z.literal(name),
        data,
      })
      .meta({
        ref: name,
      })
    const result = class extends NamedError {
      public static readonly Schema = schema

      public override readonly name = name as Name

      constructor(
        public readonly data: z.input<Data>,
        options?: ErrorOptions,
      ) {
        super(name, options)
        this.name = name
      }

      static isInstance(input: any): input is InstanceType<typeof result> {
        return typeof input === "object" && "name" in input && input.name === name
      }

      schema() {
        return schema
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create(
    "UnknownError",
    z.object({
      message: z.string(),
    }),
  )
}

export namespace CommonErrors {
  export const NotFound = NamedError.create(
    "NotFoundError",
    z.object({
      resource: z.string(),
      identifier: z.string().optional(),
      message: z.string().optional(),
    }),
  )

  export const ValidationError = NamedError.create(
    "ValidationError",
    z.object({
      field: z.string().optional(),
      message: z.string(),
      value: z.any().optional(),
    }),
  )

  export const PermissionDenied = NamedError.create(
    "PermissionDeniedError",
    z.object({
      operation: z.string(),
      resource: z.string().optional(),
      message: z.string().optional(),
    }),
  )

  export const Timeout = NamedError.create(
    "TimeoutError",
    z.object({
      operation: z.string(),
      timeout: z.number().optional(),
      message: z.string().optional(),
    }),
  )

  export const Network = NamedError.create(
    "NetworkError",
    z.object({
      url: z.string().optional(),
      method: z.string().optional(),
      status: z.number().optional(),
      message: z.string().optional(),
    }),
  )

  export const IO = NamedError.create(
    "IOError",
    z.object({
      operation: z.string(),
      path: z.string().optional(),
      message: z.string().optional(),
    }),
  )

  export const Configuration = NamedError.create(
    "ConfigurationError",
    z.object({
      key: z.string().optional(),
      message: z.string(),
    }),
  )

  export const Cancelled = NamedError.create(
    "CancelledError",
    z.object({
      operation: z.string().optional(),
      reason: z.string().optional(),
    }),
  )

  export function wrapUnknown(error: unknown, context?: string): NamedError {
    if (error instanceof NamedError) {
      return error
    }
    if (error instanceof Error) {
      return new NamedError.Unknown({
        message: context ? `${context}: ${error.message}` : error.message,
      })
    }
    return new NamedError.Unknown({
      message: context ?? String(error),
    })
  }
}
