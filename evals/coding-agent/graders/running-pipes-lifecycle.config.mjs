// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({esbuild:{jsx:'automatic'},resolve:{alias:{'@':path.resolve('.')}},test:{include:['eval-running-pipes.test.tsx'],environment:'jsdom',pool:'forks',poolOptions:{forks:{singleFork:true}}},css:{postcss:{plugins:[]}}});
