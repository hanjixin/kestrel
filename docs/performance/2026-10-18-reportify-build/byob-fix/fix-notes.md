# 修复范围与验证方法

- Web Streams 使用固定版本 web-streams-polyfill 4.3.0 的完整 ponyfill，保留上游 MIT 授权及包完整性记录。BYOB 与默认流共用实现，覆盖 buffer transfer、部分读取、min、取消、释放锁、异常、tee 与管道背压。
- VM sandbox 导入包含不可枚举属性和 symbol，保留属性标志，数字键转为字符串。此项不等于实现完整 Node vm context 语义。
- 不再公开 deno_core 的局部 Deno 对象，避免 supports-color 等库误判运行环境。Deno 在 snapshot 恢复后、用户代码前删除；内建模块保留私有 ops 引用。AOT 通过独立虚拟模块取得调用入口，避免用户的 Symbol/globalThis 绑定干扰。
- reportify-fe 使用先前已完成 Webpack 编译的产物，执行 Next --experimental-build-mode generate 完成后续阶段。这是兼容性验证，不是冷构建或三方性能对比。
- 测试副本禁用上传插件及 Sentry 包装，补装缺失 peer dependency，堆上限 6 GB，页面工作进程 2 个。原项目保持不变。

最终另跑完整 `next build --webpack`，516.427 秒退出 0，99/99 页面及启动健康检查成功。此轮保留缓存，不是冷构建基准。见 full-build-result.json。
