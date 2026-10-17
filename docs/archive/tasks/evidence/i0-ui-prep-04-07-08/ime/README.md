# UI-PREP-04 真实系统中文输入法证据

日期：2026-10-15（Asia/Shanghai）；固定源：PR75 merge `37b628b75ec3a2238b9b77c8bd1882d36a2e55a6`。范围与授权见[本轮任务](../../../I0-UI_PREP_04_07_08_CLOSEOUT.md)。在独立Windows Chrome、原`dev:prep`及两个合成文件中执行，不连接真实学生、PAHER、执行节点或模型。

## 1. 操作来源与判据

Robert按本轮问题明确回复“完成”：系统中文输入法候选确认“中文”、键入`ceshi`并以Esc取消、Ctrl+F用输入法确认“中文”、第二文件确认“测试”、切回原文件。Agent只准备ASCII种子、观察已有DOM事件和核对原文；人工组合阶段未运行insertText、CDP composition、dispatchEvent或自动键盘。

[完整只读事件与正文](native-ime-evidence.json)保存人工阶段220个事件。5个compositionstart、40个compositionupdate、41个beforeinput、41个input均`trusted=true`，也含原生`Process/keyCode=229/isComposing=true`及候选Space/Escape。5个compositionend为`trusted=false`，原值全部保留，其来源未确定；不能称所有事件都受信。真实输入结论结合人工操作、可信组合更新/输入与确切结果，不单靠compositionend或模型自报。

`isTrusted`表明事件由用户代理创建，不单独证明操作者是学生；本轮操作者是Robert进行合成开发验证。[DOM事件规范](https://dom.spec.whatwg.org/#dom-event-istrusted)和[UI Events组合输入定义](https://w3c.github.io/uievents/#events-compositionevents)仅说明事件语义，不是本次执行证明。系统IME具体产品名/版本没有独立识别，不补造名称；候选窗口没有截图。正文截图仅是输入后状态，真实操作主要由原事件、人工回执及独立草稿支撑。

## 2. 实际结果

| 项目 | 可核事实 |
| --- | --- |
| 主文件确认 | `main.c`由`// main seed \n`变成`// main seed 中文\n`；原fileId、LF和ASCII种子保留 |
| 候选取消 | “中文”确认后，`ceshi`出现组合更新；可信Process/Escape/229期间取消，最终input为deleteContentBackward且正文回`// main seed 中文\n`；没有落入“测试”或残余拼音 |
| 中文搜索 | Find字段的可信组合更新/输入完成“中文”，读取查找匹配`1 of 1`；关闭查找回原正文 |
| 跨文件 | `notes.c`独立原fileId，正文为`// notes seed测试\n`；切回main仍为“中文”，两份IndexedDB草稿逐原文匹配 |
| Undo/redo | 第一undo按实际历史组撤销了此前ASCII准备尾空格及中文，得到`// main seed\n`；notes不变。redo精确恢复`// main seed 中文\n`及原LF，没有把分组差异改写成丢字 |
| 刷新恢复 | 依次打开原main/notes、等待项目模型后，两份正文/身份/EOL与输入完成后严格一致，草稿仍已保护 |
| 零自动写 | 从ASCII准备结束到输入、取消、查找、切文件、undo/redo及刷新核对后，业务写请求为0；没有sync/snapshot/run/help或自动新Attempt。刷新合成入口的1次Session建立另列，不混计业务写 |

[主文件输入后](main-search.png)、[第二文件输入后](notes-composed.png)、[刷新恢复](restored-main.png)只含合成公开内容。`main-search.png`中的正文保留查找高亮，不能据该截图宣称候选窗口或完整查找控件被拍到。

## 3. 保留的失败与复现入口

系统窗口自动化首次观察被Computer Use工具中止，原因是无法可靠识别Windows浏览器URL以执行策略校验；没有绕过。随后由Robert实际操作，Agent以正常浏览器接口观察。

刷新首次核对只等了工作区和保护提示，Monaco尚未挂原项目模型，读到临时`inmemory://model/1`空模型而断言失败。原两份IndexedDB草稿当时已完整；随后等待实际项目模型，依次打开原文件后严格比正文/身份/EOL通过。失败和原观察留完整JSON；没有改源码、恢复正文或重新执行人工输入来消除失败。

本轮浏览器使用与[可复用只读辅助](../../../../../apps/student/tools/native-ime-observer.mjs)同构的内联观察函数。辅助可在新独立Chrome context通过`context.addInitScript(installNativeImeObserver)`载入；只记录`.cw`已有事件，不创建界面、派发事件或调用业务API。正常启动命令仍是`npm run dev:prep`，每轮新scenario/独立profile，先记ASCII原文和业务请求基线，再让人工用实际系统IME操作并保存事件、原文和本机草稿。生产源码/依赖/契约未因本项改变；没有把文本输入测试或本轮开发操作计成真人学习/完整AC/NFR验收。
