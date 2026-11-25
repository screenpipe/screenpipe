// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { open } from "node:fs/promises";

const personal = Buffer.from("SP_APP_PACKAGE_EDITION_PERSONAL!");
const managed = Buffer.from("SP_APP_PACKAGE_EDITION_MANAGED!!");

export function enterpriseEditionOffset(executable: Buffer): number {
  if (!executable.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("Expected a Linux ELF executable");
  }
  const offset = executable.indexOf(personal);
  if (offset === -1 || executable.indexOf(personal, offset + personal.length) !== -1) {
    throw new Error("Expected exactly one consumer package identity in the linked executable");
  }
  return offset;
}

if (import.meta.main) {
  const [path] = Bun.argv.slice(2);
  if (!path) throw new Error("Usage: stamp-linux-release-edition.ts <executable>");
  const file = await open(path, "r+");
  try {
    const offset = enterpriseEditionOffset(await file.readFile());
    const { bytesWritten } = await file.write(managed, 0, managed.length, offset);
    if (bytesWritten !== managed.length) throw new Error("Could not write enterprise package identity");
  } finally {
    await file.close();
  }
}
