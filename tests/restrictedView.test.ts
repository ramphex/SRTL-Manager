import { describe, expect, it } from "vitest";
import { scrubText } from "../src/server/lib/restrictedView";

const roots = [{ path: "/mnt/plex", label: "<symlinks>" }];

describe("restricted view scrubbing", () => {
  it("removes URLs and host:port addresses as before", () => {
    const cases: Array<[string, string]> = [
      ["see http://host:1234/a?token=abc now", "see <address> now"],
      ["reached [::1]:7878 and radarr.lan:7878 and localhost:8989", "reached <address> and <address> and <address>"],
      ["Alpha.Bravo.S01E02.mkv from 192.0.2.10:32400", "Alpha.Bravo.S01E02.mkv from <address>"],
      ["proxy=http://user@example.com:8080/x,next", "proxy=<address>"],
      ["LOCALHOST:80 and mylocalhost:80 and localhost:123456", "<address> and mylocalhost:80 and localhost:123456"],
      ["nas-01.example.com:9000. retrying", "<address>. retrying"],
      ["...nas.example.com:443 and a..b.example.com:443", "...<address> and a..<address>"],
      ["-x.example.com:22 and _x.example.com:22 and example.com.:22", "-<address> and _x.<address> and example.com.:22"],
      ["s3+https://bucket.example.com/key and 1.http://example.com", "<address> and 1.<address>"],
      ["time 12:30:45 and ratio 16:9 and version 1.2.3", "time 12:30:45 and ratio 16:9 and version 1.2.3"],
      ["/mnt/plex/movies/Alpha (2020)/Alpha.mkv", "<symlinks>/movies/Alpha (2020)/Alpha.mkv"]
    ];
    for (const [input, output] of cases) expect(scrubText(input, roots), input).toBe(output);
  });

  it("reads long dotted names in linear time", () => {
    const size = 64 * 1024;
    const inputs = [
      "1.".repeat(size / 2),
      "a.".repeat(size / 2),
      "a.b-".repeat(size / 4),
      "ab1.".repeat(size / 4),
      `${"1.".repeat(size / 2)}:80`,
      `${"a..".repeat(size / 3)}a:80`,
      "1.1.1.1:".repeat(size / 8),
      "1.1.1.1.".repeat(size / 8),
      "a+".repeat(size / 2),
      "a:8 ".repeat(size / 4),
      "[:".repeat(size / 2),
      "localhost:".repeat(size / 10)
    ];
    for (const input of inputs) {
      const started = performance.now();
      scrubText(input, roots);
      expect(performance.now() - started, input.slice(0, 16)).toBeLessThan(100);
    }
  });
});
