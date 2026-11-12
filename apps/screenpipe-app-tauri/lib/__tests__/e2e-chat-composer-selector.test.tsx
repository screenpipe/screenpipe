// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React, { createRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerInputBox } from "../../components/chat/standalone/composer-input-box";
import type { ComposerInputProps, ComposerMentionsProps } from "../../components/chat/standalone/composer-types";
import { CHAT_COMPOSER_SELECTOR } from "../../e2e/helpers/test-utils";

afterEach(cleanup);

it.each([undefined, "Message will be queued..."])("finds the actual primary composer while its placeholder is %s", placeholder => {
  const input = {
    value: "unsent private draft", placeholder, inputRef: createRef(), chipPrefixRef: createRef(),
    connectionChip: null, chipPrefixWidth: 0, chipScrollTop: 0,
    disabledReason: null, canChat: true, onChange: vi.fn(), onKeyDown: vi.fn(),
  } as unknown as ComposerInputProps;
  const mentions = {
    show: false, suggestions: [], dropdownRef: createRef(), selectedIndex: 0,
    onInsertMention: vi.fn(), isLoadingSpeakers: false, isLoadingTagSearch: false,
  } as unknown as ComposerMentionsProps;
  const { container } = render(<><textarea aria-label="Unrelated editor" /><ComposerInputBox input={input} mentions={mentions} /></>);
  const matches = container.querySelectorAll<HTMLTextAreaElement>(CHAT_COMPOSER_SELECTOR);
  expect(matches).toHaveLength(1);
  expect(matches[0].value).toBe("unsent private draft");
});
