import { describe, it, expect } from "vitest";
import { parseReferenceString } from "../utils/reference";

describe("parseReferenceString", () => {
  it("parse Jean 3:16", () => {
    expect(parseReferenceString("Jean 3:16")).toEqual({
      book: "Jean",
      chapter: 3,
      verse: 16,
    });
  });
});
