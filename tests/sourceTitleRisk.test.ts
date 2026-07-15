import { describe, expect, it } from "vitest";
import { evaluateSourceTitleRisk } from "../src/shared/sourceTitleRisk";

describe("source title risk", () => {
  it("blocks a source file that does not match the expected title", () => {
    const risk = evaluateSourceTitleRisk({
      expectedTitle: "Mother Jugs and Speed (1976)",
      sourcePath: "/mnt/remote/__all__/[1+7] - Crash.1976.UNCUT.1080p/[1+7] - Crash.1976.UNCUT.1080p.mkv"
    });

    expect(risk).toMatchObject({
      severity: "block",
      matchedTokens: [],
      expectedYear: "1976",
      yearMatched: true
    });
  });

  it("allows dotted release names that match the expected title", () => {
    const risk = evaluateSourceTitleRisk({
      expectedTitle: "Underworld Evolution (2006)",
      sourcePath: "/mnt/remote/__all__/Underworld.Evolution.2006.1080p.WEB-DL/Underworld.Evolution.2006.1080p.WEB-DL.mkv"
    });

    expect(risk.severity).toBe("ok");
    expect(risk.matchedTokens).toEqual(["underworld", "evolution"]);
  });

  it("uses nearby parent folders when the file name is episode-only", () => {
    const risk = evaluateSourceTitleRisk({
      expectedTitle: "Sample Series (2024)",
      sourcePath: "/mnt/remote/series/Sample Series (2024)/Season 01/S01E01.mkv"
    });

    expect(risk.severity).toBe("ok");
  });

  it("does not fail titles that only differ by common stopwords", () => {
    const risk = evaluateSourceTitleRisk({
      expectedTitle: "The Matrix (1999)",
      sourcePath: "/mnt/remote/Matrix.1999.1080p.BluRay/Matrix.1999.1080p.BluRay.mkv"
    });

    expect(risk.severity).toBe("ok");
  });

  it("handles initials in expected titles", () => {
    const risk = evaluateSourceTitleRisk({
      expectedTitle: "Louis C.K. Ridiculous",
      sourcePath: "/mnt/remote/Louis.CK.Ridiculous.2008/Louis.CK.Ridiculous.2008.mkv"
    });

    expect(risk.severity).toBe("ok");
  });

  it("handles stylized dollar signs as s inside title words", () => {
    const risk = evaluateSourceTitleRisk({
      expectedTitle: "Love Dont Co$t a Thing (2003)",
      sourcePath: "/mnt/remote/__all__/Love.Dont.Cost.a.Thing.2003.1080p/Love.Dont.Cost.a.Thing.2003.1080p.mkv"
    });

    expect(risk.severity).toBe("ok");
    expect(risk.matchedTokens).toEqual(["love", "dont", "cost", "thing"]);
  });
});
