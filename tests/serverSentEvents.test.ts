import { describe, expect, it } from "vitest";
import { ServerSentEventError, ServerSentEventParser, type ServerSentEvent } from "../src/server/lib/serverSentEvents";

function reader(maxEventSize?: number) {
  const events: ServerSentEvent[] = [];
  const retries: number[] = [];
  const comments: string[] = [];
  const parser = new ServerSentEventParser({ onEvent: (event) => events.push(event), onRetry: (ms) => retries.push(ms), onComment: (text) => comments.push(text) }, maxEventSize);
  return { parser, events, retries, comments };
}

describe("server-sent event parser", () => {
  it("reads typed events with ids, retry and comments", () => {
    const { parser, events, retries, comments } = reader();
    parser.push("retry: 5000\n\n: ping\n\nid: 1\nevent: snapshot\ndata: {\"sessions\":[]}\n\n");
    expect(retries).toEqual([5000]);
    expect(comments).toEqual(["ping"]);
    expect(events).toEqual([{ type: "snapshot", data: "{\"sessions\":[]}", id: "1" }]);
    expect(parser.lastEventId).toBe("1");
  });

  it("joins multi-line data, defaults the type, and keeps the last id for later events", () => {
    const { parser, events } = reader();
    parser.push("id: 7\ndata: first\ndata:second\ndata\n\ndata: next\n\n");
    expect(events).toEqual([{ type: "message", data: "first\nsecond\n", id: "7" }, { type: "message", data: "next", id: "7" }]);
  });

  it("handles CRLF, lone CR, and chunks split anywhere, including inside a character and a CRLF", () => {
    const text = "﻿id: a\r\nevent: session\r\ndata: {\"name\":\"Amélie\"}\r\n\r\nid: b\revent: session.ended\rdata: x\r\r";
    const bytes = Buffer.from(text, "utf8");
    for (let step = 1; step <= 7; step += 1) {
      const { parser, events } = reader();
      for (let index = 0; index < bytes.length; index += step) parser.push(bytes.subarray(index, index + step));
      expect(events).toEqual([
        { type: "session", data: "{\"name\":\"Amélie\"}", id: "a" },
        { type: "session.ended", data: "x", id: "b" }
      ]);
    }
    // A CR at the end of one chunk and an LF at the start of the next are one line break, not two.
    const { parser, events } = reader();
    parser.push("data: one\r");
    parser.push("\ndata: two\r\n\r\n");
    expect(events).toEqual([{ type: "message", data: "one\ntwo", id: "" }]);
  });

  it("ignores unknown fields, invalid retry values, ids with NUL, and blocks without data", () => {
    const { parser, events, retries } = reader();
    parser.push("retry: soon\nretry: 12x\nfoo: bar\nid: 3\n\nid: bad\u0000id\nevent: session\n\ndata: y\n\n");
    expect(retries).toEqual([]);
    expect(events).toEqual([{ type: "message", data: "y", id: "3" }]);
  });

  it("refuses an event or an unfinished line larger than the limit", () => {
    const big = reader(64);
    expect(() => big.parser.push(`data: ${"x".repeat(40)}\ndata: ${"x".repeat(40)}\n`)).toThrow(ServerSentEventError);
    const line = reader(64);
    expect(() => line.parser.push(`data: ${"x".repeat(80)}`)).toThrow(ServerSentEventError);
    const fits = reader(64);
    fits.parser.push(`data: ${"x".repeat(50)}\n\n`);
    fits.parser.push(`data: ${"x".repeat(50)}\n\n`);
    expect(fits.events).toHaveLength(2);
  });
});
