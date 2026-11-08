import { describe, expect, it } from "vitest";
import {
  allowedSearchEdits,
  createSearchMatcher,
  filterBySearch,
  matchSearchTerms,
  normalizeSearchText,
  parseSearchQuery,
  pathTail,
  searchTermPieces,
  startsWithinEdits
} from "../src/shared/search";

function matches(query: string, text: string): boolean {
  const matcher = createSearchMatcher(query);
  if (!matcher) throw new Error("expected a query with words");
  return matcher(text);
}

describe("normalizeSearchText", () => {
  it("ignores case, accents and apostrophes, and turns symbols into single spaces", () => {
    expect(normalizeSearchText("Alpha.Bravo.S01E02.1080p-GRP")).toBe("alpha bravo s01e02 1080p grp");
    expect(normalizeSearchText("Charlie's Lab")).toBe("charlies lab");
    expect(normalizeSearchText("Charlie’s Lab")).toBe("charlies lab");
    expect(normalizeSearchText("Delta! Echo [2019] (Foxtrot)_Golf")).toBe("delta echo 2019 foxtrot golf");
    expect(normalizeSearchText("Café Crème Ærø Straße")).toBe("cafe creme aero strasse");
    expect(normalizeSearchText("  ")).toBe("");
  });

  it("keeps letters from other scripts", () => {
    expect(normalizeSearchText("Альфа.Браво")).toBe("альфа браво");
  });
});

describe("allowedSearchEdits", () => {
  it("allows none for short words and anything with digits, 1 for 5 to 8 letters and 2 beyond", () => {
    expect(allowedSearchEdits("lab")).toBe(0);
    expect(allowedSearchEdits("echo")).toBe(0);
    expect(allowedSearchEdits("alpha")).toBe(1);
    expect(allowedSearchEdits("charlies")).toBe(1);
    expect(allowedSearchEdits("lighthouse")).toBe(2);
    expect(allowedSearchEdits("s01e02")).toBe(0);
    expect(allowedSearchEdits("2019")).toBe(0);
    expect(allowedSearchEdits("season10")).toBe(0);
  });
});

describe("parseSearchQuery", () => {
  it("returns no terms for an empty or symbol-only query", () => {
    expect(parseSearchQuery("")).toEqual([]);
    expect(parseSearchQuery("  ...  ")).toEqual([]);
  });

  it("splits into unique normalised words", () => {
    expect(parseSearchQuery("Alpha alpha.Bravo").map((term) => term.text)).toEqual(["alpha", "bravo"]);
  });
});

describe("matching", () => {
  it("matches across dots, punctuation and apostrophes", () => {
    expect(matches("Alpha Bravo", "Shows/Alpha.Bravo/Season 01/Alpha.Bravo.S01E02.1080p.mkv")).toBe(true);
    expect(matches("Charlies Lab", "Movies/Charlie's Lab (2019)/Charlie's Lab (2019).mkv")).toBe(true);
    expect(matches("charlie s lab", "Charlie's Lab")).toBe(true);
    expect(matches("Charlie's", "Charlies.Lab.2019")).toBe(true);
    expect(matches("Delta Echo", "Delta! Echo (2020)")).toBe(true);
    expect(matches("cafe", "Café Society")).toBe(true);
    expect(matches("CAFÉ", "cafe society")).toBe(true);
  });

  it("matches words in any order, and needs every word", () => {
    expect(matches("Bravo Alpha", "Alpha.Bravo.S01E02")).toBe(true);
    expect(matches("Alpha Zulu", "Alpha.Bravo.S01E02")).toBe(false);
  });

  it("still matches part of a word", () => {
    expect(matches("brav", "Alpha.Bravo")).toBe(true);
    expect(matches("lpha", "Alpha.Bravo")).toBe(true);
  });

  it("allows one typo in a 5 to 8 letter word", () => {
    expect(matches("Alpah Bravo", "Alpha.Bravo")).toBe(true); // swapped letters
    expect(matches("Alpa Bravo", "Alpha.Bravo")).toBe(false); // 4 letters: exact only
    expect(matches("Alphq Bravo", "Alpha.Bravo")).toBe(true); // substituted letter
    expect(matches("Charlis Lab", "Charlie's Lab")).toBe(true); // missing letter
    expect(matches("Charrlies Lab", "Charlie's Lab")).toBe(true); // extra letter
    expect(matches("Alxhq Bravo", "Alpha.Bravo")).toBe(false); // two typos
  });

  it("allows two typos in longer words", () => {
    expect(matches("lihgthuose", "The.Lighthouse.Keeper")).toBe(true);
    expect(matches("lixgthuose", "The.Lighthouse.Keeper")).toBe(false);
  });

  it("matches the start of a longer word with a typo", () => {
    expect(matches("Bravp", "Bravoes.Return")).toBe(true);
  });

  it("never allows typos in short words, numbers, years or episode codes", () => {
    expect(matches("lap", "Charlie's Lab")).toBe(false);
    expect(matches("Alpha S01E03", "Alpha.Bravo.S01E02")).toBe(false);
    expect(matches("Alpha S01E02", "Alpha.Bravo.S01E02")).toBe(true);
    expect(matches("2018", "Charlie's Lab (2019)")).toBe(false);
    expect(matches("2019", "Charlie's Lab (2019)")).toBe(true);
    expect(matches("s01e02", "Alpha.Bravo.S01E02")).toBe(true);
  });

  it("returns null for an empty query so callers can keep the whole list", () => {
    expect(createSearchMatcher("   ")).toBeNull();
  });

  it("says whether every word matched exactly", () => {
    expect(matchSearchTerms(parseSearchQuery("alpha"), "alpha bravo")).toBe("exact");
    expect(matchSearchTerms(parseSearchQuery("alpah"), "alpha bravo")).toBe("fuzzy");
    expect(matchSearchTerms(parseSearchQuery("zulu"), "alpha bravo")).toBeNull();
    expect(matchSearchTerms([], "alpha bravo")).toBe("exact");
  });
});

describe("filterBySearch", () => {
  const items = ["Alpha.Bravo", "Alpah.Bravo", "Charlie's Lab", "Alpha.Charlie"];

  it("keeps the original order and the same list when the query is empty", () => {
    expect(filterBySearch(items, "", (item) => [item])).toBe(items);
    expect(filterBySearch(items, "alpha", (item) => [item])).toEqual(["Alpha.Bravo", "Alpah.Bravo", "Alpha.Charlie"]);
  });

  it("can put exact matches before typo matches", () => {
    expect(filterBySearch(["Alpah.Bravo", "Alpha.Bravo"], "alpha", (item) => [item], { rankExactFirst: true })).toEqual(["Alpha.Bravo", "Alpah.Bravo"]);
  });
});

describe("startsWithinEdits", () => {
  it("measures the distance to the closest start of the word", () => {
    expect(startsWithinEdits("bravo", "bravo", 0)).toBe(true);
    expect(startsWithinEdits("bravo", "bravery", 1)).toBe(true);
    expect(startsWithinEdits("bravo", "brv", 1)).toBe(false);
    expect(startsWithinEdits("abcdefghijklmnopqrstuvwxyzabcdefghij", "abcdefghijklmnopqrstuvwxyzabcdefghik", 2)).toBe(true);
  });
});

describe("searchTermPieces", () => {
  it("splits a term into one more piece than the edits it allows", () => {
    expect(searchTermPieces({ text: "s01e02", maxEdits: 0 })).toEqual(["s01e02"]);
    expect(searchTermPieces({ text: "alpha", maxEdits: 1 })).toHaveLength(2);
    expect(searchTermPieces({ text: "lighthouse", maxEdits: 2 })).toHaveLength(3);
    expect(searchTermPieces({ text: "lighthouse", maxEdits: 2 })).toEqual(["lig", "tho", "se"]);
    expect(searchTermPieces({ text: "alpha", maxEdits: 1 })).toEqual(["al", "ha"]);
  });

  it("survives two swapped pairs that straddle piece boundaries", () => {
    const [term] = parseSearchQuery("lihgthuose");
    expect(matchSearchTerms([term!], "lighthouse")).toBe("fuzzy");
    expect(searchTermPieces(term!).some((piece) => "lighthouse".includes(piece))).toBe(true);
  });

  it("always leaves a piece that appears unchanged in a matching text", () => {
    // Every single edit at every position, and every pair of edits for the longer words.
    const words = ["alpha", "bravo", "charlies", "lighthouse", "foxtrotting"];
    const edits = (word: string) => {
      const results: string[] = [];
      for (let index = 0; index <= word.length; index += 1) {
        results.push(`${word.slice(0, index)}x${word.slice(index)}`);
        if (index < word.length) results.push(`${word.slice(0, index)}${word.slice(index + 1)}`, `${word.slice(0, index)}z${word.slice(index + 1)}`);
        if (index < word.length - 1) results.push(`${word.slice(0, index)}${word[index + 1]}${word[index]}${word.slice(index + 2)}`);
      }
      return results;
    };
    const typos = (word: string) => {
      const once = edits(word);
      return word.length >= 9 ? [...once, ...once.flatMap(edits)] : once;
    };
    for (const word of words) {
      for (const typo of typos(word)) {
        const [term] = parseSearchQuery(typo);
        if (!term || matchSearchTerms([term], word) === null) continue;
        expect(searchTermPieces(term).some((piece) => word.includes(piece))).toBe(true);
      }
    }
  });
});

describe("pathTail", () => {
  it("keeps the last segments of a path", () => {
    expect(pathTail("/mnt/remote/movies/Alpha.Bravo.2019/Alpha.Bravo.2019.mkv")).toBe("Alpha.Bravo.2019/Alpha.Bravo.2019.mkv");
    expect(pathTail("file.mkv")).toBe("file.mkv");
    expect(pathTail(null)).toBeUndefined();
  });
});
