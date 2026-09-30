// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({esbuild:{jsx:'automatic'},resolve:{alias:{'@':resolve(process.cwd())}},css:{postcss:{plugins:[]}},
 test:{environment:'jsdom',include:['meeting-handoff.eval.test.tsx'],pool:'forks',poolOptions:{forks:{singleFork:true}}}});
