// StreamDrop relays request bodies instead of buffering them, so the server-level
// body limit must not reject large file transfers before the stream reaches Hono.
export const MAX_REQUEST_BODY_SIZE = Number.MAX_SAFE_INTEGER
