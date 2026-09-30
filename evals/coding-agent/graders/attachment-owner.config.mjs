// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {defineConfig} from 'vitest/config';
import path from 'node:path';
export default defineConfig({esbuild:{jsx:'automatic'},test:{environment:'jsdom',include:['components/chat/standalone/hooks/eval-attachment-owner.test.tsx'],pool:'forks',poolOptions:{forks:{singleFork:true}}},resolve:{alias:{'@':path.resolve('.'),'gt-react':path.resolve('eval-attachment-locale.ts')}},css:{postcss:{plugins:[]}}});
