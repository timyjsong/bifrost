import { describe, expect, test } from "bun:test";
import { parseAttachments } from "./attachments";

const P = "/home/you/bifrost/data/uploads/aaaa1111-abcd/bbbb2222-photo.jpeg";
const P2 = "/home/you/bifrost/data/uploads/aaaa1111-abcd/cccc3333-notes.txt";

describe("parseAttachments — split injected upload paths from the body", () => {
  test("leading upload paths become chips; the rest is the body", () => {
    const r = parseAttachments(`${P}\n${P2}\nhere is what I mean`);
    expect(r.attachments.map((a) => a.name)).toEqual(["photo.jpeg", "notes.txt"]);
    expect(r.attachments[0].path).toBe(P);
    expect(r.body).toBe("here is what I mean");
  });

  test("attachments with no body text", () => {
    const r = parseAttachments(`${P}`);
    expect(r.attachments).toHaveLength(1);
    expect(r.body).toBe("");
  });

  test("a plain message with no attachments passes through untouched", () => {
    const r = parseAttachments("just a normal question\nsecond line");
    expect(r.attachments).toHaveLength(0);
    expect(r.body).toBe("just a normal question\nsecond line");
  });

  test("only LEADING path lines count — a path mid-body stays in the body", () => {
    const r = parseAttachments(`${P}\nsee the file\n${P2}`);
    expect(r.attachments.map((a) => a.name)).toEqual(["photo.jpeg"]);
    expect(r.body).toBe(`see the file\n${P2}`);
  });

  test("a non-upload absolute path is NOT treated as an attachment", () => {
    const r = parseAttachments("/etc/hosts is the file");
    expect(r.attachments).toHaveLength(0);
    expect(r.body).toBe("/etc/hosts is the file");
  });

  test("the 8-hex server prefix is stripped for display, path kept intact", () => {
    const r = parseAttachments(P);
    expect(r.attachments[0].name).toBe("photo.jpeg");
    expect(r.attachments[0].path).toBe(P);
  });
});
