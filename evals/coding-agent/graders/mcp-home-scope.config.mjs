// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {defineConfig} from "vitest/config";
import path from "node:path";
export default defineConfig({test:{environment:"node",globals:true,pool:"forks",poolOptions:{forks:{singleFork:true}}},resolve:{alias:{"@":path.resolve(process.cwd())}}});
