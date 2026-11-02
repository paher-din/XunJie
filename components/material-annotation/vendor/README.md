# 锁定浏览器依赖：mark.js

材料标注组件版本 2 的原文高亮依赖。这里的字节是组件清单 `dependencies[0]` 声明的不可变资源，
导入和准备时都按 SHA-256 与字节长度核对；不通过 CDN、npm 安装或运行时下载取得。

| 项 | 值 |
| --- | --- |
| 包 | `mark.js` |
| 版本 | `8.11.1` |
| 许可证 | MIT（见 [LICENSE-mark.js](LICENSE-mark.js)） |
| 发行文件 | `dist/mark.min.js`（无 jQuery 依赖的独立浏览器 UMD 构建，全局 `window.Mark`） |
| 文件字节数 | 16917 |
| 文件 SHA-256 | `21d62e1053f7589fe6365cccd7c636d1781abf7879a605d8ce5f1f5b81a7b8fa` |
| 上游 tarball SHA-256 | `694fa154d0f0e63fbc55cfd33e414bd7e4b21239cdf56b4e6b80f2ccc1f86994` |
| 上游主页 | <https://markjs.io/> |

## 复现取得方式

```sh
curl -sSL -o mark.js.tgz https://registry.npmjs.org/mark.js/-/mark.js-8.11.1.tgz
sha256sum mark.js.tgz                       # 核对上表 tarball 摘要
tar -xzf mark.js.tgz package/dist/mark.min.js package/LICENSE
cp package/dist/mark.min.js mark.min.js
cp package/LICENSE LICENSE-mark.js
sha256sum mark.min.js                       # 核对上表文件摘要
```

`npm view mark.js@8.11.1 license version` 返回 `MIT` / `8.11.1`，与上表一致。

## 更新规则

换版本必须同时改组件版本、`resourceId`、清单摘要与课程发布，不在同一组件版本内热替换字节。
更新后重跑独立自检，确认 `loads-highlight-library` 检查项报告的全局名与 `expect.globalName` 一致。
