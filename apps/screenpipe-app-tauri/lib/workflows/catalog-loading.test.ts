// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { describe, expect, it } from "vitest";
import { isCatalogConnectionError, catalogRetryDelay } from "../../../../packages/workflows-ui/src/catalog-loading";
describe("workflow connection failures", () => {
  it.each([new TypeError("Load failed"), new TypeError("Failed to fetch"), new DOMException("timeout", "TimeoutError"), {status:503,message:"Unavailable"}, {status:502}])("retries transport failures: %s", error => {
    expect(isCatalogConnectionError(error)).toBe(true);
  });
  it.each([{status:403,message:"Forbidden"}, {status:401}, {status:503,message:"workflow_catalog_unreadable"}, {status:503,message:"workflow_catalog_not_configured"}, new SyntaxError("Invalid JSON"), new Error("Invalid schema")])("does not disguise persistent errors as startup: %s", error => {
    expect(isCatalogConnectionError(error)).toBe(false);
  });
  it("caps backoff to avoid busy polling", () => {
    expect([0,1,2,3,4,10,10000].map(catalogRetryDelay)).toEqual([1000,2000,4000,8000,10000,10000,10000]);
  });
});
