# shadcn/ui

`src/settings/SettingsEmptyState.tsx` adapts the Empty composition from
https://ui.shadcn.com/docs/components/empty, inspected using `shadcn view @shadcn/empty`.
Utility classes are replaced with XunJie tokens and scoped CSS; content and actions are supplied by the caller.

`src/feedback/index.tsx` adapts the Sonner wrapper from
https://ui.shadcn.com/docs/components/radix/sonner, inspected using
`shadcn view @shadcn/sonner`. It uses the project's icons and theme tokens
instead of Next.js theme integration and Tailwind. Sonner's MIT license is
distributed with the dependency.

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# Model selectors and provider marks

`src/settings/SettingsSelect.tsx` composes Base UI Select and Combobox
(`@base-ui/react@1.9.0`) using the form and searchable-list patterns reviewed in
shadcn/ui and Astryx Selector/Typeahead. All styling uses XunJie tokens.
Base UI is MIT licensed, Copyright (c) 2019 Material-UI SAS; its license is
distributed with the dependency. Component documentation:
https://base-ui.com/react/components/select and
https://base-ui.com/react/components/combobox.

The DeepSeek, Kimi, OpenCode, Command Code and Zhipu SVG files in
`src/assets/providers/` are unmodified assets from
`@lobehub/icons-static-svg@1.102.0` (https://github.com/lobehub/lobe-icons).
MiMo uses the existing project asset. Brand names and marks retain their
respective ownership.

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# GitHub Octicons

`src/icons/svg/brand-github-native.svg` is the unmodified `mark-github-16.svg`
from GitHub Octicons:
https://github.com/primer/octicons/blob/68ec2de8d0ddfcbb7497da01d0b7d98eb5593020/icons/mark-github-16.svg.
GitHub names and marks remain subject to the GitHub logo guidelines:
https://brand.github.com/foundations/logo.

MIT License

Copyright (c) 2026 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# Astryx

`src/settings/ModelTestFeedback.tsx` wraps the installed Astryx `Banner` for
persistent test failures and partial results. XunJie tokens, typography and
scoped CSS adapt its presentation; status, actions and diagnostic text are
provided by the caller. Astryx's license is distributed with the dependency.

`src/foundation/DestructiveButton.tsx` wraps Astryx `Button` from
`@astryxdesign/core@0.7.12`; its colors, sizing and focus follow XunJie tokens.

`src/foundation/useSidebarResize.tsx` and `src/foundation/sidebar-resize.css`
adapt the pill grip, pointer capture, cancellation and keyboard interactions from
Astryx `ResizeHandle.tsx` and `resizeGesture.ts`, inspected from the published
`@astryxdesign/core@0.7.11` npm source. The adaptation uses XunJie tokens,
the existing 60px navigation rail and responsive bounds.

Component documentation: https://astryx.atmeta.com/components/ResizeHandle

MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
