# 表格聚合（示例执行组件）

学生可编辑的表格 + 一个受限 WebAssembly 算法。算法只拿到宿主线性内存里的一段 f64 数据，
不含网络、存储、时钟或随机数能力；分组、校验与结果保存都在宿主（受信 Worker 包装）完成。

## 组成

| 文件 | 作用 | 是否随组件发布 |
| --- | --- | --- |
| `view.html` | 隔离视图：编辑表格、选分组列/数值列/计算方式、发起计算并显示结果 | 是（入口资源） |
| `algorithm.wat` | 算法源码，只导入 `env.memory` | 否（便于核对） |
| `algorithm.wasm` | 由 `algorithm.wat` 编译出的模块（摘要与清单一致） | 是（算法资源） |
| `package.mjs` | 生成 `dist/table-aggregation/component.json`（含两个资源的 base64 与摘要） | 否 |
| `build.mjs` | 用锁定版本 `wabt@1.0.36` 重新编译，并在 `--check` 下核对已提交的 wasm | 否 |

## 算法规则

`aggregate(ptr, count, mode) -> f64`：读取 `ptr` 起的 `count` 个小端 f64，按 `mode` 返回一个数。

- `mode` 0 计数、1 求和、2 平均、3 最小、4 最大；`count <= 0` 或 `mode > 4` 返回 `NaN`。
- 宿主把 `NaN` 视为真实失败（`algorithm-error`），不会补一个数字。
- 导出的 `abiVersion` 全局变量必须是 1，否则宿主拒绝运行。
- 内存由宿主创建并可写上限：默认 256 页 = 16 MiB，模块无法增长超过这个值。

宿主侧的边界与拒绝理由：

- 任何除 `env.memory` 之外的导入（函数、表、全局）都会在实例化前被拒绝。
- 数值列出现空值或非有限数字时，在计算前停止并按行号报告（第几行），不会静默当 0。
- 分组数上限 200、列数上限 12、行数上限 1000（组件状态声明）／2000（宿主上限）。
- 单次 5 s 计算时限、1 MiB 输入、64 KiB 结果输出；超出即为真实失败，不截断结果。

## 打包与导入

```sh
node components/table-aggregation/build.mjs --check   # 源码与已提交 wasm 是否一致
node components/table-aggregation/package.mjs         # 生成 dist/table-aggregation/component.json
node apps/local-runtime/dist/cli.js component-import --root <产品私有目录> --file dist/table-aggregation/component.json
```

`component.json` 用 `path` 指向同目录的 `view.html` 与 `algorithm.wasm`；CLI 只在该目录内读取，
接口再用清单里的 `sha256`/`byteLength` 校验一次。首次登记使用文件里的固定 `requestId`；
改版必须同时改 `version`、两个资源的身份与登记 `requestId`，同一版本不允许热替换。

算法资源只能通过授权发布读取（`releases/<releaseId>/components/<key>/algorithm`），
沙箱视图的 CSP 里 `connect-src 'none'`，视图拿不到算法字节，也无法联网。

## 结果去哪了

计算在宿主页面的专用 Worker 中执行；结果先在本机 IndexedDB 校验可读，再发布引用。
工作区的「计算记录」显示参数、该次输入的统计与 CSV 下载；CSV 只在发起计算的浏览器上可下载，
其他浏览器会如实报告"本机没有该运行的结果文件"，不会重算。
