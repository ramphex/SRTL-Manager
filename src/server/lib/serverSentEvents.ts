// A reader for server-sent events (text/event-stream), as the HTML standard defines them: lines end in CRLF, LF or
// CR, a line starting with ":" is a comment, "data" lines join with newlines, a blank line ends the event, and the
// "id" and "retry" fields carry over between events. Chunks may split anywhere, even inside a character or between
// the CR and LF of one line break.

export interface ServerSentEvent {
  // "message" when the event names no type.
  type: string;
  data: string;
  // The last id the stream gave, which this event carries unless it set its own.
  id: string;
}

export interface ServerSentEventHandlers {
  onEvent: (event: ServerSentEvent) => void;
  onRetry?: (ms: number) => void;
  onComment?: (text: string) => void;
}

export class ServerSentEventError extends Error {}

const lineBreak = /\r\n|\r|\n/g;

export class ServerSentEventParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private started = false;
  // The previous chunk ended in CR, so an LF that starts this one belongs to the same line break.
  private endedInCr = false;
  private data: string[] = [];
  private dataSize = 0;
  private type = "";
  private id = "";

  // The limit covers one event's data and any unfinished line, in characters.
  constructor(private readonly handlers: ServerSentEventHandlers, private readonly maxEventSize = 1024 * 1024) {}

  get lastEventId(): string {
    return this.id;
  }

  // Throws ServerSentEventError when an event or line grows past the limit; the stream should then be dropped.
  push(chunk: Buffer | string): void {
    let text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (!text) return;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (this.endedInCr && text.startsWith("\n")) text = text.slice(1);
    this.endedInCr = false;
    this.buffer += text;
    let start = 0;
    lineBreak.lastIndex = 0;
    for (let match = lineBreak.exec(this.buffer); match; match = lineBreak.exec(this.buffer)) {
      const line = this.buffer.slice(start, match.index);
      start = match.index + match[0].length;
      if (match[0] === "\r" && start === this.buffer.length) this.endedInCr = true;
      this.line(line);
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length + this.dataSize > this.maxEventSize) throw new ServerSentEventError("An event is larger than the supported size.");
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) {
      this.handlers.onComment?.(line.slice(1).replace(/^ /, ""));
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.type = value;
    else if (field === "data") {
      this.data.push(value);
      this.dataSize += value.length + 1;
      if (this.dataSize > this.maxEventSize) throw new ServerSentEventError("An event is larger than the supported size.");
    } else if (field === "id") {
      if (!value.includes("\u0000")) this.id = value;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) this.handlers.onRetry?.(Number(value));
    }
  }

  private dispatch(): void {
    const data = this.data;
    const type = this.type;
    this.data = [];
    this.dataSize = 0;
    this.type = "";
    if (!data.length) return;
    this.handlers.onEvent({ type: type || "message", data: data.join("\n"), id: this.id });
  }
}
