// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { formatMessage, type MessageVariables } from "@generaltranslation/icu";

/** Pure display helpers accept GT's useMessages; English remains the default. */
export type UiMessage = (source: string, values?: MessageVariables) => string;
export const englishUiMessage: UiMessage = (source, values) => String(formatMessage(source, "en", values));
