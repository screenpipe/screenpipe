# Context fill navigation

Real shared Workflows UI, using fictional notes and a delayed fixture adapter in the maintained web preview. No customer logs, names, or recordings are included.

- `before.png`: baseline `68d02ba05`, after starting Fill context, opening Home before the first result, waiting for completion, and returning to Context. The notes and results are lost.
- `after.png`: the same sequence and 1280 × 1000 viewport after the fix. Both proposed fields are saved and the pasted draft remains.
- `loading.png`: the initial in-progress state with Stop available.

The temporary preview route was removed before commit. Browser checks establish the shared UI lifecycle, not real model output or installed Windows-app recovery. The field adapter in this preview returns fictional results after a fixed delay.
