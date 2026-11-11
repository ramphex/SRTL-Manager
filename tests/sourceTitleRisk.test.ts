import { describe, expect, it } from "vitest";
import { evaluateSourceTitleRisk } from "../src/shared/sourceTitleRisk";

describe("source title risk", () => {
  it("blocks a source file that does not match the expected title", () => {
    const risk = evaluateSourceTitleRisk({
      expectedTitle: "Harbor Lights and Thunder (1976)",
      sourcePath: "/mnt/remote/storage/[1+7] - Wreck.1976.UNCUT.1080p/[1+7] - Wreck.1976.UNCUT.1080p.mkv"
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
      expectedTitle: "Nightfall Uprising (2006)",
      sourcePath: "/mnt/remote/storage/Nightfall.Uprising.2006.1080p.WEB-DL/Nightfall.Uprising.2006.1080p.WEB-DL.mkv"
    });

    expect(risk.severity).toBe("ok");
    expect(risk.matchedTokens).toEqual(["nightfall", "uprising"]);
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
      expectedTitle: "The Lattice (1999)",
      sourcePath: "/mnt/remote/Lattice.1999.1080p.BluRay/Lattice.1999.1080p.BluRay.mkv"
    });

    expect(risk.severity).toBe("ok");
  });

  it("handles initials in expected titles", () => {
    const risk = evaluateSourceTitleRisk({
      expectedTitle: "Morgan J.T. Unfiltered",
      sourcePath: "/mnt/remote/Morgan.JT.Unfiltered.2008/Morgan.JT.Unfiltered.2008.mkv"
    });

    expect(risk.severity).toBe("ok");
  });

  it("handles stylized dollar signs as s inside title words", () => {
    const risk = evaluateSourceTitleRisk({
      expectedTitle: "Rain Wont Wa$h a Sin (2003)",
      sourcePath: "/mnt/remote/storage/Rain.Wont.Wash.a.Sin.2003.1080p/Rain.Wont.Wash.a.Sin.2003.1080p.mkv"
    });

    expect(risk.severity).toBe("ok");
    expect(risk.matchedTokens).toEqual(["rain", "wont", "wash", "sin"]);
  });
});
