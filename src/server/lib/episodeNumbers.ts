import path from "node:path";

// The season and episodes a Sonarr-style file name holds: S01E03, S01E03E04, S01E03-E04 and S01E03-04 all count.
export function parseEpisodeNumbers(fileName: string): { season: number; episodes: number[] } | null {
  const match = path.posix.basename(fileName).match(/\bs(\d{1,4})e(\d{1,4})((?:-?e\d{1,4}|-\d{1,4})*)\b/i);
  if (!match) return null;
  const numbers = [Number(match[2]), ...[...(match[3] ?? "").matchAll(/\d+/g)].map((entry) => Number(entry[0]))];
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  if (last - first >= 50) return null;
  return { season: Number(match[1]), episodes: Array.from({ length: last - first + 1 }, (_, index) => first + index) };
}
