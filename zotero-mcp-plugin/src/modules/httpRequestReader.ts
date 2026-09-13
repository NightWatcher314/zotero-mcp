/**
 * Byte-level HTTP request reader.
 *
 * Deliberately free of XPCOM and Zotero globals so it can be unit-tested with
 * a fake socket that places chunk boundaries anywhere - including inside a
 * multibyte UTF-8 sequence, which is what the v1.5.0 body-corruption bug
 * depended on.
 *
 * The rule this module exists to enforce: HTTP framing is byte-denominated
 * (Content-Length counts bytes, the header terminator is a byte sequence), so
 * every read, offset and comparison here is in bytes. Text decoding happens
 * exactly once, at the end, on a complete buffer.
 */

/** Minimal socket abstraction: the XPCOM binary input stream fits this. */
export interface ByteReader {
  /** Bytes currently readable without blocking. */
  available(): number;
  /**
   * Read up to `count` bytes. Callers never request more than `available()`
   * reported, so a conforming reader returns exactly `count` bytes.
   */
  readBytes(count: number): Uint8Array;
}

export interface HttpRequestReadOptions {
  /** Hard cap on a single request, in bytes. Default 1 MiB. */
  maxRequestSize?: number;
  /** Consecutive empty polls tolerated before giving up. Default 50. */
  maxWaitAttempts?: number;
  /** Delay between empty polls, in ms. Default 10. */
  waitMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface HttpRequestRead {
  /** Decoded header block, excluding the terminating CRLFCRLF. */
  headerText: string;
  /** Decoded body, exactly `contentLength` bytes worth. */
  body: string;
  /** Declared Content-Length in bytes (0 when absent). */
  contentLength: number;
  /** Body bytes actually received; less than contentLength when truncated. */
  bodyBytesRead: number;
  /** Total bytes pulled off the socket. */
  totalBytesRead: number;
  /** Bytes read beyond the end of this request (pipelined next request). */
  trailingBytes: number;
  /** False when headers never terminated or the body never reached Content-Length. */
  complete: boolean;
  /** Set when the read stopped early; used for diagnostics. */
  incompleteReason?: "no-data" | "headers-truncated" | "body-truncated" | "too-large";
}

const CR = 0x0d;
const LF = 0x0a;

const DEFAULTS = {
  maxRequestSize: 1024 * 1024,
  maxWaitAttempts: 50,
  waitMs: 10,
};

/** Header-phase read budget. Bytes, not characters. */
const HEADER_CHUNK = 4096;
/** Body-phase read budget. Bytes, not characters. */
const BODY_CHUNK = 8192;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Locate the CRLFCRLF header terminator.
 *
 * @returns index of the first CR of the terminator, or -1.
 */
export function indexOfHeaderTerminator(
  bytes: Uint8Array,
  length: number,
  from = 0,
): number {
  // Back up 3 bytes so a terminator straddling the previous scan is still found.
  const start = Math.max(0, from - 3);
  for (let i = start; i + 3 < length; i++) {
    if (
      bytes[i] === CR &&
      bytes[i + 1] === LF &&
      bytes[i + 2] === CR &&
      bytes[i + 3] === LF
    ) {
      return i;
    }
  }
  return -1;
}

/** Parse Content-Length from a decoded header block. Returns 0 when absent. */
export function parseContentLength(headerText: string): number {
  const match = headerText.match(/^Content-Length:[ \t]*(\d+)[ \t]*$/im);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Growable byte buffer. Avoids re-allocating per chunk. */
class ByteBuffer {
  private buf: Uint8Array;
  length = 0;

  constructor(initial = 8192) {
    this.buf = new Uint8Array(initial);
  }

  append(chunk: Uint8Array): void {
    const needed = this.length + chunk.length;
    if (needed > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < needed) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.length), 0);
      this.buf = next;
    }
    this.buf.set(chunk, this.length);
    this.length = needed;
  }

  bytes(): Uint8Array {
    return this.buf;
  }

  slice(start: number, end: number): Uint8Array {
    return this.buf.subarray(start, Math.min(end, this.length));
  }
}

/**
 * Read one complete HTTP request off `reader`.
 *
 * Headers and body are accumulated as raw bytes and decoded once at the end,
 * so no read boundary can split a UTF-8 sequence.
 */
export async function readHttpRequest(
  reader: ByteReader,
  options: HttpRequestReadOptions = {},
): Promise<HttpRequestRead> {
  const maxRequestSize = options.maxRequestSize ?? DEFAULTS.maxRequestSize;
  const maxWaitAttempts = options.maxWaitAttempts ?? DEFAULTS.maxWaitAttempts;
  const waitMs = options.waitMs ?? DEFAULTS.waitMs;
  const sleep = options.sleep ?? defaultSleep;

  const buffer = new ByteBuffer();
  let waitAttempts = 0;
  let scanned = 0;
  let headerEnd = -1;
  let contentLength = 0;
  let headerText = "";
  let bodyEnd = -1;
  let incompleteReason: HttpRequestRead["incompleteReason"];

  // Single loop for both phases: the target end offset is unknown until the
  // headers are parsed, at which point it becomes headerEnd + 4 + contentLength.
  for (;;) {
    if (bodyEnd >= 0 && buffer.length >= bodyEnd) break;

    if (buffer.length >= maxRequestSize) {
      incompleteReason = "too-large";
      break;
    }

    // Never read past the end of this request: any excess belongs to a
    // pipelined follow-up on the same socket.
    const budget =
      bodyEnd >= 0
        ? Math.min(BODY_CHUNK, bodyEnd - buffer.length)
        : Math.min(HEADER_CHUNK, maxRequestSize - buffer.length);

    let available = 0;
    try {
      available = reader.available();
    } catch {
      // Stream closed underneath us.
      available = 0;
    }

    if (available <= 0) {
      waitAttempts++;
      if (waitAttempts > maxWaitAttempts) {
        incompleteReason =
          headerEnd < 0 ? (buffer.length === 0 ? "no-data" : "headers-truncated") : "body-truncated";
        break;
      }
      await sleep(waitMs);
      continue;
    }

    let chunk: Uint8Array;
    try {
      chunk = reader.readBytes(Math.min(budget, available));
    } catch {
      // A live socket reporting data but failing to deliver it means EOF.
      incompleteReason =
        headerEnd < 0 ? "headers-truncated" : "body-truncated";
      break;
    }

    if (!chunk || chunk.length === 0) {
      incompleteReason =
        headerEnd < 0
          ? buffer.length === 0
            ? "no-data"
            : "headers-truncated"
          : "body-truncated";
      break;
    }

    waitAttempts = 0;
    buffer.append(chunk);

    if (headerEnd < 0) {
      const found = indexOfHeaderTerminator(
        buffer.bytes(),
        buffer.length,
        scanned,
      );
      scanned = buffer.length;
      if (found >= 0) {
        headerEnd = found;
        headerText = decodeUtf8(buffer.slice(0, headerEnd));
        contentLength = parseContentLength(headerText);
        bodyEnd = headerEnd + 4 + contentLength;
      }
    }
  }

  if (headerEnd < 0) {
    return {
      headerText: buffer.length > 0 ? decodeUtf8(buffer.slice(0, buffer.length)) : "",
      body: "",
      contentLength: 0,
      bodyBytesRead: 0,
      totalBytesRead: buffer.length,
      trailingBytes: 0,
      complete: false,
      incompleteReason: incompleteReason ?? "headers-truncated",
    };
  }

  const bodyStart = headerEnd + 4;
  const bodyBytesRead = Math.max(0, buffer.length - bodyStart);
  const complete = bodyBytesRead >= contentLength && !incompleteReason;

  return {
    headerText,
    // Decode exactly Content-Length bytes, once, from a complete buffer.
    body: decodeUtf8(buffer.slice(bodyStart, bodyStart + contentLength)),
    contentLength,
    bodyBytesRead: Math.min(bodyBytesRead, contentLength),
    totalBytesRead: buffer.length,
    trailingBytes: Math.max(0, buffer.length - bodyEnd),
    complete,
    incompleteReason: complete ? undefined : incompleteReason ?? "body-truncated",
  };
}

/** Decode UTF-8 bytes to a string, substituting U+FFFD for malformed input. */
export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  return new TextDecoder("utf-8").decode(bytes);
}

/** UTF-8 byte length of a string. */
export function getByteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}
