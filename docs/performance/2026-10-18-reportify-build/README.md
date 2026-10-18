# reportify-fe 本地构建测试（2026-10-18）

最新进展：Kestrel 已修复 BYOB 及随后暴露的 VM/环境识别问题，完整 `next build --webpack` 命令成功（516.427 秒），99/99 页面生成，生产启动健康检查通过。本次保留构建缓存、使用 6 GB 堆和 2 个页面工作进程；最初的三方测试条件不同且均未成功，不能计算加速比。

| 运行时 | 结果 | 结束前耗时 |
|---|---|---:|
| Node 25.6.1 | V8 JavaScript heap out of memory，SIGABRT | 247.580 秒 |
| Bun 1.3.11 | 内存压力过高，主动 SIGTERM 中止（非运行时自行失败、非超时） | 564.670 秒 |
| Kestrel | 模块初始化 TypeError，未进入编译 | 0.614 秒 |

Bun 的 macOS sample 显示 physical footprint 12.4G、peak 13.5G；主机总内存 16 GiB。该指标与 RSS 不同，不能混用比较。系统交换空间曾占用约 11 GB，性能数据受到严重内存压力影响。results.json 中采样 RSS 只表示驻留部分，不能代表完整内存需求。

Kestrel 错误定位：Next 16 的 next/dist/server/node-environment-extensions/unhandled-rejection.js:325 包装 process.prependOnceListener 时，该 API 缺失，随后第 118 行访问 original.name 抛错。没有修改运行时或绕过这个错误。

## 方法与限制

- 使用 reportify-fe 当前工作目录文件的独立副本；保留用户未提交修改，原目录未改动。
- Next 16.1.2，统一直接执行各运行时 + node_modules/next/dist/bin/next build --webpack，Bun 使用 --bun。
- 源锁文件与 package.json 不一致，npm ci 失败。仅在副本执行 npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund，安装 3653 个包；三者共用同一份依赖。安装和 Prisma generate 不计入构建耗时。未执行 prisma db pull。
- 仅在副本关闭 Qcloud 上传插件及 Sentry 包装，避免测试触发发布。
- 每次清空 .next；保留 OS 文件缓存。依次 Node、Bun、Kestrel，单独运行，失败后不重复。原计划最多三轮、每次 900 秒，但三个首轮均未完成。
- 没有成功 BUILD_ID，因此未执行计划的 /api/health 启动验证。
- 配置本身跳过 TypeScript 构建错误；Next 同时提示 eslint/publicRuntimeConfig/experimental.swcMinify 为不受支持的配置。
- 测试脚本、依赖副本、完整诊断保留于 /tmp/kestrel-reportify-build-20261018；含私有项目环境的副本不可发布。

原始测试后的修复进展见下文。当前数据不能证明 Kestrel 比 Bun 快。

## process 事件 API 修复复测

- process 现复用 EventEmitter，实现 prependOnceListener、rawListeners 及正确的 once/listeners/移除语义；IPC prepend 监听也启动消息读取。
- 新增两项差分回归，macOS 全量 36/36 通过；Next 16 next-build、build 和项目配置加载均通过。Linux 此次未重跑。
- 默认堆参数下，项目进入编译后 34.977 秒 V8 OOM（约 1.4 GB 堆上限），不再是模块初始化异常。
- 显式 KESTREL_V8_FLAGS=--max-old-space-size=6144 后，320.577 秒返回 Webpack 编译错误：缺少 @openuidev/react-headless。该包是 @openuidev/react-ui 的 peer dependency，测试副本的 legacy-peer-deps 安装未自动补入；Node require.resolve 也确认不存在。此结果不表示运行时模块解析缺陷。
- 修复测试日志与二进制哈希位于 process-events-fix/。堆参数和依赖修正仅用于兼容性验证，不作为与旧三方测试直接比较的性能成绩。

### Web Crypto 全局修复与当时的阻塞（现已修复）

补装 peer dependency 后的复测保留了 Webpack 缓存，使用 6 GB 堆参数。539.452 秒后在页面收集阶段失败，报告 CryptoKey 缺失；Webpack 已结束编译但仍有警告。该轮非冷构建，也不是有效的完整构建成绩。

随后补齐 Crypto、CryptoKey、SubtleCrypto 全局构造器与实例原型关系；构造器非法调用会抛错，既有加解密实现不变。新增差分用例验证全局身份、构造器保护和 AES-GCM 往返。直接运行 Next 的 EdgeRuntime，以及调用 Next isPageStatic 对现有编译产物中的 /admin/system-config/admin-users 重新收集页面数据，均已越过 CryptoKey 缺失点，但现在报告 ReadableStreamBYOBReader 缺失。

当时的 Web Streams 不支持 BYOB，未用占位类绕过检查；该轮未完成构建与启动验证。后续修复及验证见下文。原项目文件保持不变。

该阶段 macOS Node/Kestrel 差分门禁 **37/37 通过**，日志为 process-events-fix/compat-final.log。两次独立代码审查未发现本次引入的问题。

## BYOB、VM 与环境识别修复

- 接入固定版本 web-streams-polyfill 4.3.0，统一默认流与 BYOB 实现，保留 MIT 授权和完整性信息。验证 buffer transfer、部分读取、min、取消、锁释放、异常、tee、pipeTo 及背压。
- VM 沙箱包含不可枚举属性和 symbol，并保留属性标志、支持数字键；解决 EdgeRuntime 注入的 Crypto 等属性丢失。这不代表完整实现 Node vm。
- snapshot 恢复后隐藏内部局部 Deno 对象，避免 supports-color 错用 Deno.args。内建 HTTP、模块加载和 AOT 改用内部引用；AOT 使用独立模块作用域，避免用户 Symbol/globalThis 变量干扰。
- macOS 差分门禁 **42/42 通过**；额外 VM 模块和 N-API **2/2 通过**。AOT 数值用例与 V8-only 输出逐字相同，并确认五个函数实际进入 native 编译。此次未在 Linux 重跑。

### 实际项目验证

保留此前成功编译的 Webpack 产物，恢复其对应的 BUILD_ID（来自该产物中的静态 manifest），执行 `next build --webpack --experimental-build-mode generate`。测试副本使用 6 GB 堆上限、2 个页面工作进程及已补齐的 peer dependency。

结果：退出码 0；99/99 静态页面生成；`next start` 启动后 `/api/health` 返回 `{"code":0,"message":"success"}`。后续生成阶段耗时 14.323 秒，采样进程组峰值 RSS 1817.64 MiB。**这些数值不是完整构建耗时，也不能与旧 Node/Bun 失败数据比较。**

构建仍有项目配置弃用、图表尺寸，以及本地系统配置接口未启动的非致命警告。健康检查只验证启动与指定接口，不等同于覆盖所有业务页面。原 reportify-fe 工作目录未修改。证据见 `byob-fix/`。

### 修复前后 HTTP 性能抽查

同一台 macOS 主机、同一负载，修复前/后交替各三轮，单 worker、wrk 两线程 64 连接、每轮预热 1 秒测量 3 秒。此处只衡量本次修复对已有 HTTP 快路径的影响，未与 Node/Bun 重赛。

| 用例 | 修复前中位数 req/s | 修复后中位数 req/s | 变化 |
|---|---:|---:|---:|
| 原生 HTTP | 337,078 | 337,223 | +0.04% |
| node:http | 254,701 | 251,496 | -1.26% |

三轮短测无法排除主机噪声或小幅回退；原生 HTTP 基本持平，node:http 本次略低。不据此宣称绝无性能损失。该测试未测量新增 BYOB 实现自身的吞吐性能。原始各轮及 RSS 数据见 `byob-fix/http-performance.json`。

### 完整 Webpack 命令最终复测

随后使用最终二进制重新执行 `kestrel node_modules/next/dist/bin/next build --webpack`，包含 Webpack 编译、页面收集、静态生成、优化与追踪收集，**没有使用 generate-only 模式**。保留既有 `.next` 缓存，仍使用 6 GB 堆、2 个页面工作进程以及测试副本的依赖与配置修正。

- 构建退出码 **0**，耗时 **516.427 秒**，99/99 静态页面生成成功。
- 采样进程组峰值 RSS **4796.89 MiB**；`/usr/bin/time -l` 记录主进程峰值 physical footprint **9,503,531,568 字节**。指标不同，不可混用；本机存在显著内存压力。
- 使用相同 Kestrel 执行 `next start`，随后 `/api/health` 返回预期成功 JSON。
- 此结果证明本次修复后完整命令可通过；缓存、堆上限与依赖条件不等同于原三方测试，不能据此宣称快于 Bun 或 Node。

原始构建、启动日志及结构化结果分别为 `byob-fix/full-build.log`、`full-build-serve.log`、`full-build-result.json`。
