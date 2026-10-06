# Borderless block editing

Real shared Workflows components in the maintained `/preview` browser route, using fictional fixture data. These are browser previews, not captures of an installed desktop build.

- Before: base `a979c5cfe`, focused first instruction in Research synthesis.
- After: the same fixture, viewport (1280 × 720), scroll position and focus. The focused block's dimensions and text position are unchanged.
- Additional states: existing block menu, SOP insert menu, and a newly inserted text block being edited.

Verified by interacting with the rendered components: native editing, autosave and reopening, keyboard block reorder and undo, title and rich-text focus, adding a text block, and visible keyboard focus on the block type selector. The caret indicates text focus; action controls retain their existing focus outlines.
