// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {defineConfig} from 'vitest/config';import {fileURLToPath} from 'node:url';export default defineConfig({resolve:{alias:{'@':fileURLToPath(new URL('.',import.meta.url)),'gt-react':fileURLToPath(new URL('./eval-notification-localization.ts',import.meta.url))}},test:{environment:'node',include:['eval-notification-transport.test.ts'],pool:'forks',poolOptions:{forks:{singleFork:true}}}});
