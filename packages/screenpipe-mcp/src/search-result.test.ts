// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, it } from "vitest";
import { formatSearchHit, searchContentCap, searchResultHeader } from "./search-result";
it("preserves real references through truncation, without inventing missing IDs", () => {
  const hit = formatSearchHit({type:"OCR",content:{frame_id:72,text:"HEAD"+"x".repeat(3000)+"TAIL",text_source:"accessibility"}},10)!;
  expect(hit.truncated).toBe(true); expect(hit.text).toContain("frame_id=72"); expect(hit.text).toContain("screenpipe://frame/72");
  expect(hit.text).toContain("HEAD"); expect(hit.text).toContain("TAIL"); expect(hit.text.length).toBeLessThan(250);
  expect(formatSearchHit({type:"OCR",content:{text:"no source"}},100)!.text).not.toContain("Source:");
});
it("keeps audio references and input text, including explicit unlimited reads", () => {
  expect(formatSearchHit({type:"Audio",content:{chunk_id:31,timestamp:"2026-10-01T00:00:00Z",transcription:"speech"}},100)!.text).toContain("chunk_id=31");
  const input={type:"Input",content:{frame_id:72,text_content:"long input"}};
  expect(formatSearchHit(input,3)!.truncated).toBe(true);
  expect(formatSearchHit(input,0)!.text).toContain("long input"); expect(formatSearchHit(input,0)!.truncated).toBe(false);
});
it("only suggests an offset when a next page exists", () => {
  expect(searchResultHeader(5,{total:10,offset:5})).not.toContain("offset=");
  expect(searchResultHeader(5,{total:10,offset:0})).toContain("offset=5");
  expect(searchResultHeader(0,{total:10,offset:0})).not.toContain("offset=");
  expect(searchContentCap(undefined)).toBe(1000); expect(searchContentCap(-1)).toBe(1000);
});
