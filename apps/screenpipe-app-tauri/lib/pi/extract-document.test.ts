// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { extractDocument, docToPromptText } from "./extract-document";

describe("spreadsheet chat attachments", () => {
  it.each(["xlsx", "xls"] as const)("extracts every populated sheet from a real %s workbook", async (extension) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["Customer", "Amount"],
      ["Café 東京", 42.5],
    ]), "Invoices");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), "Empty");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["Status"], ["Approved"],
    ]), "Notes");
    const bytes = new Uint8Array(XLSX.write(workbook, {
      type: "array", bookType: extension === "xls" ? "biff8" : "xlsx",
    }));

    const document = await extractDocument(`invoice.${extension}`, bytes);

    expect(document.text).toBe("# sheet: Invoices\nCustomer,Amount\nCafé 東京,42.5\n\n# sheet: Notes\nStatus\nApproved");
    expect(document.truncated).toBe(false);
    expect(document.charCount).toBe(document.text.length);
    expect(docToPromptText(document)).toContain(document.text);
  });

  it("preserves the useful error for an invalid XLSX attachment", async () => {
    await expect(extractDocument("broken.xlsx", new TextEncoder().encode("not a workbook")))
      .rejects.toThrow("could not read broken.xlsx: not a valid .xlsx");
  });
});
