import { describe, expect, it } from "vitest";
import { buildTitleIndex, matchReleaseTitle, releaseKeyOf, releaseNameOf } from "../src/server/lib/releaseTitles";

const now = new Date("2026-06-01T00:00:00Z");
const movie = (itemName: string) => ({ itemName, isShow: false });
const show = (itemName: string) => ({ itemName, isShow: true });
const matches = (titles: Array<{ itemName: string; isShow: boolean | null }>, release: string) => matchReleaseTitle(buildTitleIndex(titles, now), release, now);

describe("matchReleaseTitle", () => {
  it("matches the whole title in common release naming styles", () => {
    const titles = [movie("Alpha Bravo (2020)")];
    for (const release of ["Alpha.Bravo.2020.1080p.WEB-DL.x264-GRP", "Alpha Bravo (2020) [1080p]", "alpha_bravo_2020_2160p", "[Group] Alpha Bravo 2020 1080p", "Alpha.Bravo.2020"]) {
      expect(matches(titles, release), release).toBe("Alpha Bravo (2020)");
    }
    // The title is compared whole, never by part.
    for (const release of ["Alpha.Bravo.Charlie.2020.1080p", "Bravo.2020.1080p", "Alpha.2020.1080p", "Not.Alpha.Bravo.2020"]) {
      expect(matches(titles, release), release).toBeNull();
    }
  });

  it("ignores case, accents, punctuation and id tags on either side", () => {
    expect(matches([movie("Amélie's Café & Bar (2001) {tmdb-12345}")], "Amelies.Cafe.and.Bar.2001.BluRay.1080p")).toBe("Amélie's Café & Bar (2001) {tmdb-12345}");
    expect(matches([movie("Mr. Delta [imdb-tt0000000] (1999)")], "Mr.Delta.1999.720p")).toBe("Mr. Delta [imdb-tt0000000] (1999)");
  });

  it("does not match a different year, apart from a year either side of a new-year release", () => {
    const titles = [movie("Alpha Bravo (2020)")];
    expect(matches(titles, "Alpha.Bravo.2021.1080p")).toBe("Alpha Bravo (2020)");
    expect(matches(titles, "Alpha.Bravo.2019.1080p")).toBe("Alpha Bravo (2020)");
    expect(matches(titles, "Alpha.Bravo.1985.1080p")).toBeNull();
    expect(matches([movie("Alpha Bravo (1985)"), movie("Alpha Bravo (2020)")], "Alpha.Bravo.2020.1080p")).toBe("Alpha Bravo (2020)");
    expect(matches([movie("Alpha Bravo (1985)"), movie("Alpha Bravo (2020)")], "Alpha.Bravo.1985.1080p")).toBe("Alpha Bravo (1985)");
  });

  it("keeps years and numbers that are part of the title", () => {
    expect(matches([movie("1931 (2019)")], "1931.2019.1080p.BluRay")).toBe("1931 (2019)");
    expect(matches([movie("1907 (2003)")], "1907.2003.1080p")).toBe("1907 (2003)");
    expect(matches([movie("Walker 2049 (2017)")], "Walker.2049.2017.1080p")).toBe("Walker 2049 (2017)");
    expect(matches([movie("Walker 2049 (2017)")], "Walker.2049.1080p")).toBe("Walker 2049 (2017)");
    expect(matches([movie("Walker (1982)"), movie("Walker 2049 (2017)")], "Walker.1982.1080p")).toBe("Walker (1982)");
    expect(matches([movie("Sequel 3 (1992)")], "Sequel.3.1992.1080p")).toBe("Sequel 3 (1992)");
    expect(matches([show("Orbit 1999")], "Orbit.1999.S01E01.720p")).toBe("Orbit 1999");
    expect(matches([movie("Thirty 2030 (2020)")], "Thirty.2030.1080p")).toBe("Thirty 2030 (2020)");
  });

  it("needs a year for short and common titles", () => {
    expect(matches([movie("On (2009)")], "On.1080p.WEB-DL")).toBeNull();
    expect(matches([movie("On (2009)")], "On.2009.1080p")).toBe("On (2009)");
    expect(matches([movie("On (2009)")], "On.1990.1080p")).toBeNull();
    expect(matches([movie("On (2017)")], "On.Track.2014.1080p")).toBeNull();
    expect(matches([movie("Lamp (2015)")], "Lamp.1080p")).toBeNull();
    expect(matches([movie("The Lamp (2015)")], "The.Lamp.720p")).toBeNull();
    expect(matches([movie("The Lamp (2015)")], "The.Lamp.2015.720p")).toBe("The Lamp (2015)");
    expect(matches([movie("Q (1931)")], "Q.1931.1080p")).toBe("Q (1931)");
    expect(matches([{ itemName: "Lantern", isShow: null }], "Lantern.1995.1080p")).toBeNull();
    // A longer title with no year on either side has enough to go on.
    expect(matches([movie("Alpha Bravo (2020)")], "Alpha.Bravo.1080p")).toBe("Alpha Bravo (2020)");
    expect(matches([{ itemName: "Alpha Bravo", isShow: null }], "Alpha.Bravo.2020.1080p")).toBe("Alpha Bravo");
  });

  it("uses the season tag and section type to tell shows and movies apart", () => {
    expect(matches([show("Lost Signal (2004)")], "Lost.Signal.S01E02.1080p")).toBe("Lost Signal (2004)");
    expect(matches([show("Signal (2004)")], "Signal.S01.1080p.WEB-DL")).toBe("Signal (2004)");
    expect(matches([show("The Depot (2005)")], "The.Depot.US.S02E01.720p")).toBe("The Depot (2005)");
    expect(matches([show("Season Four")], "Season.Four.Season.2.1080p")).toBe("Season Four");
    expect(matches([show("We (2019)")], "We.S01E01.1080p")).toBeNull();
    expect(matches([show("Ox (2019)")], "Ox.S01E01.1080p")).toBeNull();
    // A season tag cannot be a movie, and a movie release can be a show of another year.
    expect(matches([movie("Signal (1996)")], "Signal.S01E01.1080p")).toBeNull();
    expect(matches([show("Signal (2014)")], "Signal.1996.1080p")).toBeNull();
    expect(matches([{ itemName: "Signal Fire", isShow: null }], "Signal.Fire.S01E01")).toBe("Signal Fire");
  });

  it("keeps words that look like release tags when they belong to the title", () => {
    expect(matches([movie("Harriet's Web (2006)")], "Harriets.Web.2006.1080p")).toBe("Harriet's Web (2006)");
    expect(matches([movie("Harriet's Web (2006)")], "Harriets.Web.1080p")).toBe("Harriet's Web (2006)");
    expect(matches([movie("Extended Family Stories (2023)")], "Extended.Family.Stories.2023.1080p")).toBe("Extended Family Stories (2023)");
    expect(matches([movie("Alpha Bravo (2020)")], "Alpha.Bravo.2020.Extended.Directors.Cut.1080p")).toBe("Alpha Bravo (2020)");
    expect(matches([movie("Alpha Bravo (2020)")], "Alpha.Bravo.WEB-DL.1080p")).toBe("Alpha Bravo (2020)");
    expect(matches([movie("Season Of Change (2001)")], "Season.Of.Change.2001.1080p")).toBe("Season Of Change (2001)");
  });

  it("finds nothing in an empty library or an empty name", () => {
    expect(matches([], "Alpha.Bravo.2020.1080p")).toBeNull();
    expect(matches([movie("Alpha Bravo (2020)")], "")).toBeNull();
  });

  it("stays fast with a large library", () => {
    const titles = Array.from({ length: 20_000 }, (_, index) => movie(`Generated Title ${index} (2001)`));
    const index = buildTitleIndex(titles, now);
    const started = performance.now();
    for (let release = 0; release < 20_000; release += 1) matchReleaseTitle(index, `Generated.Title.${release}.2001.1080p.WEB-DL.x264-GRP`, now);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("release folders", () => {
  it("uses the folder a file arrived in, above any season or disc folders", () => {
    expect(releaseKeyOf("Pack.S01.1080p/Pack.S01E01.mkv")).toBe("Pack.S01.1080p");
    expect(releaseKeyOf("Show (2019)/Season 01/file.mkv")).toBe("Show (2019)");
    expect(releaseKeyOf("Show (2019)/S02/Disc 1/file.mkv")).toBe("Show (2019)");
    expect(releaseKeyOf("__all__/Some.Release/file.mkv")).toBe("__all__/Some.Release");
    expect(releaseKeyOf("__all__/Some.Release/Season.2/file.mkv")).toBe("__all__/Some.Release");
  });

  it("makes a file its own release when it has no folder of its own", () => {
    expect(releaseKeyOf("Lone.Release.2020.mkv")).toBe("Lone.Release.2020.mkv");
    expect(releaseKeyOf("__all__/Lone.Release.2020.mkv")).toBe("__all__/Lone.Release.2020.mkv");
    expect(releaseKeyOf("movies/Lone.Release.2020.mkv", new Set(["movies"]))).toBe("movies/Lone.Release.2020.mkv");
    expect(releaseKeyOf("Season 01/file.mkv")).toBe("Season 01");
  });

  it("names a release after its folder, or its file without the extension", () => {
    expect(releaseNameOf("__all__/Some.Release", "__all__/Some.Release/file.mkv")).toBe("Some.Release");
    expect(releaseNameOf("Lone.Release.2020.mkv", "Lone.Release.2020.mkv")).toBe("Lone.Release.2020");
    expect(releaseNameOf("Alpha.2020/Alpha", "Alpha.2020/Alpha/file.mkv")).toBe("Alpha");
  });
});
