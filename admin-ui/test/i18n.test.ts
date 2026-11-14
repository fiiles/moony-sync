import { describe, expect, it } from "vitest";
import { cs } from "../src/i18n/cs";
import { en } from "../src/i18n/en";
import { translate } from "../src/i18n";

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("dictionaries", () => {
  it("cs and en have exactly the same keys", () => {
    expect(Object.keys(cs).sort()).toEqual(Object.keys(en).sort());
  });

  it("every key has the same placeholders in both languages", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect([key, placeholders(cs[key])]).toEqual([key, placeholders(en[key])]);
    }
  });

  it("no text is empty and none says 'relay'", () => {
    for (const dict of [cs, en]) {
      for (const [key, text] of Object.entries(dict)) {
        expect([key, text.trim().length > 0]).toEqual([key, true]);
        expect([key, /relay/i.test(text)]).toEqual([key, false]);
      }
    }
  });

  it("Czech uses 'synchronizační server' and English 'sync server'", () => {
    expect(cs["brand.subtitle"]).toBe("Synchronizační server");
    expect(en["brand.subtitle"]).toBe("Sync server");
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(translate("en", "block.title", { name: "Anna" })).toBe("Block Anna?");
    expect(translate("cs", "block.title", { name: "Anně" })).toContain("Anně");
  });
});
