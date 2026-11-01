# 验收装置（证据附件）

这里存放需要被审计的验收装置源码，用来复现 `evidence/` 下对应的结论。它们不参与产品构建，只在验收机上单独编译/运行。

## macOS 物理键盘级中文输入法

对应证据：[`wp02-hybrid-mac-physical-ime.json`](../wp02-hybrid-mac-physical-ime.json)

| 文件 | 作用 |
| --- | --- |
| `mac-ime-keys.swift` | 按键注入器 `xjkeys`。用 `CGEventPost(.cghidEventTap, .hidSystemState)` 把按键投递到系统 HID tap，先经 WindowServer 与 TIS 选中的系统输入法，再进入浏览器。子命令：`check` / `type <text>` / `key <space\|return\|left\|right\|esc> [cmd]` / `paste`。 |
| `mac-physical-ime.mjs` | 验收编排。用 Playwright 打开真实产品页、建活动与作品，然后在每次注入前 `bringToFront` 并复核焦点，调用 `xjkeys` 完成四段真实组合、真实 `Cmd+V` 与 `Cmd+←/→`；页面侧只读观测，采集 `keydown` / `composition*` / `paste` 事件。 |

复现要点：

1. 注入器必须在系统设置 → 隐私与安全性 → 辅助功能中获得授权，否则 `CGEventPost` 会被静默丢弃（`xjkeys check` 返回 `untrusted`）。
2. 编译后不要随意重编译：ad-hoc 签名的二进制换了 cdhash 会重新触发授权。
3. 键盘事件只在目标浏览器为前台时生效；验收期间不要操作机器，否则按键会串到别的窗口。
4. 判据是组合期间 `keydown` 的 `keyCode` 为 229（`VK_PROCESSKEY`）且 `compositionupdate` 逐字母增长；`compositionend` 的 `isTrusted` 为 `false` 属正常，该事件由浏览器在提交时合成。
