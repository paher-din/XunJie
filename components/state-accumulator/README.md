# 四态累加模拟（示例有状态会话组件）

学生从固定初态 0 开始，每次输入一个整数，状态按 `state = (state + input) mod 4` 推进。
例如依次输入 1、2、2，观察到的状态是 1、3、1；另一个会话的相同输入从 0 独立开始。

状态由产品内置的 `four-state-accumulator@1` 原生适配器持有，运行在独立子进程中；组件视图只描述规则，
「本机会话」面板负责启动、连续输入、核对与停止。界面变量和预制结果都不参与观察。

## 组成

| 文件 | 作用 | 是否随组件发布 |
| --- | --- | --- |
| `view.html` | 隔离视图：说明规则与观察方式 | 是（入口资源） |
| `package.mjs` | 生成 `dist/state-accumulator/component.json` | 否 |

组件清单只声明适配器标识、输入/观察结构和预算，不携带命令、路径或运行环境。适配器版本由产品固定，
清单版本与发布绑定；同一版本不能热替换视图字节。

## 打包与导入

```sh
node components/state-accumulator/package.mjs
node apps/local-runtime/dist/cli.js component-import --root <产品私有目录> --file dist/state-accumulator/component.json
XUNJIE_PRODUCT_POSTGRES_BIN=<产品自带 PostgreSQL bin> node --test apps/server/tests/native-session.runtime.test.mjs
```

## 预算与限制

单次输入等待 5 s；空闲 10 分钟或最长 1 小时结束会话；子进程内存上限 64 MiB；单次输入 1 KiB、观察输出 64 KiB；
同时最多 2 个本机会话，不排队。输入必须是 0 到 99 的整数，超出范围由适配器拒绝，不推进状态。
